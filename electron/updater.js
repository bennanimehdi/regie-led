/* Mises à jour automatiques depuis les GitHub Releases (electron-updater), bêtas comprises.
 * Windows : la nouvelle version est téléchargée en arrière-plan, puis installée au redémarrage (menu Aide).
 * macOS : l'application n'étant pas signée par Apple, l'installation automatique est impossible ; on prévient et on
 * renvoie vers la page des versions pour télécharger le nouveau .dmg. */
import electronUpdater from 'electron-updater';
import { dialog, shell } from 'electron';
const { autoUpdater } = electronUpdater;

export function setupUpdater({ log, packaged, releasesUrl, parent, onChange }) {
  const mac = process.platform === 'darwin';
  const api = { state: { kind: 'idle' }, check, restart: () => autoUpdater.quitAndInstall() };
  let manual = false, downloadUrl = releasesUrl;
  /** Mac : adresse du .dmg de cette architecture dans la release (sinon la page des versions). */
  const dmgUrl = info => { const f = (info.files || []).find(f => /\.dmg$/.test(f.url) && f.url.includes('-' + process.arch + '.')); return f ? `${releasesUrl}/download/v${info.version}/${f.url}` : releasesUrl; };
  const set = st => { api.state = st; onChange(st); };

  autoUpdater.logger = log;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = !mac;
  autoUpdater.autoInstallOnAppQuit = !mac;

  autoUpdater.on('checking-for-update', () => log.info('Mises à jour : vérification…'));
  autoUpdater.on('update-not-available', info => {
    set({ kind: 'none' });
    if (manual) dialog.showMessageBox(parent() || undefined, { type: 'info', message: 'Régie LED est à jour.', detail: `Version ${info.version} : c'est la plus récente.` });
    manual = false;
  });
  autoUpdater.on('update-available', info => {
    log.info('Mises à jour : version ' + info.version + ' disponible');
    if (mac) {
      downloadUrl = dmgUrl(info);
      set({ kind: 'available', version: info.version, downloading: false, url: downloadUrl });
      if (manual) dialog.showMessageBox(parent() || undefined, { type: 'info', buttons: ['Télécharger le .dmg', 'Plus tard'], defaultId: 0, cancelId: 1,
        message: `Nouvelle version ${info.version} disponible`, detail: 'Sur Mac, le navigateur télécharge le nouveau .dmg : ouvre-le et glisse Régie LED dans Applications (tes shows et médias restent dans Documents/Régie LED).' })
        .then(r => { if (r.response === 0) shell.openExternal(downloadUrl); });
    } else {
      set({ kind: 'available', version: info.version, downloading: true });
      if (manual) dialog.showMessageBox(parent() || undefined, { type: 'info', message: `Nouvelle version ${info.version} : téléchargement en cours.`, detail: 'Tu seras prévenu quand elle sera prête à installer.' });
    }
    manual = false;
  });
  autoUpdater.on('download-progress', p => log.info(`Mises à jour : ${Math.round(p.percent)} %`));
  autoUpdater.on('update-downloaded', info => { log.info('Mises à jour : version ' + info.version + ' prête'); set({ kind: 'downloaded', version: info.version }); });
  autoUpdater.on('error', e => {
    log.warn('Mises à jour : ' + (e?.message || e));
    set({ kind: 'error', message: String(e?.message || e) });
    if (manual) dialog.showMessageBox(parent() || undefined, { type: 'warning', buttons: ['Voir les versions en ligne', 'Fermer'], defaultId: 0, cancelId: 1,
      message: 'Impossible de vérifier les mises à jour.', detail: String(e?.message || e) }).then(r => { if (r.response === 0) shell.openExternal(releasesUrl); });
    manual = false;
  });

  function check(fromMenu) {
    manual = !!fromMenu;
    if (!packaged) {
      if (fromMenu) dialog.showMessageBox(parent() || undefined, { type: 'info', message: 'Mises à jour indisponibles en mode développement.', detail: 'Elles fonctionnent dans l\'application installée (téléchargée depuis la page des versions).' });
      manual = false; return;
    }
    if (api.state.kind === 'downloaded') { if (fromMenu) api.restart(); return; }
    if (mac && api.state.kind === 'available' && fromMenu) { shell.openExternal(downloadUrl); manual = false; return; }
    autoUpdater.checkForUpdates().catch(e => log.warn('Mises à jour : ' + e.message));
  }
  return api;
}
