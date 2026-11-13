/* Régie LED — application de bureau (Electron).
 * Au lancement : démarre le serveur local de serve.js sur un port libre, ouvre la régie dans une fenêtre, et quand la régie
 * appelle window.open('output.html'), ouvre la sortie en plein écran sur l'écran LED (premier écran externe, ou celui choisi
 * dans le menu Sortie). Les shows et les médias de l'application installée vivent dans « Documents/Régie LED ». */
import { app, BrowserWindow, screen, session, desktopCapturer, shell, ipcMain, Menu, dialog, nativeImage, Notification, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { startServer } from '../serve.js';
import { buildMenu } from './menu.js';
import { setupUpdater } from './updater.js';
import { bugReportUrl } from './bugreport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = app.getAppPath();
const packaged = app.isPackaged;
export const REPO_URL = 'https://github.com/bennanimehdi/regie-led';
const RELEASES_URL = REPO_URL + '/releases';
// Les scripts osascript ont besoin de vrais fichiers : ils sont sortis de l'archive app.asar (asarUnpack).
const toolsDir = path.join(packaged ? appRoot.replace(/app\.asar$/, 'app.asar.unpacked') : appRoot, 'tools');
const preload = path.join(here, 'preload.cjs');
const icon = nativeImage.createFromPath(path.join(appRoot, 'build', 'icon.png'));

app.setName('Régie LED');
app.setAppUserModelId('ma.bennanievents.regieled');
// Application de bureau : pas de « clic obligatoire » avant de jouer du son. La fenêtre de sortie ne reçoit jamais de clic, son
// contexte audio (vumètres) restait suspendu, avec des erreurs AudioContext dans le journal, et une vidéo pouvait démarrer muette.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.REGIE_LED_PROFILE) app.setPath('userData', process.env.REGIE_LED_PROFILE);   // essais : un 2e exemplaire à côté de l'application installée
if (!app.requestSingleInstanceLock()) app.quit();

// Journal : ~/Library/Logs/Régie LED/regie-led.log (Mac) ou %APPDATA%\Régie LED\logs\regie-led.log (Windows).
log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), 'regie-led.log');
log.transports.file.level = 'info';
log.transports.console.level = packaged ? false : 'info';
log.errorHandler.startCatching({ showDialog: false });
// Les messages du serveur local (serve.js, même processus) vont aussi dans le journal : fichier PowerPoint verrouillé, erreur
// complète d'une commande PowerPoint… Avant, ils ne sortaient que dans un terminal, invisible dans l'application installée.
Object.assign(console, log.functions);

/** Le dossier de données doit accepter l'écriture : sous Windows, « Documents » est souvent bloqué par la protection contre les
 *  ransomwares (accès contrôlé aux dossiers) ou redirigé vers OneDrive. On essaie Documents, puis le dossier personnel. */
