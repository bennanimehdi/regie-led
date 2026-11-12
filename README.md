# Bennani Events — Régie LED

Pilotage simple d'écrans géants à LED, dans l'esprit de Resolume mais réduit à l'essentiel :
vidéos, images, textes, caméra, effets, conducteur de soirée et mapping en formes libres.

## Lancer

### Application de bureau (Mac et Windows) — version bêta

1. Télécharger l'installeur sur la page des versions : **https://github.com/bennanimehdi/regie-led/releases**
   - Mac Apple Silicon (M1, M2, M3, M4…) : `Regie-LED-<version>-mac-arm64.dmg`
   - Mac Intel : `Regie-LED-<version>-mac-x64.dmg`
   - Windows 10/11 (64 bits) : `Regie-LED-<version>-win-x64.exe`
2. **Mac** : ouvrir le `.dmg`, glisser **Régie LED** dans **Applications** (l'app s'appelle `Regie LED.app` sur le disque, sans accent).
   L'application n'est pas encore signée par Apple, le Mac la bloque donc la première fois :
   - macOS 15 ou plus récent : lancer l'app (message « impossible d'ouvrir »), puis **Réglages Système → Confidentialité et sécurité**, descendre jusqu'au message sur Régie LED et cliquer **Ouvrir quand même** ; relancer l'app et confirmer.
   - macOS 14 et avant : **clic droit** (ou Ctrl+clic) sur l'app → **Ouvrir** → **Ouvrir**.
   - Si le Mac affirme que l'app est « endommagée », coller dans le Terminal : `xattr -cr "/Applications/Regie LED.app"` puis la rouvrir.
   Au premier usage de la caméra, du micro, de la capture d'écran ou de PowerPoint, macOS demande une autorisation : accepter.
3. **Windows** : lancer le `.exe`. SmartScreen affiche « Windows a protégé votre ordinateur » : cliquer **Informations complémentaires → Exécuter quand même**, puis choisir le dossier d'installation.
   Sur Windows, le **PowerPoint en direct** et l'import de PowerPoint « en images » fonctionnent si Microsoft PowerPoint est installé (piloté par automation). L'import de Word, Excel et PDF n'est pas encore disponible sur Windows : exporter ces documents en images (ou en PowerPoint). Tout le reste fonctionne.

**Écran LED.** Dans la régie, **Ouvrir la sortie** (ou Cmd/Ctrl+Maj+O) ouvre la sortie **en plein écran sur le premier écran externe** (la sortie HDMI vers le processeur LED, en bureau étendu). Le menu **Sortie → Écran de la sortie** permet de choisir un autre écran ou une simple fenêtre ; Cmd/Ctrl+Maj+F bascule le plein écran, Échap dans la sortie en sort, Cmd/Ctrl+Maj+W ferme la sortie.

**Où sont les shows et les médias.** Dans le dossier **Documents → Régie LED** de l'utilisateur : `data/show.json` (+ `data/backups/`, documents importés, PowerPoint) et `media/`. Menu **Fichier → Ouvrir le dossier des médias** (ou le bouton « Ouvrir le dossier » de la médiathèque). Désinstaller ou mettre à jour l'application ne touche pas à ce dossier.

**Mises à jour.** L'application vérifie au lancement s'il existe une nouvelle version (bêtas comprises) ; menu **Aide → Rechercher une mise à jour**. Sur Windows, elle se télécharge seule et s'installe au redémarrage (menu Aide → « Redémarrer pour installer »). Sur Mac, tant que l'app n'est pas signée par Apple, l'installation automatique est impossible : l'app prévient et renvoie vers la page des versions pour télécharger le nouveau `.dmg` (les shows et médias restent dans Documents).

**Signaler un bug.** Menu **Aide → Signaler un bug…** : le navigateur ouvre un nouveau ticket GitHub déjà rempli (version, système, écrans, fin du journal) ; décrire ce qui s'est passé et envoyer. Le journal complet est dans **Aide → Ouvrir le dossier des journaux** (`regie-led.log`). Sans compte GitHub : envoyer ce fichier et la description par e-mail ou WhatsApp.

### Version navigateur (développeurs)

```bash
node serve.js
```

Sur Mac, un double-clic sur **`Lancer Régie LED.command`** fait la même chose et ouvre Chrome tout seul.

Puis ouvrir **http://localhost:4400** dans **Chrome** (ou Edge). Aucune installation, aucune connexion internet.
Tout reste sur l'ordinateur : le show dans `data/show.json`, les médias dans `media/` (dans le dossier du code, pas dans Documents).

Développement de l'application de bureau : `npm install`, puis `npm run electron` (lance Electron sur le code du dossier, shows et médias dans Documents/Régie LED), `npm run dist` construit les installeurs dans `dist/`, `npm test` lance les tests. Publier une version : changer `version` dans `package.json`, commit, puis `git tag v<version>` et `git push --tags` : GitHub Actions construit les installeurs Mac et Windows et les publie sur la page des versions (pré-version si le tag contient « beta »).

## Branchement

Ordinateur → sortie HDMI → processeur LED (Novastar, Colorlight…) → écrans.

1. Dans les réglages d'affichage de l'ordinateur, mettre la sortie HDMI en **bureau étendu** (pas en recopie).
2. Dans la régie, cliquer **Ouvrir la sortie** : une fenêtre noire s'ouvre. La glisser sur l'écran HDMI si elle n'y est pas, puis cliquer dedans → plein écran.
3. Le voyant en haut à droite passe au vert quand la sortie est en plein écran à la bonne résolution.

