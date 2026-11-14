// Pont minimal entre l'application de bureau et les pages (régie et sortie) : `window.regieDesktop`.
const { contextBridge, ipcRenderer } = require('electron');
const info = ipcRenderer.sendSync('regie:info');
contextBridge.exposeInMainWorld('regieDesktop', {
  ...info,
  /** Appelé avec { text } quand une mise à jour est disponible ou prête. */
  onUpdate: cb => ipcRenderer.on('regie:update', (_e, m) => cb(m)),
  restartToUpdate: () => ipcRenderer.send('regie:restart-update'),
  /** La prochaine capture prend directement cette fenêtre si elle existe : { ppt: 'nom du fichier' } ou { label: 'titre exact' }. */
  preferCapture: want => ipcRenderer.invoke('regie:prefer-capture', want),
  /** Écrans branchés et écran choisi pour chaque sortie : { list: [{id, label, regie}], choice: {sortie: id | 'window'} }. */
  displays: () => ipcRenderer.sendSync('regie:displays'),
  /** Choisit l'écran d'une sortie ('auto', id d'écran ou 'window') ; une sortie ouverte y est déplacée tout de suite. */
  setOutputDisplay: (outId, v) => ipcRenderer.send('regie:set-output-display', outId, v),
  onDisplaysChanged: cb => ipcRenderer.on('regie:displays-changed', () => cb()),
  /** Processeur (%), mémoire (Mo) de toute l'application et état thermique : { cpu, mem, gpu, thermal }. */
  metrics: () => ipcRenderer.invoke('regie:metrics'),
  /** Fiche de l'ordinateur (système, écrans, carte graphique, réglages) pour l'enregistreur de diagnostic. */
  machineInfo: () => ipcRenderer.invoke('regie:machine-info'),
  /** Ouvre le dossier des journaux de diagnostic (data/journaux). */
  openJournals: () => ipcRenderer.send('regie:open-journals'),
});