function writableDir(dir) {
  try {
    for (const d of [dir, path.join(dir, 'data'), path.join(dir, 'media')]) fs.mkdirSync(d, { recursive: true });
    const probe = path.join(dir, 'media', '.test-ecriture-' + process.pid);
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
    return true;
  } catch (e) { log.warn(`Dossier non accessible en écriture : ${dir} (${e.code || e.message})`); return false; }
}
const preferredRoot = process.env.REGIE_LED_DIR || path.join(app.getPath('documents'), 'Régie LED');
const fallbackRoot = path.join(app.getPath('home'), 'Régie LED');
let userRoot = preferredRoot, rootMoved = false;
if (!process.env.REGIE_LED_DIR && !writableDir(preferredRoot) && writableDir(fallbackRoot)) { userRoot = fallbackRoot; rootMoved = true; }
const dataDir = path.join(userRoot, 'data'), mediaDir = path.join(userRoot, 'media');
const settingsFile = path.join(app.getPath('userData'), 'reglages-bureau.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* premier lancement */ }
const saveSettings = () => { try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch (e) { log.warn('Réglages non enregistrés : ' + e.message); } };

/* ---------- Mode d'affichage (menu Affichage) : sur certains PC Windows avec une télé en 2e écran, la sortie se fige alors que la
 * régie continue (le Lecteur multimédia, lui, est fluide). Ces variantes du moteur d'affichage de Chromium se choisissent dans le
 * menu et s'appliquent au redémarrage ; chacune est notée dans le journal. ---------- */
const GFX_MODES = {
  normal: { label: 'Normal (recommandé)', sw: [] },
  nodcomp: { label: 'Compatibilité A : sans composition directe', sw: [['disable-direct-composition']] },
  opengl: { label: 'Compatibilité B : moteur OpenGL', sw: [['use-angle', 'gl']] },
  novsync: { label: 'Compatibilité C : sans synchronisation verticale', sw: [['disable-gpu-vsync']] },
};
const gfxMode = GFX_MODES[settings.gfx] ? settings.gfx : 'normal';
for (const [k, v] of GFX_MODES[gfxMode].sw) v == null ? app.commandLine.appendSwitch(k) : app.commandLine.appendSwitch(k, v);
// Windows : décodage des vidéos par le processeur, sauf si l'utilisateur rallume celui de la carte graphique (menu Affichage).
// Constaté sur un Lenovo LOQ + télé Haier en 2e écran : avec le décodage par la carte graphique, la sortie se figeait plusieurs
// secondes sur la télé (la régie continuait, le Lecteur multimédia restait fluide) ; avec le décodage par le processeur, tout est fluide.
const hwDecode = () => (process.platform === 'win32' ? settings.hwDecode === true : true);
if (!hwDecode()) app.commandLine.appendSwitch('disable-accelerated-video-decode');
// Windows : Chromium arrête de dessiner une fenêtre qu'il croit cachée par d'autres ; sur un 2e écran, ce calcul peut se tromper
// et figer la sortie. La régie n'en a pas besoin : on le coupe.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
/** Plein écran de la sortie : 'fullscreen' (celui du système) ou 'borderless' (fenêtre sans bordure qui couvre l'écran, au premier plan). */
const outFsMode = () => (settings.outFs === 'borderless' && process.platform !== 'darwin' ? 'borderless' : 'fullscreen');   // Mac : son plein écran simple suffit (et macOS garde la barre des menus au-dessus d'une fenêtre)

let srv, regieWin = null, updater = null;
const outputs = new Map();                                  // id de sortie ('main', …) → BrowserWindow
const regieDisplay = () => (regieWin ? screen.getDisplayMatching(regieWin.getBounds()) : screen.getPrimaryDisplay());
const isFs = w => (w.borderless ? !!w.borderlessOn : w.isSimpleFullScreen() || w.isFullScreen());
function setFs(w, on) {
  if (!w.borderless) return process.platform === 'darwin' ? w.setSimpleFullScreen(on) : w.setFullScreen(on);
  // Fenêtre sans bordure : « plein écran » = elle couvre exactement son écran, au-dessus de tout (barre des tâches comprise).
  const d = screen.getDisplayMatching(w.getBounds()).bounds;
  w.borderlessOn = on;
  if (on) { w.setAlwaysOnTop(true, 'screen-saver'); w.setBounds(d); }
  else { w.setAlwaysOnTop(false); w.setBounds({ x: d.x + 80, y: d.y + 80, width: Math.min(1280, d.width - 160), height: Math.min(720, d.height - 160) }); }
}

/** Écran choisi pour chaque sortie (onglet Outputs, menu Sortie) : id d'écran, 'window' (fenêtre simple) ou absent (automatique). */
settings.outputDisplays ||= {};
if (settings.outputDisplay != null && settings.outputDisplays.main == null) settings.outputDisplays.main = settings.outputDisplay;   // ancien réglage unique
const displayChoice = outId => settings.outputDisplays[outId] ?? 'auto';
/** Écran où ouvrir une sortie : 'window' = fenêtre simple ; sinon l'écran choisi, ou (LED) le premier écran autre que la régie. */
function displayFor(outId, features) {
  const all = screen.getAllDisplays(), choice = displayChoice(outId);
  if (choice === 'window') return null;
  const chosen = all.find(d => d.id === choice);
  if (chosen) return chosen;
  if (outId === 'main') return all.find(d => d.id !== regieDisplay().id) || null;
  // Sortie secondaire : la régie indique la position de l'écran voulu dans les options de window.open.
  const m = /left=(-?\d+).*?top=(-?\d+)/.exec(features || '');
  if (m) { const d = screen.getDisplayNearestPoint({ x: +m[1], y: +m[2] }); if (d && d.id !== regieDisplay().id) return d; }
  return null;
}
function outputOptions(disp) {
  const common = { title: 'Régie LED — Sortie', backgroundColor: '#000000', autoHideMenuBar: true, icon,
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false } };
  if (!disp) return { ...common, width: 1280, height: 720, x: 80, y: 80 };
  const b = disp.bounds;
  if (outFsMode() === 'borderless') return { ...common, x: b.x, y: b.y, width: b.width, height: b.height, frame: false, resizable: false, thickFrame: false, enableLargerThanScreen: true };
  return { ...common, x: b.x, y: b.y, width: b.width, height: b.height, ...(process.platform === 'darwin' ? { simpleFullscreen: true } : { fullscreen: true }) };
}
/** window.open() depuis la régie : la sortie devient une vraie fenêtre plein écran ; les liens externes vont dans le navigateur. */
function handleWindowOpen({ url }) {
  let u; try { u = new URL(url); } catch { return { action: 'deny' }; }
  if (/^https?:$/.test(u.protocol) && u.origin !== new URL(srv.url).origin) { shell.openExternal(url); return { action: 'deny' }; }
  // window.open('', nom) : la régie sonde l'existence d'une sortie puis referme aussitôt la fenêtre vide.
  if (!/output\.html$/.test(u.pathname)) return { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 320, height: 200 } };
  if (u.origin === new URL(srv.url).origin) setImmediate(() => openOutputWindow(url));    // seulement la sortie de notre serveur local
  return { action: 'deny' };
}
/** Fenêtre de sortie créée ici, et non par window.open : elle a ainsi son PROPRE processus. Ouverte par window.open, elle
 *  partageait le fil d'exécution de la régie : les aperçus de la régie la ralentissaient (24 i/s au lieu de 60 sur un PC Windows)
 *  et une fenêtre de confirmation de la régie la figeait complètement. Les captures (PowerPoint, fenêtre) lui arrivent par le relais. */