La fenêtre de sortie fait son propre rendu : si la régie est rechargée, l'écran LED garde son image.

## Les trois onglets

- **Régie** — médiathèque à gauche (le bouton « ＋ Importer ▾ » ouvre un menu : fichiers de l'ordinateur, capture d'une source, diaporama, fenêtre en direct, texte, horloge, compte à rebours, effet visuel), grille de clips au centre (une ligne = un calque, le calque du haut passe devant), conducteur et réglages à droite.
  Un clic sur un clip le lance avec un fondu. `▶ 1`, `▶ 2`… affichent une colonne **à la place du reste** : les calques sans clip
  dans cette colonne s'arrêtent (sauf ceux réglés sur « Reste affiché quand on lance une autre colonne », pour un fond permanent).
  `Maj`+clic sur `▶ N` envoie la colonne directement à la sortie, même en mode Préparation.
  **Mode Préparation** (case dans Réglages → Show, activé par défaut) : deux écrans, *Préparation* et *Sortie*. Un clic sur un clip
  le prépare dans l'aperçu (case en or) sans toucher au mur ; **« Envoyer à la sortie »** ou la touche `Entrée` le met à l'antenne avec un fondu.
  Désactivé, un clic envoie directement à la sortie. « Noir », « Suivant » (conducteur) et les réglages d'un clip agissent toujours en direct.
  À côté des écrans : « Envoyer à la sortie » et « Tout arrêter » seulement, plus la case **« Formes »** qui affiche ou cache la
  barre Formes (cachée par défaut). Le mode Préparation se coche dans Réglages → Show (actif par défaut), la mire dans Réglages ou Mapping.
  **Formes** (barre sous les écrans, et la même barre dans l'onglet Mapping) : ▭ ◻ ◇ ◯ △ ▽ ⬡ ajoutent une forme avec son calque
  (le carré reste carré quand on l'étire). On la déplace et on l'étire directement sur l'écran de préparation (ou sur la composition
  dans Mapping), on y glisse une vidéo ou une image, et on règle nom, forme, rotation et « Fond noir » dans la barre.
  **✎ Dessiner** : une forme à la main — clique point par point sur l'écran (ou trace en continu en gardant le bouton enfoncé), puis
  reviens sur le premier point, double-clic ou `Entrée` pour fermer (`Retour arrière` enlève le dernier point, `Échap` annule).
  Avec **Aimant**, chaque point se cale sur les bords et le centre de l'image, sur les sommets des autres formes, sur les points déjà
  posés (même x ou même y → traits bien droits) et sur un angle rond (0°, 45°, 90°…) depuis le point précédent ; des guides
  bleus le montrent avant de cliquer. Idéal pour un zigzag ou un escalier : pose les points, ils s'alignent tout seuls.
  **Retoucher une forme dessinée** (sélectionnée) : ses points sont des ronds dorés à tirer (aimant aussi), le petit rond au milieu
  d'un côté ajoute un point, `Alt`+clic sur un point l'enlève. Le cadre, la rotation et les poignées de coin restent disponibles.
  **Plusieurs formes collées = une seule zone** : `Maj`+clic sur les formes à réunir, puis « ⧉ Fusionner en une forme ». La zone
  obtenue est l'union des contours (un seul contenu la remplit, le noir reste entre les morceaux non couverts) ; ses points
  restent modifiables et ses calques sont conservés. « ⤮ Séparer » défait la fusion : chaque morceau redevient une forme
  (le premier garde les calques, un rectangle collé redevient un rectangle).
  La forme obtenue se déplace, s'étire et se tourne comme les autres ; son contour est conservé et masque ce qui dépasse, sur le mur aussi.
  Tout cela marche aussi dans la composition de l'onglet Mapping (même barre, même poignée de rotation, mêmes points).
  Aucun passage par la sortie : une forme est une zone de la composition.
  **Ordre des calques** : ▲ ▼ sur la ligne du calque (▲ = passe devant), ou glisser la ligne sur une autre ; aussi ↑ ↓ dans les réglages du calque.
  **Conducteur** : composer une image avec la grille, puis « Capturer ». Le jour J, la barre d'espace déroule les séquences.
- **Mapping** — à gauche la composition (l'image créée), à droite la sortie HDMI. Une zone par écran LED, découpée dans la composition.
  **Par défaut la sortie est verrouillée** : elle reproduit la composition telle quelle, il n'y a rien à régler à droite.
  La case **« Sortie personnalisée »** débloque le placement de chaque zone dans le signal (position, taille, rotation 90°, miroir,
  « Taille réelle 1:1 », « Coins libres » pour un écran en biais, « Aligner sur la composition » pour tout remettre droit) —
  à n'utiliser que si le processeur attend un écran à un autre endroit du signal que dans l'image.
  La **mire de réglage** affiche le nom de chaque zone sur le vrai mur.
  **Un contenu différent par écran** : dans la zone, « ＋ Calque pour cette zone » crée un calque dont tous les clips
  sont cadrés dans cette zone (réglable aussi par calque ou par clip, champ « Affiché dans »). Un calque sans zone couvre toute l'image.
- **Réglages** — nom du show (affiché aussi en haut, à côté des onglets), « Enregistrer sous… » (copie du show dans un fichier nommé,
  à l'emplacement de son choix — vraie fenêtre d'enregistrement dans Chrome), « Ouvrir un show… », « Nouveau show vide » (vraiment
  vide : un calque, aucune source, **médiathèque vide**), choix de l'écran de sortie, son, raccourcis.
  **Médiathèque par show** : un show créé avec « Nouveau show vide » ne montre que les fichiers importés pour lui. « ✕ » ou
  « Retirer » les enlève du show sans les effacer de l'ordinateur ; « ＋ Importer → Fichiers déjà importés… » reprend un fichier
  importé pour un autre show (ou le supprime définitivement du disque). Les **sources en direct** (carte HDMI, caméra) suivent la
  même règle : rien dans un show neuf tant qu'on ne les reprend pas (« Fichiers déjà importés… » ou « Capturer une source → En direct »). Les shows créés avant cette version voient tout le dossier
  `media`, comme avant, et « Supprimer » y efface le fichier.
  **Taille des écrans** Préparation / Sortie : chaque écran a une poignée dorée dans son coin bas-droit (agrandir, réduire ; la
  largeur suit, en 16:9) ; la poignée sous les écrans agrandit ou réduit les deux ensemble. Double-clic = taille d'origine. Mémorisé.
  Fenêtre étroite : les panneaux et la barre du haut se resserrent (libellés au-dessus des champs) au lieu d'être coupés.
  **Raccourcis** : « ⌨ Voir le clavier » montre tout le clavier, touches utilisées en vert (vif = tes raccourcis, foncé = ceux de
  la régie), libres en gris ; le survol dit ce que fait la touche.
  **Formes** : case « Aimant » (bords et centres se collent à l'image et aux autres formes ; rotation par 15°), poignée ronde au-dessus de
  la forme sélectionnée pour la tourner à la souris.
  **Mapping** : « Taille exacte depuis le pitch LED » (pitch mm + largeur/hauteur en m → pixels de la zone, mémorisés avec la zone) ;
  1 px de la composition = 1 px du processeur quand la sortie est à sa résolution, quel que soit le pitch ; flèches = 1 px.

## Procédure pas à pas (exemple : un losange central + deux petits losanges)

Les écrans LED sont toujours, pour le processeur, des **rectangles de pixels** dans le signal HDMI. Un losange est soit
un écran carré **monté tourné** de 45° (le plus courant), soit un losange « en escalier » dont les panneaux forment la pointe.
Dans les deux cas, lis d'abord dans le logiciel du processeur (NovaLCT, VNNOX, Colorlight…) la **position et la taille en pixels**
de chaque écran dans le signal — par exemple : centre 600 × 600 à (660, 240) ; gauche 300 × 300 à (150, 390) ; droite 300 × 300 à (1470, 390).

1. **Mapping → Sortie HDMI** : mets la résolution du signal envoyé au processeur (souvent 1920 × 1080).
2. **Une zone par écran** (« ＋ Zone ») : nom, puis sa position dans l'image. Si le processeur découpe l'image entière telle quelle, c'est tout.
   Sinon coche **« Sortie personnalisée »** et recopie dans *Sur la sortie* les chiffres du processeur (X, Y, largeur, hauteur).
3. **Dans la composition** : choisis la partie d'image que cet écran montrera (même taille qu'à la sortie pour rester net : bouton « Taille réelle 1:1 »).
   - Écran carré monté en losange → « Sortie personnalisée » + **Rotation de la découpe 45°** (ou −45° si la mire ressort penchée dans l'autre sens).
   - Losange en escalier, cercle, triangle, hexagone → **Forme de l'écran** : la forme masque ce qui dépasse et se voit dans la mire.
4. Coche **Mire de réglage** et regarde le vrai mur : chaque écran doit afficher son nom droit et entier. Ajuste, flèches = 1 px.
5. **Régie** : pour chaque zone, « ＋ Calque pour cette zone » (bouton dans le panneau de la zone). Dépose dans ce calque
   les vidéos, images ou textes de cet écran ; coche « Fond noir dans la zone » si l'écran ne doit rien laisser passer du fond.
   Les calques sans zone (Fond, Titres) couvrent toute l'image : idéal pour un fond commun qui traverse les trois écrans.
6. **Conducteur** : compose chaque moment de la soirée avec la grille, « Capturer », puis barre d'espace le jour J.

## Types de clips

| Clip | Remarques |
|---|---|
| Vidéo | MP4 H.264 conseillé (MOV, WebM acceptés). Boucle, arrêt sur la dernière image, ou enchaînement automatique. Son réglable. |
| Image | PNG avec transparence conservée (logos), JPG, WebP, SVG. |
| Diaporama | Images et vidéos de la médiathèque enchaînées avec un fondu : durée par image, ordre (liste ou aléatoire), boucle / arrêt sur la dernière / séquence suivante. Une vidéo est jouée en entier. Création : cocher plusieurs fichiers dans la médiathèque puis « ▶ Diaporama », ou glisser plusieurs fichiers sélectionnés sur une case ; un fichier déposé sur un diaporama s'y ajoute. La liste « Contenu » (à droite) se réordonne en glissant. |
| Document | PDF, Word, Excel, PowerPoint « en images » : **un seul clip à pages**, listé dans la médiathèque. On tourne les pages avec ◀ ▶ dans ses réglages ou les touches ← → (pages gardées dans `data/documents/<nom>/`). Mac uniquement. |
| Texte | Titre, texte défilant, horloge, compte à rebours. Français et arabe. |
| Caméra / entrée HDMI | Source **en direct** : webcam, ou carte de capture HDMI/USB (l'ordinateur d'un intervenant, une console vidéo…). Se crée depuis « ⏺ Capturer une source » → « 📡 En direct », ou en glissant une source de la médiathèque. Rien n'est enregistré ; on l'envoie sur le mur quand on veut, comme n'importe quel clip. |
| Fenêtre en direct | N'importe quelle fenêtre ou écran de l'ordinateur, capturé en direct (PowerPoint, Keynote, navigateur…). Rognage des bords réglable. |
| Effet visuel | Motifs animés (plasma, bandes, cercles, flash…), synchronisables au tempo. |

Chaque calque a ses effets : luminosité, contraste, teinte, miroir, kaléidoscope, gros pixels, décalage RVB,
stroboscope / pulsation au tempo (bouton **Tap**), réaction au son (bouton **Micro**).

## Sauvegardes du show

À chaque enregistrement, le serveur garde une copie datée dans `data/backups/show-AAAAMMJJ-HHMM.json` (une par minute au plus, les 60
dernières), en plus de `data/show.json.bak` (l'état juste avant la dernière écriture). Pour revenir en arrière : arrêter la régie,
copier la sauvegarde voulue sur `data/show.json`, relancer. Dernier recours si tout a été écrasé : la régie ouverte dans Chrome garde le
show complet dans son `localStorage` (`regieLed.state`, profil Chrome dans `~/Library/Application Support/Google/Chrome/<profil>/Local
Storage/leveldb`) : faire n'importe quelle petite modification dans la régie (sans la recharger) la réenregistre en entier.

## Scènes

Une **scène** = une grille de sources (calques, cases, colonnes). La barre « Scènes » au-dessus de la grille les liste : clic = ouvrir,
« ＋ » = nouvelle scène vide, « ✎ » renommer, « ⧉ » dupliquer, « ✕ » supprimer. Les clips, les zones et le mapping sont communs ; les
séquences du conducteur retiennent leur scène et l'ouvrent quand on les lance. **La sortie garde sa scène** (point rouge sur l'onglet)
jusqu'à « Envoyer » : on peut préparer la scène suivante pendant que la précédente est sur le mur. `show.scenes[]`, `show.sceneId`
(scène ouverte : `show.layers / cells / cols` sont ses tableaux), `live.sceneId` (scène à la sortie, rendue par le moteur).

## Raccourcis personnalisés

Réglages → Raccourcis clavier → **Mes raccourcis** : choisir une action (lancer un clip, afficher une colonne, envoyer, séquence
suivante / précédente / précise, ouvrir une scène, noir, tout arrêter, arrêter ou masquer un calque, tap tempo), sa cible, puis
« ⌨ Touche… » et appuyer sur la touche ou combinaison voulue (⇧ ⌥ ⌘ acceptés, F1…F12 aussi). Dans les réglages d'un clip, « Raccourci »
fait la même chose pour ce clip. Un raccourci personnalisé passe avant les raccourcis d'origine et marche **depuis n'importe quelle
scène**. Pour une colonne ou un calque, il vise une **scène précise** (choisie dans le formulaire, par défaut la scène ouverte) : si une
autre scène est ouverte au moment de l'appui, la régie ouvre d'abord la bonne scène puis agit. Une touche ne porte qu'un raccourci.
Stockés dans `show.keys[]` (`{code, shift, alt, meta, action, target, scene}` ; `scene` vide = scène ouverte au moment de l'appui).

## Son

Le son sort **par la fenêtre de sortie** (jamais par la régie, qui reste muette), vers le périphérique choisi dans **Réglages → Son**
(« Détecter les sorties son » : prise casque, interface audio USB reliée à la console, TV par HDMI…). Par défaut : la sortie son du Mac.
- **Vidéo importée** : réglage « Son (volume) » du clip, à 1 pour les nouvelles vidéos (0 = muette). Les anciens clips gardent leur réglage.
- **Source en direct (carte HDMI, caméra)** : dans les réglages du clip, cocher « Reprendre aussi le son » ; l'entrée audio de la même
  carte est choisie automatiquement (sinon la choisir dans « Entrée audio »), puis régler le volume. Le son est repris tel quel (sans
  traitement « voix »).
- Si Chrome bloque le son (règle des navigateurs), le voyant de sortie l'indique : un clic dans la fenêtre de sortie le débloque.
- Le son **suit le fondu** : quand une image remplace la vidéo, le son baisse avec l'image et se coupe à la fin du fondu.
- **Vumètres** : dans la liste « Sortie » (à droite des écrans), une petite barre par calque qui joue une vidéo, une source en direct ou
  une fenêtre capturée = le niveau **réellement entendu sur le mur**, mesuré dans la fenêtre de sortie (`js/meter.js`, copie du signal
  par `captureStream`, chemin audible inchangé ; envoyé par BroadcastChannel `levels`). Dans les réglages du clip, section
  « Niveau sonore » : « À la sortie » (le même), et un vumètre local — « Aperçu » pour une vidéo (pendant qu'on la fait jouer dans
  l'aperçu), « Entrée » pour une source en direct avec son (le signal qui arrive sur l'entrée audio, même sans envoyer le clip),
  « Capture » pour une fenêtre capturée avec son. Les navigateurs exigent un clic dans la fenêtre de sortie avant toute mesure.
- **Fenêtre capturée / PowerPoint en direct** : Chrome ne fournit le son que pour un onglet ou un écran entier (case « Partager l'audio »),
  pas pour une simple fenêtre. Le son d'un PowerPoint joué par PowerPoint sort donc directement de PowerPoint vers la sortie son du Mac,
  sans passer par la régie ni par ses vumètres. Pour le faire passer par la régie : capturer **l'écran entier** avec l'audio.

## Compte à rebours : démarre à l'envoi

Comme une vidéo, un compte à rebours « en attente » (case cochée par défaut dans ses réglages) affiche son temps de départ dans
l'écran Préparation et ne décompte qu'au moment où il passe à la sortie ; la préparation se cale alors sur le mur. Décoché, il
décompte dès son lancement en préparation. Le mode « jusqu'à une heure précise » n'est pas concerné.

## Pause, reprise, recommencer

Sur la case d'un clip qui a une horloge (compte à rebours, vidéo, diaporama, effet, bandeau) et qui est en cours (préparé ou à la
sortie), deux boutons à gauche : **⏸ / ▶** (pause / reprise) et **↺** (recommencer). Pour un compte à rebours « en attente », ↺ le remet à
son temps de départ et le laisse figé jusqu'au prochain « Envoyer à la sortie » (ou ▶), même s'il est déjà sur le mur.
Dans les réglages d'un clip en cours (compte à rebours, bandeau défilant, vidéo, diaporama, effet), la ligne **« Lecture »** propose
**⏸ Pause / ▶ Reprendre** et **↺ Recommencer**. La pause fige le clip là où il joue (préparation et/ou sortie, en même temps dans la
régie et sur le mur : `pausedAt` dans l'état de lecture, l'heure de lancement est décalée à la reprise) ; la case affiche ⏸. L'horloge
continue toujours. Actions de raccourci « Pause / reprise du clip sélectionné » et « Recommencer le clip sélectionné ».

## Vidéo : aperçu, point de début / fin, saut de position

Dans les réglages d'un clip vidéo, **« Aperçu et découpe »** : un petit lecteur muet (il ne touche pas au mur). On avance dedans et on
le met en **pause** là où la vidéo doit démarrer : c'est le point de départ (`start`), et la vignette de la case montre cette image.
« Fin = position » découpe la fin (`stop`) ; la boucle, l'arrêt sur la dernière image et la suite automatique respectent cette portion ;
« Toute la vidéo » annule. Lancée en **Préparation**, la vidéo reste **figée sur son point de départ** (case « attendre l'envoi », cochée
par défaut) et ne démarre, depuis ce point, qu'au moment où elle passe à la sortie ; la préparation joue alors en même temps que le mur.
Quand le clip est en cours, **« ▶ Sauter à la position de l'aperçu »** fait sauter la lecture à cet instant, régie et mur ensemble.

## Onglet Outputs : toutes les sorties en direct

L'onglet **Outputs** (à côté de Réglages) montre une vignette vivante par sortie : la **MASTER** (spectateurs, avec le mapping)
et chaque autre sortie (retours, autres salles), telle qu'elle est envoyée sur son écran, calques masqués compris. Sur chaque
carte : le nom, l'état de la fenêtre (fermée, résolution, i/s), « Ouvrir / Rouvrir », ce qu'elle montre (toute la composition ou
une zone en plein cadre) et les calques visibles (pastilles vertes = visibles, clic pour masquer). « ＋ Sortie » en ajoute une.

Chaque carte (et chaque sortie dans Réglages) a aussi son **écran** : dans l'application de bureau, la liste des écrans branchés
(« Automatique », un écran précis ou « Fenêtre simple ») ; une sortie déjà ouverte y est déplacée tout de suite, et le choix est
retenu par sortie (`reglages-bureau.json` → `outputDisplays`). Dans Chrome, après « Détecter les écrans ».

## Coins libres dans la composition

Barre Formes (ou panneau d'une zone dans Mapping) → **« ⬚ Coins libres »** : chaque coin de la forme se déplace seul (ronds dorés),
pour un écran en biais, en trapèze ou vu en perspective. Le contenu de la zone est déformé pour remplir le quadrilatère (homographie,
dans le moteur `u_zq` côté composition et `u_sq` côté sortie), la sortie suit, et une sortie « zone en plein cadre » remet l'image
droite. L'aimant cale chaque coin. Les 4 coins se règlent aussi au pixel dans le panneau de la zone. Re-cliquer redonne un rectangle.

## Plusieurs sorties (LED, retour conférenciers, autre salle)

Réglages → **Sorties (écrans)** : la sortie principale (« LED principale », avec le mapping et le son) et autant d'autres sorties
que d'écrans à alimenter (« ＋ Sortie » : retour conférenciers, salle B…). Pour chaque sortie secondaire :
- **ce qu'elle montre** : toute la composition, ou une zone (une forme) en plein cadre — le conférencier voit sa diapo entière ;
- **son écran** (après « Détecter les écrans ») et le bouton **Ouvrir** : une fenêtre `output.html?out=<id>` s'ouvre sur cet écran,
  un clic dedans la met en plein écran. Elle remplit l'écran quelle que soit sa résolution (bandes noires si les proportions diffèrent) ;
- **les calques visibles** : dans les réglages de chaque calque, « Visible sur » coche ou décoche la sortie (ex. : effets et logo
  absents du retour). Un calque masqué quelque part est marqué ⊘ dans la grille.
Rien ne change dans la façon de lancer : un seul clic, une seule préparation, un seul « Envoyer ». Les fenêtres partagent la même
horloge, donc tout est synchrone ; le son ne sort que par la sortie principale. Dans la régie, le menu sur l'écran « Sortie » permet de
regarder ce que voit une sortie secondaire. L'indicateur en haut compte les sorties ouvertes.
Physiquement : une sortie HDMI de l'ordinateur par contenu différent (bureau étendu), un splitter HDMI pour les écrans qui montrent
la même image, des extendeurs HDMI sur câble réseau au-delà de 10 m.

## Médiathèque : sources en direct

En haut de la médiathèque, **« Sources en direct »** liste les cartes de capture HDMI/USB et caméras externes : elles apparaissent
toutes seules dès qu'on les branche (une fois l'accès caméra autorisé dans Chrome), après « Capturer une source », ou avec « ↻ Détecter ».
La liste est mémorisée. La caméra intégrée de l'ordinateur (FaceTime) n'est listée que si on s'en est servi. Chaque source se glisse
sur une case de la grille ou sur une forme (ou double-clic) : cela crée un clip **Caméra / entrée HDMI** qui reprend l'image en temps
réel. « non détectée » = la source n'est pas branchée en ce moment ; « ✕ » la masque (elle revient si on l'utilise à nouveau).

## Éléments créés (texte, horloge, compte à rebours, effet, diaporama, fenêtre en direct, source en direct)

Depuis le menu « ＋ Importer ▾ » (ou « Capturer une source » → « En direct »), un élément créé **ne va pas dans la grille** : il est
rangé dans la médiathèque, section **« Éléments »** (`show.pool`, ids de clips gardés par `pruneClips`). Un clic ouvre ses réglages à
droite ; on le glisse ensuite sur une case ou une forme (ou double-clic) : une **copie** est posée, l'original reste disponible pour
d'autres cases. « ✎ » renomme, « ✕ » le retire de la médiathèque (les copies posées restent).

## Renommer

Dans la médiathèque, le crayon « ✎ » (visible au survol, à côté du ✕) renomme un fichier (le fichier est renommé dans `media/` et tous
les clips et diaporamas qui l'utilisent, dans toutes les scènes, suivent), un document, un PowerPoint en direct (relancer le diaporama
s'il est ouvert) ou une source en direct (nom affiché à la place du nom technique, mémorisé). Une scène se renomme par un double-clic
sur son onglet, ou avec « ✎ » dans la barre des scènes. Un clip se renomme dans ses réglages (« Nom »). API : `POST /api/rename?kind=media|ppt|doc&name=&to=`.

## Médiathèque : sélection multiple

Chaque fichier a une case à cocher (visible au survol). Clic = ce fichier seul, `⌘`/`Ctrl`+clic = ajouter ou retirer, `Maj`+clic = plage, « ☑ Tout » en bas.
La barre qui apparaît permet de **supprimer** les fichiers cochés d'un coup (ou touche `Suppr`), de les **poser dans la grille**
ou d'en faire un **diaporama**. Glisser un fichier coché en glisse plusieurs : sur une case → diaporama, sur un diaporama → ajoutés.
« Importer » accepte aussi plusieurs fichiers à la fois.

## Capturer une source externe (vidéo ou photo dans la médiathèque)

Bouton **« ⏺ Capturer une source »** : choisir une caméra ou une **carte de capture HDMI/USB** (console vidéo, caméra pro, lecteur, ordinateur
invité…) ou une **fenêtre / un écran** de l'ordinateur, vérifier l'image, puis **« ⏺ Enregistrer »** / **« ■ Arrêter »** ou **« 📷 Photo »**.
Le fichier (MP4 H.264 si Chrome sait l'écrire, sinon WebM ; photo en JPG) est rangé dans `media/` et apparaît aussitôt dans la médiathèque.
Case « Son » : entrée audio de la même carte (ou micro de la caméra), ou son de la fenêtre partagée.
**« 📡 En direct »** dans cette même fenêtre crée un clip **Caméra / entrée HDMI** (ou Fenêtre en direct) avec la source choisie : rien
n'est enregistré, la source est reprise en temps réel et c'est la régie qui décide quand elle passe sur le mur. Cas typique : l'ordinateur
d'un intervenant branché sur la carte de capture HDMI — on voit son écran dans la Préparation et on l'envoie quand on veut.

## Import de documents (PowerPoint, Word, Excel, PDF)

Déposer le fichier dans la médiathèque (ou « Importer »). Le document arrive **dans la médiathèque seulement** (rien n'est posé
dans la grille) : on le glisse ensuite sur une case ou une forme.
Un **PDF** est lu par la régie elle-même avec pdf.js (`js/pdf.min.js` + `js/pdf.worker.min.js`, copiés de `pdfjs-dist`) : même
résultat sur Mac et Windows, une image JPEG par page, envoyée au serveur (`/api/doc-page` puis `/api/doc-done`).
Un fichier **Office** est converti par l'application installée, que la régie pilote (elle s'ouvre un instant) :
- Mac : `tools/office2pdf.applescript` (PDF) puis `tools/pdf2img.js`. La première fois, macOS demande d'autoriser ce pilotage : répondre OK.
- Windows : PowerPoint exporte ses diapositives en images (`tools/pptexport.ps1`) ; Word et Excel exportent un PDF
  (`tools/office2pdf.ps1`), renvoyé à la régie qui le lit avec pdf.js.
Ce sont des images fixes : ni animations, ni vidéos intégrées. Pour garder les animations d'un PowerPoint, l'exporter en MP4.

**Windows : « ENOENT » ou « EPERM » à l'import.** Le dossier Documents est souvent protégé (Sécurité Windows → Protection contre
les ransomwares → accès contrôlé aux dossiers) ou redirigé vers OneDrive. Au démarrage, l'application vérifie qu'elle peut écrire
dans « Documents/Régie LED » ; sinon elle range shows et médias dans le dossier personnel (« C:\Users\<nom>\Régie LED ») et le dit
une fois. Pour garder Documents : autoriser Régie LED dans la protection contre les ransomwares.

## Plus de place pour la grille

« ‹ » dans l'en-tête de la Médiathèque et « › » dans celui du Conducteur masquent ces panneaux : il reste une fine bande verticale
(« Médiathèque » à gauche, « Conducteur » à droite) qui les rouvre d'un clic. Mémorisé ; raccourci « Masquer / afficher les panneaux
latéraux ». Une scène peut avoir jusqu'à **20 calques**.

## Espace disque : pas de doublon, nettoyage

- **Import sans doublon** : à l'envoi d'un fichier, la régie calcule son empreinte (SHA-256). Si un fichier au contenu identique est
  déjà dans `media` (même sous un autre nom), il est réutilisé et rien n'est copié.
- **Réglages → Espace disque** : taille du dossier (médias, documents, PowerPoint), **« Supprimer les doublons »** (un seul fichier
  gardé par contenu ; les anciens noms continuent de marcher pour tous les shows grâce à des alias), et **« Mettre à la corbeille »**
  les fichiers inutilisés depuis 7 / 30 / 60 / 90 / 180 jours. « Utilisé » = dans le show en cours ou dans un show ouvert pendant cette
  période (chaque enregistrement d'un show met à jour la date de ses fichiers, `data/fichiers.json`).
- **Nettoyage automatique** (désactivé par défaut) : au démarrage, mise à la corbeille des fichiers inutilisés depuis N jours.
- Les fichiers enlevés vont dans la **corbeille de l'ordinateur** (application de bureau) ou dans `data/corbeille` (navigateur) :
  récupérables.

## Mises à jour

Au démarrage, l'application cherche une nouvelle version (aussi : menu Aide). La nouvelle version **remplace** l'ancienne :
- Windows : téléchargée en arrière-plan ; « Redémarrer maintenant » (ou la fermeture) lance l'installeur en silence, qui désinstalle
  l'ancienne version et installe la nouvelle, puis la régie redémarre.
- Mac : « Installer maintenant » télécharge l'archive .zip de la release, et après la fermeture un petit script remplace
  « Regie LED.app » dans Applications (l'ancienne est gardée de côté et remise en place si la copie échoue), puis relance
  (`electron/updater.js`, fonctionne sans signature Apple). Si l'application n'est pas dans un dossier modifiable, ou tourne depuis
  un emplacement temporaire de macOS, la régie propose le .dmg à la place. Shows et médias ne sont jamais touchés.

## Transition de « Envoyer à la sortie »

Sous le bouton « Envoyer à la sortie » : **Fondu** (durée réglable en secondes, 0,5 s par défaut) ou **Coupure** (changement instantané).
Ce choix s'applique à tout ce que part avec « Envoyer » (ou la touche Entrée) et il est enregistré dans le show. Les séquences
lancées par Espace / « Suivant » gardent leur propre « Fondu d'entrée ».

## Ordre des séquences

Dans la liste du conducteur, on **glisse une séquence** au-dessus ou au-dessous d'une autre (un trait doré montre où elle va) ;
↑ ↓ dans ses réglages marchent aussi. La séquence à l'antenne et celle qui est préparée restent les mêmes après le déplacement.

## Plusieurs conducteurs

En haut du panneau Conducteur, un menu choisit le **conducteur ouvert** (« Jour 1 », « Jour 2 », « Plan B »…) : chacun a sa propre liste
de séquences et retient sa position, tous partagent la même grille, les mêmes scènes et les mêmes médias. Espace / « Suivant »
déroule le conducteur ouvert ; en changer ne coupe rien à l'écran. Boutons ＋ (nouveau), ✎ (renommer), ⧉ (dupliquer, pratique pour
un plan B), ✕ (supprimer). Raccourcis : « Ouvrir un conducteur », et « Aller à une séquence » ouvre au besoin le bon conducteur.

## Son de sortie coupé

Bouton **« 🔊 Son »** dans la barre du haut (à côté de « Noir ») : coupe tout le son de sortie (vidéos, sources en direct), sur toutes
les sorties, sans toucher à l'image ; il passe en rouge « 🔇 Muet ». Un raccourci « Couper / rétablir le son de sortie » est disponible.

## Arrêter / reprendre une capture (PowerPoint en direct, fenêtre)

Dans les réglages d'un clip « Fenêtre en direct » ou PowerPoint en direct : **« ⏸ Arrêter la capture »** lâche la fenêtre (la case
devient noire ; confirmation si le clip est à l'antenne). Le diaporama reste ouvert dans PowerPoint, à la même diapositive.
**« ▶ Reprendre la capture »** la rattache : dans l'application Régie LED, la même fenêtre est retrouvée toute seule (titre
« Diaporama PowerPoint – <fichier> », ou le titre exact noté à la capture), sans fenêtre de choix ; dans Chrome, on la resélectionne.
Si le diaporama a été fermé : « Relancer le diaporama », puis « Reprendre la capture ».

## PowerPoint en direct (animations et vidéos conservées)

À l'import d'un `.pptx`, choisir **« En direct »** : la régie garde le fichier (`data/presentations/`), l'ouvre dans PowerPoint et lance
le diaporama **dans une fenêtre** (1280 × 768 points). Un clip « Fenêtre en direct » est créé ; il reste à cliquer
**« Choisir la fenêtre à afficher »** et à désigner « Diaporama PowerPoint » dans la liste de Chrome (à refaire après un rechargement
de la régie). Les boutons Précédent / Suivant du clip, ou les touches ← →, pilotent PowerPoint (`tools/pptlive.applescript` sur Mac,
`tools/pptlive.ps1` sur Windows, par automation COM : même fonctionnement, fenêtre rangée sous le bord bas de l'écran, barre de titre rognée).
La barre de titre de la fenêtre est rognée automatiquement. À savoir : PowerPoint doit rester ouvert, sa fenêtre ne doit pas être
réduite dans le Dock, la sortie reçoit la capture de la régie (directement, ou par un relais vidéo local — `js/relay.js`),
et Chrome doit être autorisé dans Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran.

**Une capture ne part jamais seule sur le mur** : la fenêtre choisie arrive dans l'écran Préparation (ou nulle part si le mode
Préparation est coupé) ; c'est « Envoyer », un clic sur le clip, une colonne ou le conducteur qui la met à la sortie. Pendant que le
sélecteur de fenêtre est ouvert, les raccourcis de la régie (Entrée, Espace, 1…9) sont ignorés.

**La souris dans la capture** : Chrome inclut le curseur dans la capture d'une fenêtre, sans réglage possible, et cela vaut aussi quand
la fenêtre est cachée derrière la régie : dès que la souris survole l'endroit où se trouve la fenêtre PowerPoint, elle apparaît sur le mur.
La régie **range donc la fenêtre du diaporama** (à l'ouverture, ou commande `park` du script) **sous le bord bas de l'écran de
l'ordinateur** : seule sa barre de titre reste visible, juste au-dessus du Dock, et elle ne va jamais sur l'écran des spectateurs.
ScreenCaptureKit capture la fenêtre même hors champ. Le pointeur du diaporama est aussi mis en « toujours masqué ». Ne pas remonter
cette fenêtre à la main (si c'est fait, « Relancer le diaporama » la range à nouveau) ; éviter de laisser la souris sur sa barre de titre.
Pour une autre fenêtre capturée (Keynote, navigateur…), la placer de la même façon.
Conseil : **mettre la sortie en plein écran** (un clic dans la fenêtre de sortie) — rien ne peut alors passer devant elle sur la TV.

**Le sélecteur s'affiche aussi sur l'écran des spectateurs** : sur macOS 15, Chrome utilise le sélecteur du système, qui pose
« Partager cette fenêtre » / « Partager cet écran » sur toutes les fenêtres de tous les écrans, y compris la sortie LED. Deux parades :
choisir la fenêtre **avant** l'événement (le choix reste valable tant que la régie n'est pas rechargée et que PowerPoint reste ouvert),
ou désactiver ce sélecteur dans Chrome : `chrome://flags`, chercher « ScreenCaptureKit picker » (*Use ScreenCaptureKit picker for
stream selection*), mettre sur **Disabled**, relancer Chrome — Chrome affiche alors son propre sélecteur, dans la fenêtre de la régie seulement.

## Raccourcis

`Espace` séquence suivante · `Entrée` envoyer la préparation à la sortie · `1`…`9` lancer une colonne · `B` écran noir · `T` taper le tempo ·
`F` plein écran (fenêtre de sortie) · flèches = déplacer une zone de mapping de 1 px (`Maj` = 10 px).

## Code

- `serve.js` — serveur local sans dépendance (fichiers, médias avec lecture partielle, enregistrement du show). Écoute sur 127.0.0.1 uniquement.
- `js/model.js` — modèle de données, valeurs par défaut, géométrie du mapping (homographie).
- `js/engine.js` — moteur de rendu WebGL2, identique dans la régie (aperçu) et dans la sortie.
- `js/sources.js` — sources d'image : vidéo, image, diaporama (fondu entre images/vidéos dans sa propre texture, horloge commune régie/sortie), caméra, texte, effets.
- `js/app.js` — interface de régie. `js/mapping.js` — éditeur de mapping. `js/output.js` — fenêtre de sortie.
- `npm test` — tests du modèle et de la géométrie.

La régie et la sortie se parlent par `BroadcastChannel` : elles doivent tourner dans le même navigateur, sur le même ordinateur.

## Limites connues

- Pas encore testé sur un vrai processeur LED ni avec de longues vidéos 4K.
- ProRes, HAP et les vidéos avec couche alpha ne sont pas lus par le navigateur.
- Pas de masques arrondis ni de fondu de bord entre zones ; pas de NDI / Syphon / DMX / MIDI.
