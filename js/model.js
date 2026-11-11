/* Régie LED — modèle de données partagé par la régie et la fenêtre de sortie.
 *
 * show = {
 *   name, cols, bpm,
 *   comp:   {w,h}  — la « composition » : l'image que l'on crée (px)
 *   output: {w,h}  — la sortie HDMI envoyée au processeur LED (px)
 *   layers: [{id,name,opacity,blend,fade,mute,fx}]      index 0 = calque du fond
 *   clips:  {id: {id,type:'video'|'image'|'slideshow'|'camera'|'screen'|'text'|'gen', name, …}}   ('screen' = fenêtre ou écran capturé en direct)
 *           'slideshow' = diaporama : items:[{src,type,name}], dur (s par image), fade (s), order 'seq'|'random', end 'loop'|'hold'|'next'
 *   cells:  {layerId: [clipId|null, …]}                  la grille (calques × colonnes)
 *   cues:   [{id,name,layers:{layerId: clipId|null},fade,auto}]   le conducteur
 *   slices: [{id,name,on,shape,custom,src:{x,y,w,h,rot} (px composition), dst:[[x,y]×4] (px sortie : HG,HD,BD,BG)}]
 *   customOut : false = la sortie HDMI est la composition telle quelle ; true = chaque zone est posée à son `dst`
 *   master: {opacity}
 * }
 * live = { layers:{layerId:{clipId,t0,fade}}, blackout, test, cue, beat0 }   — ce qui joue maintenant
 */

export const uid = () => Math.random().toString(36).slice(2, 9);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const BLENDS = [['normal', 'Normal'], ['add', 'Addition'], ['screen', 'Écran'], ['multiply', 'Multiplier']];
export const FITS = [['cover', 'Remplir (rogner)'], ['contain', 'Ajuster (entier)'], ['stretch', 'Étirer']];
export const MIRRORS = [[0, 'Aucun'], [1, 'Gauche ↔ droite'], [2, 'Haut ↕ bas'], [3, 'Quatre coins'], [4, 'Kaléidoscope']];
export const STROBES = [[0, 'Arrêté'], [1, '1 par temps'], [2, '2 par temps'], [4, '4 par temps'], [8, '8 par temps']];
export const GENS = [
  ['uni', 'Couleur unie'], ['degrade', 'Dégradé animé'], ['barres', 'Bandes verticales'], ['lignes', 'Bandes horizontales'],
  ['plasma', 'Plasma'], ['tunnel', 'Cercles'], ['damier', 'Damier'], ['balayage', 'Balayage'], ['neige', 'Neige'], ['flash', 'Flash au tempo'],
];
export const FONTS = ['Helvetica Neue', 'Arial', 'Arial Black', 'Avenir Next', 'Futura', 'Impact', 'Georgia', 'Didot', 'Baskerville',
  'Snell Roundhand', 'Zapfino', 'Brush Script MT', 'Courier New', 'Geeza Pro', 'Al Nile', 'Damascus', 'Baghdad'];

export const FX_DEFAULT = { bri: 1, con: 1, sat: 1, hue: 0, inv: 0, mirror: 0, pix: 0, rgb: 0, tint: '#ffb300', tintAmt: 0, strobe: 0, pulse: 0, zoom: 0, audio: 0 };

export function newLayer(name) {
  return { id: uid(), name, opacity: 1, blend: 'normal', fade: 0.5, mute: false, zone: '', opaque: false, keep: false, fx: { ...FX_DEFAULT } };
}