function openOutputWindow(url) {
  const outId = new URL(url).searchParams.get('out') || 'main';
  const old = outputs.get(outId);
  if (old && !old.isDestroyed()) { old.loadURL(url); old.show(); return; }   // déjà ouverte : rechargée sur place, au même endroit
  const disp = displayFor(outId), win = new BrowserWindow(outputOptions(disp));
  if (outFsMode() === 'borderless') { win.borderless = true; if (disp) setFs(win, true); }
  setupOutputWindow(win, outId);
  win.loadURL(url);
}
function setupOutputWindow(win, outId) {
  logConsole(win.webContents, 'sortie ' + outId);
  outputs.set(outId, win);
  win.setMenuBarVisibility(false);
  // Échap dans la sortie : on quitte le plein écran (la fenêtre reste, déplaçable) ; Cmd/Ctrl+Maj+W la ferme (menu Sortie).
  win.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && isFs(win)) setFs(win, false); });
  win.on('closed', () => { if (outputs.get(outId) === win) outputs.delete(outId); refreshMenu(); });
  win.on('unresponsive', () => log.warn(`Sortie « ${outId} » : la fenêtre ne répond plus`));
  win.on('responsive', () => log.info(`Sortie « ${outId} » : la fenêtre répond de nouveau`));
  log.info(`Sortie « ${outId} » ouverte (${win.getBounds().width}×${win.getBounds().height}${isFs(win) ? ', plein écran' : ''})`);
  refreshMenu();
}
/** Résolution ou mise à l'échelle d'un écran changée (Windows : Paramètres → Écran) : chaque sortie affichée sur cet écran
 *  reprend toute sa surface. Sinon la fenêtre gardait l'ancienne taille et l'image était coupée ou décalée sur la télé. */
