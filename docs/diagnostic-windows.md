# Diagnostic Windows : la sortie se fige sur la télé

Note de passation pour une session Claude ouverte sur le PC Windows de Mehdi (2026-11-12).

## Résultat (2026-11-12, session Claude sur le PC)

**`--disable-accelerated-video-decode` rend la sortie fluide sur la télé.** Bêta 9 : décodage par le processeur par défaut sous
Windows (`hwDecode` dans `reglages-bureau.json`, menu Affichage → « Décoder les vidéos avec la carte graphique » pour revenir).
Les autres modes ci-dessous restent disponibles en secours.

## Le problème

- PC : **Lenovo LOQ 15IRX9** (Windows 11, carte NVIDIA, Lenovo Vantage). Télé : **Haier 4K** en HDMI, bureau étendu.
- Dans la Régie LED, la vidéo envoyée à la sortie **saccade et se fige plusieurs secondes sur la télé**, pendant que la régie continue
  normalement (aperçus fluides sur l'écran du portable).
- **Sans télé branchée**, la sortie (sur l'écran du portable) est fluide.
- **La même vidéo dans le Lecteur multimédia de Windows, en plein écran sur la télé, est fluide.**
- Même chose avec un PowerPoint en direct (capture de fenêtre).

Conclusion : la régie calcule ses images (pastille Santé : 60 i/s, processeur 3 %, 0 à 2 images vidéo perdues), mais leur
**présentation par Windows sur le 2e écran** coince. Ce n'est ni la puissance, ni les fichiers, ni la télé.

## Déjà essayé (sans effet suffisant)

- Lenovo Vantage → Paramètres de jeu → **Mode de fonctionnement du GPU = dGPU** (redémarré). Overclocking GPU coupé, taux de
  rafraîchissement adaptatif coupé.
- `Regie LED.exe` en **Hautes performances** (Paramètres → Écran → Graphiques) et processeur NVIDIA dans le panneau NVIDIA.
- Écran du portable et télé en **60 Hz**. Télé passée en **1920×1080**, mise à l'échelle 100 %.
- Bêta 8 : la fenêtre de sortie a maintenant **son propre processus** (avant, elle partageait celui de la régie et tombait à 24 i/s),
  et une image vidéo n'est envoyée à la carte graphique que lorsqu'elle est nouvelle (`requestVideoFrameCallback`).

## Ce qui est prêt mais pas encore publié (bêta 9)

Dans `electron/main.js` et `electron/menu.js` :

- **Affichage → Mode d'affichage** (redémarre la régie, réglage `gfx` de `reglages-bureau.json`) :
  Normal ; **A** = `--disable-direct-composition` ; **B** = `--use-angle=gl` ; **C** = `--disable-gpu-vsync`.
- **Sortie → Type de plein écran** (Windows) : plein écran du système, ou **fenêtre sans bordure** (`outFs: 'borderless'`).
- Sous Windows, `--disable-features=CalculateNativeWinOcclusion` toujours actif.
- `refitOutputs` : la sortie reprend la taille de l'écran quand sa résolution change.
- Le mode choisi est écrit dans le journal au démarrage.

## Ce qu'il faut faire sur ce PC

1. Lancer la régie depuis le code (`npm ci` puis `npx electron .`) ou installer la version de test, avec la télé branchée.
2. Ouvrir la sortie sur la télé, envoyer une vidéo 4K, ouvrir la pastille **Santé**.
3. Lire le journal : `%APPDATA%\Régie LED\logs\regie-led.log` (ou `%APPDATA%\Regie LED\logs`) — on y trouve la carte graphique,
   le décodage vidéo, les relances de vidéo figée et les plantages du processus graphique.
4. Essayer les modes A, B, C, puis la fenêtre sans bordure, et noter lequel supprime le gel.
5. Pistes si aucun ne suffit : `chrome://gpu` (dans la régie : Affichage → Outils de développement, puis ouvrir `chrome://gpu`) pour
   voir les overlays / DirectComposition / MPO ; tester `--disable-features=DirectCompositionVideoOverlays` ou
   `--disable-gpu-compositing` ; vérifier dans `js/output.js` si la boucle `requestAnimationFrame` continue pendant le gel
   (sinon : fenêtre jugée cachée ; si oui : présentation bloquée).

Règles du projet : interface et commentaires en français, pas de `prompt()` (Electron ne l'a pas), commits avec
`mbennani.events@gmail.com`, une bêta = `version` dans package.json + tag `vX` poussé (le workflow publie Mac et Windows).