const CLIP_BASE = { fit: 'cover', scale: 1, x: 0, y: 0, rot: 0, zone: '', cropL: 0, cropR: 0, cropT: 0, cropB: 0 };   // zone : '' = comme le calque, 'all' = toute l'image, sinon id de zone
export function newClip(type, extra = {}) {
  const c = { id: uid(), type, name: '', ...CLIP_BASE };
  if (type === 'video') Object.assign(c, { src: '', end: 'loop', speed: 1, volume: 1, start: 0, stop: 0, hold: true });   // volume : son par la fenêtre de sortie (0 = muet) ; start/stop : portion lue (s, 0 = tout) ; hold : en préparation, figée sur `start` jusqu'à l'envoi
  if (type === 'image') Object.assign(c, { src: '' });
  if (type === 'slideshow') Object.assign(c, { name: 'Diaporama', fit: 'contain', items: [], dur: 5, fade: 1, order: 'seq', end: 'loop', volume: 0 });
  if (type === 'camera') Object.assign(c, { name: 'Caméra', deviceId: '', deviceLabel: '', audio: false, audioDeviceId: '', audioLabel: '', volume: 1 });   // audio : reprendre aussi le son de la source (entrée audio de la carte)
  if (type === 'text') Object.assign(c, {
    name: 'Texte', mode: 'text', text: 'Bienvenue', font: 'Helvetica Neue', size: 14, bold: true, color: '#ffffff',
    align: 'center', valign: 'middle', outline: false, shadow: true, bg: 'none', bgColor: '#000000', bgAlpha: 0.6,
    scroll: false, scrollSpeed: 1, secs: true, cdMode: 'duree', cdMin: 5, cdTime: '20:00', cdEnd: '', hold: true,   // hold : compte à rebours figé en préparation, démarre à l'envoi
  });
  if (type === 'doc') Object.assign(c, { name: 'Document', fit: 'contain', doc: '', pages: 0, page: 0 });   // document à pages ; page = page affichée (à partir de 0)
  if (type === 'screen') Object.assign(c, { name: 'Fenêtre en direct', fit: 'contain', ppt: '', volume: 1 });   // ppt : fichier PowerPoint piloté par la régie ; volume : son de la capture, s'il y en a un
  if (type === 'gen') Object.assign(c, { name: 'Effet', kind: 'plasma', colorA: '#ffb300', colorB: '#1a0033', transp: false, speed: 1, density: 1, sync: false });
  return Object.assign(c, extra);
}

/** Contenu d'un diaporama, nettoyé : une image ou une vidéo de la médiathèque par entrée. */
export function slideshowItems(list) {
  return (Array.isArray(list) ? list : []).filter(i => i && typeof i.src === 'string' && i.src)
    .map(i => ({ src: i.src, type: i.type === 'video' ? 'video' : 'image', name: String(i.name || '') }));
}

/* Formes prédéfinies d'écran : masque appliqué à la zone sur la sortie (et dessiné dans la mire / l'éditeur). */
export const SHAPES = [['rect', 'Rectangle'], ['carre', 'Carré'], ['losange', 'Losange'], ['cercle', 'Cercle / ovale'], ['triangle', 'Triangle ▲'], ['triangle2', 'Triangle ▼'], ['hexagone', 'Hexagone']];
// Index du masque dans les shaders (0 = aucun masque : rectangle et carré ; 6 = forme libre dessinée à la main, masque = texture).
export const SHAPE_INDEX = { rect: 0, carre: 0, losange: 1, cercle: 2, triangle: 3, triangle2: 4, hexagone: 5, libre: 6 };
/** Une forme libre valide : au moins 3 points (u, v) dans le carré unité. */
export const validPoly = poly => Array.isArray(poly) && poly.length >= 3 && poly.every(p => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1]));
/** Choix de forme proposés pour une zone : les formes prédéfinies, plus « Forme libre » si la zone en a une. */
export function shapeOptions(z) { return z?.shape === 'libre' && validPoly(z.poly) ? [...SHAPES, ['libre', 'Forme libre (dessinée)']] : SHAPES; }
/** Tous les contours d'une zone dans le carré unité : la forme prédéfinie, ou le polygone dessiné + les formes collées (`extra`). */
export function shapeGroups(z) { return z?.shape === 'libre' && validPoly(z.poly) ? [shapePoints('libre', z.poly), ...(z.extra || []).filter(validPoly).map(g => shapePoints('libre', g))] : [shapePoints(z?.shape)]; }
/** Contour de la forme dans le carré unité (u vers la droite, v vers le bas). `poly` = points d'une forme libre. */
export function shapePoints(shape, poly) {
  if (shape === 'libre' && validPoly(poly)) return poly.map(p => [clamp(+p[0], 0, 1), clamp(+p[1], 0, 1)]);
  if (shape === 'losange') return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  if (shape === 'triangle') return [[0.5, 0], [1, 1], [0, 1]];
  if (shape === 'triangle2') return [[0, 0], [1, 0], [0.5, 1]];
  if (shape === 'hexagone') return [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]];
  if (shape === 'cercle') return Array.from({ length: 48 }, (_, i) => { const a = i / 48 * Math.PI * 2; return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]; });
  return [[0, 0], [1, 0], [1, 1], [0, 1]];
}

export function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }
export function newSlice(show, name) {
  return { id: uid(), name: name || 'Zone ' + ((show.slices?.length || 0) + 1), on: true, shape: 'rect',
    src: { x: 0, y: 0, w: show.comp.w, h: show.comp.h, rot: 0 }, dst: fullQuad(show.output.w, show.output.h) };
}