function refitOutputs(displayId) {
  for (const [outId, w] of outputs) {
    if (!w || w.isDestroyed() || displayChoice(outId) === 'window') continue;          // « Fenêtre simple » : sa taille reste celle choisie à la main
    const disp = screen.getAllDisplays().find(d => d.id === displayId);
    if (!disp || (screen.getDisplayMatching(w.getBounds()).id !== displayId && displayFor(outId)?.id !== displayId)) continue;   // sortie sur un autre écran : rien à faire
    const fs = isFs(w);
    if (!fs && displayId === regieDisplay().id) continue;                            // simple fenêtre sur l'écran de la régie : on n'y touche pas
    if (fs) setFs(w, false);
    w.setBounds(disp.bounds);
    if (fs) setFs(w, true);
    log.info(`Écran ${disp.label || displayId} passé en ${disp.size.width}×${disp.size.height} (×${disp.scaleFactor}) : sortie « ${outId} » recalée`);
  }
}
function moveOutput(outId = 'main') {
  const w = outputs.get(outId); if (!w || w.isDestroyed()) return;
  const disp = displayFor(outId);
  setFs(w, false);
  if (disp) { w.setBounds(disp.bounds); setFs(w, true); } else w.setBounds({ x: 80, y: 80, width: 1280, height: 720 });
}
const displayList = () => screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `${d.label || 'Écran ' + (i + 1)} — ${d.size.width}×${d.size.height}${d.internal ? ' (intégré)' : ''}`, regie: d.id === regieDisplay().id }));
ipcMain.on('regie:displays', e => { e.returnValue = { list: displayList(), choice: { ...settings.outputDisplays } }; });
ipcMain.on('regie:set-output-display', (_e, outId, v) => {
  if (typeof outId !== 'string') return;
  if (v === 'auto' || v == null) delete settings.outputDisplays[outId]; else settings.outputDisplays[outId] = v === 'window' ? 'window' : +v;
  saveSettings(); moveOutput(outId); refreshMenu();
});

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'window-management', 'notifications', 'clipboard-read',
    'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem', 'speaker-selection', 'idle-detection']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  installCapture(true);
}
/* Capture d'écran / de fenêtre (getDisplayMedia) : sélecteur du système s'il existe (macOS 15+), sinon notre petit sélecteur.
 * « Reprendre la capture » prévient d'abord (regie:prefer-capture) : la capture suivante prend directement la fenêtre voulue,
 * sans aucune fenêtre de choix (le sélecteur système de macOS s'afficherait aussi sur la TV des spectateurs). */
let preferCap = null;
/** Santé de l'ordinateur pour l'indicateur de la régie : processeur et mémoire de toute l'application, état thermique (Mac). */
ipcMain.handle('regie:metrics', () => {
  const m = app.getAppMetrics();
  let thermal = 'unknown'; try { thermal = powerMonitor.getCurrentThermalState?.() || 'unknown'; } catch { /* pas sur ce système */ }
  return { cpu: Math.round(m.reduce((a, x) => a + (x.cpu?.percentCPUUsage || 0), 0)), mem: Math.round(m.reduce((a, x) => a + (x.memory?.workingSetSize || 0), 0) / 1024),
    gpu: Math.round((m.find(x => x.type === 'GPU')?.memory?.workingSetSize || 0) / 1024), thermal, cores: (globalThis.navigator?.hardwareConcurrency) || 0 };
});
ipcMain.handle('regie:prefer-capture', (_e, want) => { preferCap = { ...(want || {}), until: Date.now() + 20000 }; installCapture(false); return true; });
function preferredSource(sources) {
  const p = preferCap; preferCap = null;
  if (!p || Date.now() > p.until) return null;
  const low = v => String(v || '').toLowerCase().normalize('NFC');
  const slideshow = s => /diaporama|slide ?show/i.test(s.name);
  if (p.ppt) {                                    // titre sans l'extension (« Diaporama PowerPoint - catalogue - … ») : on la retire
    const want = low(p.ppt).replace(/\.(pptx?|ppsx?|pptm|key)$/, '');
    const own = sources.find(s => slideshow(s) && low(s.name).includes(want));
    if (own) return own;
    const any = sources.filter(s => /diaporama powerpoint|powerpoint slide ?show/i.test(s.name));
    return any.length === 1 ? any[0] : null;        // plusieurs diaporamas ouverts : on ne devine pas (fenêtre de choix)
  }
  if (p.label) return sources.find(s => s.name === p.label) || null;
  return null;
}
function installCapture(useSystemPicker) {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: true });
      const own = new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId()));
      const pool = sources.filter(s => !own.has(s.id));
      const pref = preferredSource(pool);
      if (!useSystemPicker) installCapture(true);                      // la préférence ne vaut que pour cette capture
      if (pref) log.info('Capture reprise automatiquement : ' + pref.name);
      const chosen = pref || await pickSource(pool);
      if (!chosen) return cb(null);
      cb({ video: chosen, ...(request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (e) { log.error('Capture impossible : ' + e.message); cb(null); }
  }, { useSystemPicker });
}
/** Petite fenêtre listant écrans et fenêtres capturables ; résout avec la source choisie ou null. */
function pickSource(sources) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const win = new BrowserWindow({ width: 820, height: 600, parent: regieWin || undefined, modal: !!regieWin, title: 'Choisir ce qu\'il faut capturer',
      backgroundColor: '#17171b', autoHideMenuBar: true, icon, webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true } });
    const list = sources.map(s => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL(), icon: s.appIcon?.isEmpty() === false ? s.appIcon.toDataURL() : '' }));
    const onChoose = (e, id) => { if (e.sender === win.webContents) { finish(sources.find(s => s.id === id) || null); win.close(); } };
    ipcMain.on('picker:choose', onChoose);
    win.on('closed', () => { ipcMain.removeListener('picker:choose', onChoose); finish(null); });
    win.webContents.on('did-finish-load', () => win.webContents.send('picker:sources', list));
    win.loadFile(path.join(here, 'picker.html'));
  });
}

