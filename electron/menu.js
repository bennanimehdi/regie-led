/* Menu de l'application de bureau (en français). `ctx` vient de main.js. */
import { Menu } from 'electron';

export function buildMenu(ctx) {
  const mac = process.platform === 'darwin';
  const up = ctx.updateState();
  const updateItems = up.kind === 'downloaded'
    ? [{ label: `Redémarrer pour installer la version ${up.version}`, click: () => ctx.restartToUpdate() }]
    : up.kind === 'available' && !up.downloading
      ? [{ label: `Installer la mise à jour (${up.version})…`, click: () => ctx.checkUpdates() }]
      : [{ label: 'Rechercher une mise à jour…', click: () => ctx.checkUpdates() }];
  const screens = [
    { label: 'Automatique (premier écran externe)', type: 'radio', checked: ctx.outputDisplay() === 'auto', click: () => ctx.setOutputDisplay('auto') },
    ...ctx.displays().map(d => ({ label: d.label, type: 'radio', checked: ctx.outputDisplay() === d.id, click: () => ctx.setOutputDisplay(d.id) })),
    { type: 'separator' },
    { label: 'Fenêtre simple (pas de plein écran)', type: 'radio', checked: ctx.outputDisplay() === 'window', click: () => ctx.setOutputDisplay('window') },
  ];
  const template = [
    ...(mac ? [{ label: 'Régie LED', submenu: [
      { label: 'À propos de Régie LED', click: () => ctx.about() },
      ...updateItems,
      { type: 'separator' }, { role: 'hide', label: 'Masquer Régie LED' }, { role: 'hideOthers', label: 'Masquer les autres' }, { role: 'unhide', label: 'Tout afficher' },
      { type: 'separator' }, { role: 'quit', label: 'Quitter Régie LED' },
    ] }] : []),
    { label: 'Fichier', submenu: [
      { label: 'Ouvrir le dossier des médias', accelerator: 'CmdOrCtrl+Shift+M', click: () => ctx.openMedia() },
      { label: 'Ouvrir le dossier des shows (data)', click: () => ctx.openData() },
      { type: 'separator' },
      { label: 'Recharger la régie', role: 'reload' },
      ...(mac ? [{ role: 'close', label: 'Fermer la fenêtre' }] : [{ role: 'quit', label: 'Quitter' }]),
    ] },
    { label: 'Édition', submenu: [
      { role: 'undo', label: 'Annuler' }, { role: 'redo', label: 'Rétablir' }, { type: 'separator' },
      { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' },
    ] },
    { label: 'Sortie', submenu: [
      { label: 'Ouvrir la sortie', accelerator: 'CmdOrCtrl+Shift+O', click: () => ctx.openOutput() },
      { label: 'Plein écran de la sortie (basculer)', accelerator: 'CmdOrCtrl+Shift+F', enabled: ctx.outputOpen(), click: () => ctx.toggleOutputFullscreen() },
      { label: 'Fermer la sortie', accelerator: 'CmdOrCtrl+Shift+W', enabled: ctx.outputOpen(), click: () => ctx.closeOutputs() },
      { type: 'separator' },
      { label: 'Écran de la sortie', submenu: screens },
    ] },
    { label: 'Affichage', submenu: [
      { role: 'togglefullscreen', label: 'Régie en plein écran' },
      { role: 'resetZoom', label: 'Taille réelle' }, { role: 'zoomIn', label: 'Agrandir' }, { role: 'zoomOut', label: 'Réduire' },
      { type: 'separator' }, { role: 'toggleDevTools', label: 'Outils de développement' },
    ] },
    { label: 'Aide', submenu: [
      { label: 'Signaler un bug…', click: () => ctx.reportBug() },
      ...updateItems,
      { label: 'Ouvrir le dossier des journaux', click: () => ctx.openLogs() },
      { type: 'separator' },
      { label: 'Page du projet (GitHub)', click: () => import('electron').then(({ shell }) => shell.openExternal(ctx.repoUrl)) },
      { label: 'Télécharger les versions', click: () => import('electron').then(({ shell }) => shell.openExternal(ctx.releasesUrl)) },
      ...(mac ? [] : [{ type: 'separator' }, { label: `À propos — Régie LED ${ctx.version}`, click: () => ctx.about() }]),
    ] },
  ];
  return Menu.buildFromTemplate(template);
}