/** Show vraiment vide : un seul calque, aucune source, une zone plein cadre. */
export function emptyShow(name = 'Nouveau show') {
  const layers = [newLayer('Calque 1')];
  const show = {
    name, cols: 8, bpm: 120, comp: { w: 1920, h: 1080 }, output: { w: 1920, h: 1080 },
    layers, clips: {}, cells: {}, cues: [], slices: [], master: { opacity: 1 }, customOut: false, keys: [], pool: [], files: [],   // files: [] = médiathèque vide
  };
  for (const l of layers) show.cells[l.id] = Array(show.cols).fill(null);
  show.scenes = [{ id: uid(), name: 'Scène 1', layers: show.layers, cells: show.cells, cols: show.cols }];
  show.sceneId = show.scenes[0].id;
  show.slices.push(newSlice(show, 'Écran principal'));
  return show;
}
export function defaultShow() {
  const layers = [newLayer('Fond'), newLayer('Média'), newLayer('Titres')];
  const show = {
    name: 'Nouveau show', cols: 8, bpm: 120, comp: { w: 1920, h: 1080 }, output: { w: 1920, h: 1080 },
    layers, clips: {}, cells: {}, cues: [], slices: [], master: { opacity: 1 }, customOut: false, keys: [], pool: [],
  };
  for (const l of layers) show.cells[l.id] = Array(show.cols).fill(null);
  show.scenes = [{ id: uid(), name: 'Scène 1', layers: show.layers, cells: show.cells, cols: show.cols }];
  show.sceneId = show.scenes[0].id;
  show.slices.push(newSlice(show, 'Écran principal'));
  // Quelques clips prêts à l'emploi pour ne pas démarrer devant une grille vide.
  const put = (li, col, clip) => { show.clips[clip.id] = clip; show.cells[layers[li].id][col] = clip.id; };
  put(0, 0, newClip('gen', { name: 'Plasma or', kind: 'plasma', colorA: '#ffb300', colorB: '#2a0d00' }));
  put(0, 1, newClip('gen', { name: 'Dégradé bleu', kind: 'degrade', colorA: '#0a5cff', colorB: '#060024' }));
  put(0, 2, newClip('gen', { name: 'Bandes', kind: 'barres', colorA: '#ffffff', colorB: '#000000', sync: true }));
  put(2, 0, newClip('text', { name: 'Bienvenue', text: 'Bienvenue' }));
  put(2, 1, newClip('text', { name: 'Horloge', mode: 'clock', size: 22 }));
  put(2, 2, newClip('text', { name: 'Compte à rebours', mode: 'countdown', size: 26, cdMin: 5 }));
  return show;
}