/** Erreurs et avertissements des pages → journal (utile pour « Signaler un bug »). */
function logConsole(wc, who) {
  wc.on('console-message', ev => { if (ev.level === 'error' || ev.level === 'warning' || !packaged) log[ev.level === 'error' ? 'error' : ev.level === 'warning' ? 'warn' : 'info'](`[${who}] ${ev.message}` + (ev.sourceId ? ` (${path.basename(ev.sourceId)}:${ev.lineNumber})` : '')); });
  wc.on('render-process-gone', (_e, d) => log.error(`[${who}] rendu interrompu : ${d.reason}`));
}
function createRegieWindow() {
  regieWin = new BrowserWindow({ width: 1500, height: 940, minWidth: 1000, minHeight: 640, title: 'Régie LED', backgroundColor: '#111114', icon, show: false,
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false } });
  regieWin.once('ready-to-show', () => regieWin.show());
  logConsole(regieWin.webContents, 'régie');
  regieWin.webContents.setWindowOpenHandler(handleWindowOpen);
  regieWin.on('close', e => {
    const open = [...outputs.values()].filter(w => !w.isDestroyed());
    if (!open.length) return;
    const r = dialog.showMessageBoxSync(regieWin, { type: 'warning', buttons: ['Quitter', 'Annuler'], defaultId: 1, cancelId: 1,
      message: 'La sortie est ouverte.', detail: 'Quitter la Régie LED éteint aussi la fenêtre de sortie (l\'écran LED devient noir).' });
    if (r !== 0) e.preventDefault();
  });
  regieWin.on('closed', () => { regieWin = null; for (const w of outputs.values()) if (!w.isDestroyed()) w.destroy(); app.quit(); });
  regieWin.loadURL(srv.url + '/');
}

