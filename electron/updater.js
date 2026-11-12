/* Mises à jour automatiques depuis les GitHub Releases (electron-updater), bêtas comprises. Dans les deux cas, la nouvelle
 * version REMPLACE l'ancienne : on ne garde jamais deux copies de l'application.
 * Windows : la nouvelle version est téléchargée en arrière-plan ; « Redémarrer maintenant » (ou la fermeture de l'application)
 *   lance l'installeur en silence, qui désinstalle l'ancienne version, installe la nouvelle et relance la régie.
 * macOS : l'application n'est pas signée par Apple, donc le mécanisme d'electron-updater est refusé. La régie télécharge donc
 *   elle-même l'archive .zip de la nouvelle version, la décompresse, puis un petit script (lancé après sa fermeture) remplace
 *   « Régie LED.app » à son emplacement (Applications) et la relance. L'ancienne est gardée de côté jusqu'à la fin de la copie :
 *   si quelque chose échoue, elle est remise en place. Shows et médias (Documents/Régie LED) ne sont jamais touchés. */
import electronUpdater from 'electron-updater';
import { app, dialog, shell, net } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const { autoUpdater } = electronUpdater;

export function setupUpdater({ log, packaged, releasesUrl, parent, onChange }) {
  const mac = process.platform === 'darwin';
  const api = { state: { kind: 'idle' }, check, restart: () => (mac ? macInstall() : autoUpdater.quitAndInstall(true, true)) };
  let manual = false, info = null, installing = false;
  const asset = (inf, ext) => (inf?.files || []).find(f => f.url.endsWith(ext) && f.url.includes('-' + process.arch + '.'));
  const assetUrl = (inf, f) => `${releasesUrl}/download/v${inf.version}/${f.url}`;
  const dmgUrl = inf => { const f = asset(inf, '.dmg'); return f ? assetUrl(inf, f) : releasesUrl; };
  const set = st => { api.state = st; onChange(st); };
  const ask = opts => dialog.showMessageBox(parent() || undefined, opts);

  autoUpdater.logger = log;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = !mac;
  autoUpdater.autoInstallOnAppQuit = !mac;

  autoUpdater.on('checking-for-update', () => log.info('Mises à jour : vérification…'));
  autoUpdater.on('update-not-available', inf => {
    set({ kind: 'none' });
    if (manual) ask({ type: 'info', message: 'Régie LED est à jour.', detail: `Version ${inf.version} : c'est la plus récente.` });
    manual = false;
  });
  autoUpdater.on('update-available', inf => {
    info = inf;
    log.info('Mises à jour : version ' + inf.version + ' disponible');
    if (mac) {
      set({ kind: 'available', version: inf.version, downloading: false, url: dmgUrl(inf) });
      ask({ type: 'info', buttons: ['Installer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
        message: `Nouvelle version ${inf.version} disponible`,
        detail: 'La régie la télécharge, remplace l\'ancienne version dans Applications et redémarre (moins d\'une minute). Tes shows et médias ne sont pas touchés.\n\nÀ éviter pendant un événement : choisis « Plus tard », elle reste proposée dans le menu Aide.' })
        .then(r => { if (r.response === 0) macInstall(); });
    } else {
      set({ kind: 'available', version: inf.version, downloading: true });
      if (manual) ask({ type: 'info', message: `Nouvelle version ${inf.version} : téléchargement en cours.`, detail: 'Tu seras prévenu quand elle sera prête à installer.' });
    }
    manual = false;
  });
  autoUpdater.on('download-progress', p => log.info(`Mises à jour : ${Math.round(p.percent)} %`));
  autoUpdater.on('update-downloaded', inf => {
    log.info('Mises à jour : version ' + inf.version + ' prête');
    set({ kind: 'downloaded', version: inf.version });
    ask({ type: 'info', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
      message: `Nouvelle version ${inf.version} prête`,
      detail: 'Elle remplace l\'ancienne version (désinstallée automatiquement) puis la régie redémarre. « Plus tard » : elle s\'installera à la fermeture de l\'application.' })
      .then(r => { if (r.response === 0) autoUpdater.quitAndInstall(true, true); });
  });
  autoUpdater.on('error', e => {
    log.warn('Mises à jour : ' + (e?.message || e));
    set({ kind: 'error', message: String(e?.message || e) });
    if (manual) ask({ type: 'warning', buttons: ['Voir les versions en ligne', 'Fermer'], defaultId: 0, cancelId: 1,
      message: 'Impossible de vérifier les mises à jour.', detail: String(e?.message || e) }).then(r => { if (r.response === 0) shell.openExternal(releasesUrl); });
    manual = false;
  });

  /** Mac : télécharge le .zip de la nouvelle version, le décompresse et remplace l'application en place après sa fermeture. */
  async function macInstall() {
    if (installing || !info) return;
    const fallback = why => {
      log.warn('Mise à jour automatique impossible : ' + why);
      ask({ type: 'warning', buttons: ['Télécharger le .dmg', 'Fermer'], defaultId: 0, cancelId: 1, message: 'Installation automatique impossible',
        detail: why + '\n\nTélécharge le .dmg, ouvre-le et glisse Régie LED dans Applications en choisissant « Remplacer ».' })
        .then(r => { if (r.response === 0) shell.openExternal(dmgUrl(info)); });
    };
    const zipInfo = asset(info, '.zip');
    if (!zipInfo) return fallback('archive de la nouvelle version introuvable dans la release.');
    const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
    if (!bundle.endsWith('.app')) return fallback('emplacement de l\'application inattendu (' + bundle + ').');
    if (bundle.includes('/AppTranslocation/')) return fallback('l\'application tourne depuis un emplacement temporaire de macOS. Glisse d\'abord Régie LED dans le dossier Applications, puis relance-la.');
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); }
    catch { return fallback('le dossier « ' + path.dirname(bundle) + ' » n\'est pas modifiable par ton compte.'); }
    installing = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-led-maj-'));
    try {
      const zip = path.join(tmp, 'maj.zip'), url = assetUrl(info, zipInfo);
      set({ kind: 'available', version: info.version, downloading: true, percent: 0 });
      log.info('Mise à jour Mac : téléchargement de ' + url);
      const res = await net.fetch(url);
      if (!res.ok || !res.body) throw new Error('téléchargement refusé (HTTP ' + res.status + ')');
      const total = +res.headers.get('content-length') || zipInfo.size || 0;
      let got = 0, last = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', c => {
        got += c.length;
        const pct = total ? Math.floor(got / total * 100) : 0;
        if (pct >= last + 5) { last = pct; parent()?.setProgressBar(pct / 100); set({ kind: 'available', version: info.version, downloading: true, percent: pct }); }
      });
      await pipeline(body, fs.createWriteStream(zip));
      parent()?.setProgressBar(-1);
      const out = path.join(tmp, 'nouvelle');
      await new Promise((ok, ko) => execFile('ditto', ['-x', '-k', zip, out], e => (e ? ko(e) : ok())));
      const name = fs.readdirSync(out).find(n => n.endsWith('.app'));
      if (!name) throw new Error('archive sans application');
      const fresh = path.join(out, name), script = path.join(tmp, 'remplacer.sh');
      // Attend la fermeture de la régie, met l'ancienne de côté, copie la nouvelle (ou remet l'ancienne si la copie échoue), relance.
      fs.writeFileSync(script, `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
OLD=${JSON.stringify(bundle)}
NEW=${JSON.stringify(fresh)}
BAK="$OLD.ancienne-$$"
mv "$OLD" "$BAK" || { open "$OLD"; exit 1; }
if ditto "$NEW" "$OLD"; then rm -rf "$BAK"; else rm -rf "$OLD"; mv "$BAK" "$OLD"; fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
open "$OLD"
rm -rf ${JSON.stringify(tmp)}
`, { mode: 0o755 });
      log.info('Mise à jour Mac : remplacement de ' + bundle + ' par la version ' + info.version);
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    } catch (e) {
      installing = false;
      parent()?.setProgressBar(-1);
      fs.rmSync(tmp, { recursive: true, force: true });
      set({ kind: 'available', version: info.version, downloading: false, url: dmgUrl(info) });
      fallback('erreur pendant le téléchargement ou la décompression (' + (e?.message || e) + ').');
    }
  }

  function check(fromMenu) {
    manual = !!fromMenu;
    if (!packaged) {
      if (fromMenu) ask({ type: 'info', message: 'Mises à jour indisponibles en mode développement.', detail: 'Elles fonctionnent dans l\'application installée (téléchargée depuis la page des versions).' });
      manual = false; return;
    }
    if (api.state.kind === 'downloaded') { if (fromMenu) api.restart(); return; }
    if (mac && api.state.kind === 'available' && fromMenu) { manual = false; macInstall(); return; }
    autoUpdater.checkForUpdates().catch(e => log.warn('Mises à jour : ' + e.message));
  }
  return api;
}
