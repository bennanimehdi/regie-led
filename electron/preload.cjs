// Pont minimal entre l'application de bureau et les pages (régie et sortie) : `window.regieDesktop`.
const { contextBridge, ipcRenderer } = require('electron');
const info = ipcRenderer.sendSync('regie:info');
contextBridge.exposeInMainWorld('regieDesktop', {
  ...info,
  /** Appelé avec { text } quand une mise à jour est disponible ou prête. */
  onUpdate: cb => ipcRenderer.on('regie:update', (_e, m) => cb(m)),
  restartToUpdate: () => ipcRenderer.send('regie:restart-update'),
});