const ctx = {
  version: app.getVersion(), packaged, repoUrl: REPO_URL, releasesUrl: RELEASES_URL,
  displays: () => screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `${d.label || 'Écran ' + (i + 1)} — ${d.size.width}×${d.size.height}${d.internal ? ' (intégré)' : ''}` })),
  outputDisplay: () => displayChoice('main'),
  setOutputDisplay: v => { if (v === 'auto') delete settings.outputDisplays.main; else settings.outputDisplays.main = v; saveSettings(); moveOutput('main'); refreshMenu(); regieWin?.webContents.send('regie:displays-changed'); },
  outputOpen: () => [...outputs.values()].some(w => !w.isDestroyed()),
  openOutput: () => regieWin?.webContents.executeJavaScript('document.getElementById("open-out")?.click()').catch(() => {}),
  closeOutputs: () => { for (const w of outputs.values()) if (!w.isDestroyed()) w.close(); },
  gfxModes: () => Object.entries(GFX_MODES).map(([id, m]) => ({ id, label: m.label })), gfxMode: () => settings.gfx || 'normal',
  setGfxMode: id => {
    if (!GFX_MODES[id] || id === (settings.gfx || 'normal')) return;
    settings.gfx = id; saveSettings(); refreshMenu();
    log.info(`Mode d'affichage choisi : ${GFX_MODES[id].label} (au prochain démarrage)`);
    const r = dialog.showMessageBoxSync(regieWin, { type: 'question', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
      message: `Mode d'affichage : ${GFX_MODES[id].label}`, detail: 'Il s\'applique au redémarrage de la Régie LED (le show est enregistré).' });
    if (r === 0) { for (const w of outputs.values()) if (!w.isDestroyed()) w.destroy(); app.relaunch(); app.quit(); }
  },
  hwDecode: () => hwDecode(),
  setHwDecode: on => {
    settings.hwDecode = !!on; saveSettings(); refreshMenu();
    log.info(`Décodage vidéo choisi : ${on ? 'carte graphique' : 'processeur'} (au prochain démarrage)`);
    const r = dialog.showMessageBoxSync(regieWin, { type: 'question', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
      message: `Décodage des vidéos : ${on ? 'par la carte graphique' : 'par le processeur (recommandé sous Windows)'}`, detail: 'Il s\'applique au redémarrage de la Régie LED (le show est enregistré).' });
    if (r === 0) { for (const w of outputs.values()) if (!w.isDestroyed()) w.destroy(); app.relaunch(); app.quit(); }
  },
  outFs: () => outFsMode(),
  setOutFs: mode => {
    settings.outFs = mode === 'borderless' ? 'borderless' : 'fullscreen'; saveSettings(); refreshMenu();
    log.info(`Plein écran de la sortie : ${settings.outFs}`);
    for (const w of [...outputs.values()]) if (!w.isDestroyed()) { const url = w.webContents.getURL(); w.destroy(); openOutputWindow(url); }   // sorties ouvertes : rouvertes dans le nouveau mode
  },
  toggleOutputFullscreen: () => { const w = outputs.get('main'); if (w && !w.isDestroyed()) setFs(w, !isFs(w)); },
  openMedia: () => shell.openPath(mediaDir), openData: () => shell.openPath(dataDir), openLogs: () => shell.openPath(app.getPath('logs')),
  reportBug: () => { const url = bugReportUrl({ version: app.getVersion(), packaged, logFile: log.transports.file.getFile().path, repoUrl: REPO_URL }); log.info('Signalement de bug : ouverture de GitHub (' + url.length + ' caractères)'); shell.openExternal(url); },
  checkUpdates: () => updater?.check(true), updateState: () => updater?.state || { kind: 'idle' }, restartToUpdate: () => updater?.restart(),
  about: () => dialog.showMessageBox(regieWin, { type: 'info', message: 'Régie LED ' + app.getVersion() + (packaged ? '' : ' (développement)'),
    detail: `Bennani Events\n\nShows : ${dataDir}\nMédias : ${mediaDir}\nJournal : ${app.getPath('logs')}\nServeur local : ${srv?.url || '-'}\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}` }),
};
function refreshMenu() { Menu.setApplicationMenu(buildMenu(ctx)); }

ipcMain.on('regie:info', e => { e.returnValue = { version: app.getVersion(), platform: process.platform, packaged, dataDir, mediaDir }; });
ipcMain.on('regie:restart-update', () => updater?.restart());

app.on('second-instance', () => { if (regieWin) { if (regieWin.isMinimized()) regieWin.restore(); regieWin.focus(); } });
app.on('window-all-closed', () => app.quit());