/** Complète un show chargé (fichier ancien ou incomplet) pour que le reste du code n'ait rien à vérifier. */
export function normalizeShow(s) {
  const d = defaultShow();
  if (!s || typeof s !== 'object' || !Array.isArray(s.layers) || !s.layers.length) return d;
  const show = { ...s };
  show.name = String(show.name || 'Show');
  show.cols = clamp(Math.round(+show.cols || 8), 1, 32);
  show.bpm = clamp(+show.bpm || 120, 20, 300);
  const dim = (o, dw, dh) => ({ w: clamp(Math.round(+o?.w || dw), 16, 16384), h: clamp(Math.round(+o?.h || dh), 16, 16384) });
  show.comp = dim(show.comp, 1920, 1080);
  show.output = dim(show.output, 1920, 1080);
  show.master = { opacity: clamp(+(show.master?.opacity ?? 1), 0, 1) };
  show.customOut = show.customOut === true;      // false : la sortie reproduit la composition telle quelle
  show.audioOut = typeof show.audioOut === 'string' ? show.audioOut : '';          // périphérique de sortie du son ('' = celui du Mac)
  show.audioOutLabel = typeof show.audioOutLabel === 'string' ? show.audioOutLabel : '';
  show.clips = show.clips && typeof show.clips === 'object' ? show.clips : {};
  for (const [id, c] of Object.entries(show.clips)) {
    if (!c || !c.type) { delete show.clips[id]; continue; }
    show.clips[id] = { ...newClip(c.type), ...c, id };
    if (c.type === 'slideshow') show.clips[id].items = slideshowItems(c.items);
  }
  // Scènes : chaque scène a sa propre grille (calques + cases + nb de colonnes). show.layers / cells / cols = la scène en cours
  // d'édition (mêmes tableaux que dans show.scenes, voir bindScene). Un show ancien sans scènes en reçoit une faite de sa grille.
  const normScene = (sc, i) => {
    const cols = clamp(Math.round(+sc.cols || show.cols || 8), 1, 32);
    const layers = (Array.isArray(sc.layers) && sc.layers.length ? sc.layers : [newLayer('Fond')]).map(l => ({ ...newLayer(l.name || 'Calque'), ...l, id: l.id || uid(), fx: { ...FX_DEFAULT, ...(l.fx || {}) } }));
    const cells = {};
    for (const l of layers) {
      const row = Array.isArray(sc.cells?.[l.id]) ? sc.cells[l.id].slice(0, cols) : [];
      while (row.length < cols) row.push(null);
      cells[l.id] = row.map(id => (id && show.clips[id] ? id : null));
    }
    return { id: sc.id || uid(), name: String(sc.name || 'Scène ' + (i + 1)), layers, cells, cols };
  };
  const scenes = Array.isArray(show.scenes) && show.scenes.length ? show.scenes : [{ id: show.sceneId, name: 'Scène 1', layers: show.layers, cells: show.cells, cols: show.cols }];
  show.scenes = scenes.map(normScene);
  if (!show.scenes.some(sc => sc.id === show.sceneId)) show.sceneId = show.scenes[0].id;
  bindScene(show, show.sceneId);
  show.cues = (Array.isArray(show.cues) ? show.cues : []).map(c => ({ id: c.id || uid(), name: c.name || 'Séquence', layers: { ...(c.layers || {}) }, fade: +c.fade >= 0 ? +c.fade : 1, auto: +c.auto > 0 ? +c.auto : 0, sceneId: typeof c.sceneId === 'string' ? c.sceneId : '' }));
  show.pool = (Array.isArray(show.pool) ? show.pool : []).filter((id, i, a) => show.clips[id] && a.indexOf(id) === i);   // éléments créés (texte, effet, diaporama…) rangés dans la médiathèque
  // Médiathèque du show : noms des fichiers (media/), « doc:<id> », « ppt:<nom> ». null = show ancien : tout le dossier est visible.
  show.files = Array.isArray(show.files) ? show.files.filter((f, i, a) => typeof f === 'string' && f && a.indexOf(f) === i) : null;
  show.keys = (Array.isArray(show.keys) ? show.keys : []).filter(k => k && k.code && k.action).map(k => ({ code: String(k.code), shift: !!k.shift, alt: !!k.alt, meta: !!k.meta, action: String(k.action), target: k.target == null ? '' : String(k.target), scene: show.scenes.some(s => s.id === k.scene) ? k.scene : '' }));   // scene : '' = valable dans toutes les scènes
  // Sorties : la principale (id 'main' = la LED, avec le mapping) + d'autres écrans (retour conférenciers, autre salle…).
  // Chaque sortie montre toute la composition ou une seule zone en plein cadre, sans les calques listés dans `hidden`.
  const allLayerIds = new Set(show.scenes.flatMap(sc => sc.layers.map(l => l.id)));
  const normOut = (o, i) => ({ id: i === 0 ? 'main' : (o.id || uid()), name: String(o.name || (i === 0 ? 'LED principale' : 'Sortie ' + (i + 1))).slice(0, 40), mode: o.mode === 'zone' ? 'zone' : 'comp', zoneId: typeof o.zoneId === 'string' ? o.zoneId : '', hidden: (Array.isArray(o.hidden) ? o.hidden : []).filter(id => allLayerIds.has(id)), screen: typeof o.screen === 'string' ? o.screen : '' });
  const outs = Array.isArray(show.outputs) ? show.outputs.filter(o => o && typeof o === 'object') : [];
  if (!outs.length || outs[0].id !== 'main') outs.unshift({ id: 'main', name: 'LED principale', ...(outs.find(o => o.id === 'main') || {}) });
  show.outputs = outs.filter((o, i, a) => i === 0 || (o.id !== 'main' && a.findIndex(x => x.id === o.id) === i)).map(normOut);
  show.slices = (Array.isArray(show.slices) ? show.slices : []).filter(z => z && z.src && Array.isArray(z.dst) && z.dst.length === 4)
    .map(z => ({ id: z.id || uid(), name: z.name || 'Zone', on: z.on !== false, custom: z.custom === true, shape: z.shape in SHAPE_INDEX && (z.shape !== 'libre' || validPoly(z.poly)) ? z.shape : 'rect', ...(z.shape === 'libre' && validPoly(z.poly) ? { poly: z.poly.map(p => [clamp(+p[0], 0, 1), clamp(+p[1], 0, 1)]), ...(Array.isArray(z.extra) && z.extra.some(validPoly) ? { extra: z.extra.filter(validPoly).map(g => g.map(p => [clamp(+p[0], 0, 1), clamp(+p[1], 0, 1)])) } : {}) } : {}), src: { x: +z.src.x || 0, y: +z.src.y || 0, w: Math.max(1, +z.src.w || 1), h: Math.max(1, +z.src.h || 1), rot: +z.src.rot || 0 }, dst: z.dst.map(p => [+p[0] || 0, +p[1] || 0]), ...(+z.pitch > 0 ? { pitch: +z.pitch, pw: +z.pw || 0, ph: +z.ph || 0 } : {}) }));   // pitch/pw/ph : écran LED (mm, m, m) saisi dans Mapping
  if (!show.slices.length) show.slices.push(newSlice(show, 'Écran principal'));
  return show;
}

