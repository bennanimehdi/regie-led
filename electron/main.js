/* Régie LED — application de bureau (Electron).
 * Au lancement : démarre le serveur local de serve.js sur un port libre, ouvre la régie dans une fenêtre, et quand la régie
 * appelle window.open('output.html'), ouvre la sortie en plein écran sur l'écran LED (premier écran externe, ou celui choisi
 * dans le menu Sortie). Les shows et les médias de l'application installée vivent dans « Documents/Régie LED ». */
import { app, BrowserWindow, screen, session, desktopCapturer, shell, ipcMain, Menu, dialog, nativeImage, Notification } from 'electron';
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
if (!app.requestSingleInstanceLock()) app.quit();

// Journal : ~/Library/Logs/Régie LED/regie-led.log (Mac) ou %APPDATA%\Régie LED\logs\regie-led.log (Windows).
log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), 'regie-led.log');
log.transports.file.level = 'info';
log.transports.console.level = packaged ? false : 'info';
log.errorHandler.startCatching({ showDialog: false });

const userRoot = process.env.REGIE_LED_DIR || path.join(app.getPath('documents'), 'Régie LED');
const dataDir = path.join(userRoot, 'data'), mediaDir = path.join(userRoot, 'media');
const settingsFile = path.join(app.getPath('userData'), 'reglages-bureau.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* premier lancement */ }
const saveSettings = () => { try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch (e) { log.warn('Réglages non enregistrés : ' + e.message); } };

let srv, regieWin = null, updater = null;
const outputs = new Map();                                  // id de sortie ('main', …) → BrowserWindow
const regieDisplay = () => (regieWin ? screen.getDisplayMatching(regieWin.getBounds()) : screen.getPrimaryDisplay());
const isFs = w => w.isSimpleFullScreen() || w.isFullScreen();
const setFs = (w, on) => (process.platform === 'darwin' ? w.setSimpleFullScreen(on) : w.setFullScreen(on));

/** Écran où ouvrir une sortie : 'window' = fenêtre simple ; sinon l'écran choisi dans le menu, ou le premier écran autre que la régie. */
function displayFor(outId, features) {
  const all = screen.getAllDisplays();
  if (outId === 'main') {
    if (settings.outputDisplay === 'window') return null;
    const chosen = all.find(d => d.id === settings.outputDisplay);
    return chosen || all.find(d => d.id !== regieDisplay().id) || null;
  }
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
  return { ...common, x: b.x, y: b.y, width: b.width, height: b.height, ...(process.platform === 'darwin' ? { simpleFullscreen: true } : { fullscreen: true }) };
}
/** window.open() depuis la régie : la sortie devient une vraie fenêtre plein écran ; les liens externes vont dans le navigateur. */
function handleWindowOpen({ url, features }) {
  let u; try { u = new URL(url); } catch { return { action: 'deny' }; }
  if (/^https?:$/.test(u.protocol) && u.origin !== new URL(srv.url).origin) { shell.openExternal(url); return { action: 'deny' }; }
  // window.open('', nom) : la régie sonde l'existence d'une sortie puis referme aussitôt la fenêtre vide.
  if (!/output\.html$/.test(u.pathname)) return { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 320, height: 200 } };
  const outId = u.searchParams.get('out') || 'main';
  return { action: 'allow', overrideBrowserWindowOptions: outputOptions(displayFor(outId, features)) };
}
function onWindowCreated(win, { url }) {
  let u; try { u = new URL(url); } catch { return; }
  if (!/output\.html$/.test(u.pathname)) return;
  const outId = u.searchParams.get('out') || 'main';
  logConsole(win.webContents, 'sortie ' + outId);
  const old = outputs.get(outId); if (old && old !== win && !old.isDestroyed()) old.destroy();
  outputs.set(outId, win);
  win.setMenuBarVisibility(false);
  // Échap dans la sortie : on quitte le plein écran (la fenêtre reste, déplaçable) ; Cmd/Ctrl+Maj+W la ferme (menu Sortie).
  win.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && isFs(win)) setFs(win, false); });
  win.on('closed', () => { if (outputs.get(outId) === win) outputs.delete(outId); refreshMenu(); });
  log.info(`Sortie « ${outId} » ouverte (${win.getBounds().width}×${win.getBounds().height}${isFs(win) ? ', plein écran' : ''})`);
  refreshMenu();
}
function moveMainOutput() {
  const w = outputs.get('main'); if (!w || w.isDestroyed()) return;
  const disp = displayFor('main');
  setFs(w, false);
  if (disp) { w.setBounds(disp.bounds); setFs(w, true); } else w.setBounds({ x: 80, y: 80, width: 1280, height: 720 });
}

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'window-management', 'notifications', 'clipboard-read',
    'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem', 'speaker-selection', 'idle-detection']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  // Capture d'écran / de fenêtre (getDisplayMedia) : sélecteur du système s'il existe (macOS 15+), sinon notre petit sélecteur.
  ses.setDisplayMediaRequestHandler(async (request, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: true });
      const own = new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId()));
      const chosen = await pickSource(sources.filter(s => !own.has(s.id)));
      if (!chosen) return cb(null);
      cb({ video: chosen, ...(request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (e) { log.error('Capture impossible : ' + e.message); cb(null); }
  }, { useSystemPicker: true });
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
  regieWin.webContents.on('did-create-window', onWindowCreated);
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
  outputDisplay: () => settings.outputDisplay ?? 'auto',
  setOutputDisplay: v => { settings.outputDisplay = v === 'auto' ? undefined : v; saveSettings(); moveMainOutput(); refreshMenu(); },
  outputOpen: () => [...outputs.values()].some(w => !w.isDestroyed()),
  openOutput: () => regieWin?.webContents.executeJavaScript('document.getElementById("open-out")?.click()').catch(() => {}),
  closeOutputs: () => { for (const w of outputs.values()) if (!w.isDestroyed()) w.close(); },
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

app.whenReady().then(async () => {
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  // Port fixe : l'adresse de la régie ne change pas d'un lancement à l'autre, donc le navigateur garde ses réglages (sources
  // en direct connues, largeur des panneaux, aimant…). Si le port est pris (autre instance, serveur de développement), on en prend un libre.
  try { srv = await startServer({ root: appRoot, dataDir, mediaDir, toolsDir, port: 4410 }); }
  catch (e) { log.warn(`Port 4410 indisponible (${e.code || e.message}) : port libre au hasard, les réglages du navigateur ne seront pas conservés.`); srv = await startServer({ root: appRoot, dataDir, mediaDir, toolsDir, port: 0 }); }
  log.info(`Régie LED ${app.getVersion()} — serveur ${srv.url} — shows : ${dataDir} — médias : ${mediaDir}`);
  setupPermissions();
  createRegieWindow();
  updater = setupUpdater({ log, packaged, releasesUrl: RELEASES_URL, parent: () => regieWin, onChange: st => {
    refreshMenu();
    const text = st.kind === 'downloaded' ? `Nouvelle version ${st.version} prête : menu Aide → « Redémarrer pour installer ».`
      : st.kind === 'available' && !st.downloading ? `Nouvelle version ${st.version} disponible : menu Aide → « Télécharger la mise à jour ».` : null;
    if (!text) return;
    regieWin?.webContents.send('regie:update', { text });
    if (Notification.isSupported()) { const n = new Notification({ title: 'Régie LED', body: text }); n.on('click', () => (st.kind === 'downloaded' ? updater.restart() : shell.openExternal(st.url || RELEASES_URL))); n.show(); }
  } });
  refreshMenu();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, refreshMenu);
  setTimeout(() => updater.check(false), 4000);
}).catch(e => { log.error('Démarrage impossible : ' + (e.stack || e)); dialog.showErrorBox('Régie LED', 'Démarrage impossible : ' + e.message); app.quit(); });