app.on('child-process-gone', (_e, d) => log.error(`Processus ${d.type}${d.name ? ' (' + d.name + ')' : ''} arrêté : ${d.reason} (code ${d.exitCode})`));
app.whenReady().then(async () => {
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  // Port fixe : l'adresse de la régie ne change pas d'un lancement à l'autre, donc le navigateur garde ses réglages (sources
  // en direct connues, largeur des panneaux, aimant…). Si le port est pris (autre instance, serveur de développement), on en prend un libre.
  const trash = p => shell.trashItem(p);                          // nettoyage de l'espace disque : vers la corbeille (récupérable)
  // Mac : l'application (« …/Regie LED.app ») que le pilote PowerPoint remet devant après avoir lancé le diaporama, au lieu de Chrome.
  const frontApp = process.platform === 'darwin' ? path.resolve(process.execPath, '..', '..', '..') : '';
  try { srv = await startServer({ root: appRoot, dataDir, mediaDir, toolsDir, port: 4410, trash, frontApp }); }
  catch (e) { log.warn(`Port 4410 indisponible (${e.code || e.message}) : port libre au hasard, les réglages du navigateur ne seront pas conservés.`); srv = await startServer({ root: appRoot, dataDir, mediaDir, toolsDir, port: 0, trash, frontApp }); }
  log.info(`Régie LED ${app.getVersion()} — serveur ${srv.url} — shows : ${dataDir} — médias : ${mediaDir}`);
  log.info(`Mode d'affichage : ${GFX_MODES[gfxMode].label} ; décodage vidéo : ${hwDecode() ? 'carte graphique' : 'processeur'} ; plein écran de la sortie : ${outFsMode() === 'borderless' ? 'fenêtre sans bordure' : 'plein écran du système'}`);
  // Lu une fois le processus graphique prêt : lu ici directement, l'état affichait « disabled_software » alors que la carte était active.
  app.getGPUInfo('complete').then(info => {
    const g = app.getGPUFeatureStatus(), dev = (info.gpuDevice || []).find(d => d.active) || info.gpuDevice?.[0];
    log.info(`Carte graphique : ${dev ? `${dev.deviceString || dev.deviceId} (pilote ${dev.driverVersion || '?'})` : 'inconnue'} — décodage vidéo ${g.video_decode}, WebGL ${g.webgl}, composition ${g.gpu_compositing}`);
  }).catch(e => log.warn('Carte graphique : état illisible (' + e.message + ')'));
  if (rootMoved && settings.rootWarned !== userRoot) {             // prévenu une fois : les fichiers ne sont pas dans Documents
    settings.rootWarned = userRoot; saveSettings();
    setTimeout(() => dialog.showMessageBox({ type: 'info', title: 'Régie LED', message: 'Shows et médias rangés dans « ' + userRoot + ' »',
      detail: `Le dossier « ${preferredRoot} » refuse l'écriture (sous Windows : protection contre les ransomwares ou OneDrive). La régie range donc ses shows et ses médias dans « ${userRoot} ».` }).catch(() => {}), 1500);
  }
  setupPermissions();
  createRegieWindow();
  updater = setupUpdater({ log, packaged, releasesUrl: RELEASES_URL, parent: () => regieWin, onChange: st => {
    refreshMenu();
    if (st.kind === 'available' && st.downloading && st.percent != null) { regieWin?.webContents.send('regie:update', { text: `Téléchargement de la version ${st.version} : ${st.percent} %` }); return; }
    const text = st.kind === 'downloaded' ? `Nouvelle version ${st.version} prête : menu Aide → « Redémarrer pour installer ».`
      : st.kind === 'available' && !st.downloading ? `Nouvelle version ${st.version} disponible : menu Aide → « Installer la mise à jour ».` : null;
    if (!text) return;
    regieWin?.webContents.send('regie:update', { text });
    if (Notification.isSupported()) { const n = new Notification({ title: 'Régie LED', body: text }); n.on('click', () => (st.kind === 'downloaded' ? updater.restart() : updater.check(true))); n.show(); }
  } });
  refreshMenu();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => { refreshMenu(); regieWin?.webContents.send('regie:displays-changed'); });
  screen.on('display-metrics-changed', (_e, d) => setTimeout(() => refitOutputs(d.id), 400));
  setTimeout(() => updater.check(false), 4000);
}).catch(e => { log.error('Démarrage impossible : ' + (e.stack || e)); dialog.showErrorBox('Régie LED', 'Démarrage impossible : ' + e.message); app.quit(); });