export const mainOutput = () => ({ id: 'main', name: 'LED principale', mode: 'comp', zoneId: '', hidden: [], screen: '' });
export function outputById(show, id) { return (show.outputs || []).find(o => o.id === (id || 'main')) || show.outputs?.[0] || mainOutput(); }
export function newOutput(show, name) { return { id: uid(), name: name || 'Sortie ' + ((show.outputs?.length || 1) + 1), mode: 'comp', zoneId: '', hidden: [], screen: '' }; }
export function emptyLive() { return { layers: {}, blackout: false, test: false, cue: -1, beat0: Date.now(), sceneId: '' }; }

/** Fait de la scène `id` la scène en cours d'édition : show.layers / cells / cols pointent sur ses tableaux. */
export function bindScene(show, id) {
  const sc = show.scenes.find(s => s.id === id) || show.scenes[0];
  show.sceneId = sc.id; show.layers = sc.layers; show.cells = sc.cells; show.cols = sc.cols;
  return sc;
}
export function sceneById(show, id) { return (show.scenes || []).find(s => s.id === id) || null; }
/** Calques à afficher pour un état de lecture (la scène qu'il désigne, sinon la scène en cours d'édition). */
export function layersFor(show, state) { return sceneById(show, state?.sceneId)?.layers || show.layers; }
export function newScene(show, name) {
  const layers = [newLayer('Fond'), newLayer('Média'), newLayer('Titres')], cells = {}, cols = 8;
  for (const l of layers) cells[l.id] = Array(cols).fill(null);
  return { id: uid(), name: name || 'Scène ' + ((show.scenes?.length || 0) + 1), layers, cells, cols };
}

/** Supprime les clips qui ne sont plus utilisés ni dans une grille ni dans le conducteur. */
export function pruneClips(show) {
  const used = new Set();
  for (const sc of show.scenes || [{ cells: show.cells }]) for (const row of Object.values(sc.cells)) for (const id of row) if (id) used.add(id);
  for (const c of show.cues) for (const id of Object.values(c.layers)) if (id) used.add(id);
  for (const id of show.pool || []) used.add(id);                                   // éléments créés, gardés dans la médiathèque
  for (const id of Object.keys(show.clips)) if (!used.has(id)) delete show.clips[id];
}

/* ---------- Géométrie du mapping ---------- */

/** Homographie carré unité → quadrilatère (points HG,HD,BD,BG). Renvoie 9 nombres, ligne par ligne. */
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  let g = 0, h = 0;
  if (Math.abs(det) > 1e-12 && (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12)) {
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const s = 1 / det;
  return [A * s, (c * h - b * i) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, (c * d - a * f) * s, C * s, (b * g - a * h) * s, (a * e - b * d) * s];
}

export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w, w];
}

/** Matrice sortie(0..1) → coordonnées de la zone (0..1), ou null si le quadrilatère est dégénéré. */
export function sliceMatrix(slice, outW, outH) {
  const q = slice.dst.map(p => [p[0] / outW, p[1] / outH]);
  const inv = invert3(squareToQuad(q));
  if (!inv) return null;
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const w = inv[6] * cx + inv[7] * cy + inv[8];
  return w < 0 ? inv.map(v => -v) : inv;       // w positif à l'intérieur de la zone
}

export function quadBounds(q) {
  const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
