/* Régie LED — interface de régie (fenêtre de contrôle).
 * Principe : on modifie `show` (ce qui est enregistré) ou `live` (ce qui joue), puis commit() :
 * l'état part vers la fenêtre de sortie (BroadcastChannel) et le show est enregistré sur le serveur local. */
import { Engine } from './engine.js';
import * as M from './model.js';
import { initMapping } from './mapping.js';
import { startSender } from './relay.js';
import { docPageUrl } from './sources.js';
import { Meter, meterCtx } from './meter.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#ffffff');
const fmtSize = b => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' Go' : b >= 1e6 ? Math.round(b / 1e6) + ' Mo' : Math.max(1, Math.round(b / 1e3)) + ' ko');
const baseName = n => String(n).replace(/\.[^.]+$/, '');
const MAX_LAYERS = 20;                    // calques par scène

let show, live, media = [], sel = null, tab = 'regie';
let eng = null, bc, mapping, outInfo = null, outSeen = 0, outWin = null, screens = null, camDevices = [];
let outInfos = {};                        // sorties secondaires : id → dernier statut reçu ({...m, seen})
let monOut = 'main', engOut2 = null;      // sortie affichée dans l'écran « Sortie » de la régie (aperçu d'une sortie secondaire via engOut2)
let autoTimer = null, autoAt = 0, appVersion = 0, reloadAsked = 0, staleSeen = 0, staleTried = 0;
// Mode Préparation : la grille agit sur un aperçu (prep) ; « Envoyer » le bascule vers la sortie (live).
let prepOn = localStorage.getItem('regieLed.prep') !== '0', engPrep = null, prepCue = null;
const prep = { layers: {}, blackout: false, test: false, cue: -1, beat0: Date.now() };
const TYPE_TAG = { video: 'VID', image: 'IMG', slideshow: 'DIAPO', camera: 'CAM', screen: 'DIR', doc: 'DOC', text: 'TXT', gen: 'FX' };
const TYPE_NAME = { video: 'Vidéo', image: 'Image', slideshow: 'Diaporama', camera: 'Caméra', screen: 'Fenêtre en direct', doc: 'Document', text: 'Texte', gen: 'Effet visuel' };
// Médiathèque : fichiers sélectionnés (cases à cocher, clic, Maj/⌘-clic) pour supprimer, poser dans la grille ou faire un diaporama.
let libSel = new Set(), libLast = null;
let docList = [];                         // documents à pages (PDF, Word, Excel…) gardés par la régie
let pres = [];                            // PowerPoint « en direct » gardés par la régie (affichés en tête de médiathèque)
let mediaAll = [], presAll = [], docAll = [];   // tout ce que le serveur a (media, pres, docList = la partie visible dans ce show, voir filterFiles)

/* ---------- utilitaires ---------- */
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastT);
  if (kind !== 'wait') toastT = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 7000 : 3200);
}
const layerById = id => show.layers.find(l => l.id === id);
const cueById = id => show.cues.find(c => c.id === id);
function clipLabel(c) {
  if (!c) return '';
  if (c.name) return c.name;
  if (c.type === 'text') return c.mode === 'clock' ? 'Horloge' : c.mode === 'countdown' ? 'Compte à rebours' : (String(c.text || '').split('\n')[0] || 'Texte');
  return TYPE_NAME[c.type] || '';
}

/* ---------- synchronisation & enregistrement ---------- */
let pushQueued = false, saveT = null, lsT = null;
function commit(save = true) {
  const sc = M.sceneById(show, show.sceneId); if (sc) sc.cols = show.cols;     // le nb de colonnes de la scène suit la grille
  if (!pushQueued) { pushQueued = true; Promise.resolve().then(push); }
  if (save) {
    $('#save-state').textContent = 'Enregistrement…';
    clearTimeout(saveT); saveT = setTimeout(saveShow, 600);
  }
}
function push() {
  pushQueued = false;
  bc.postMessage({ t: 'state', show, live });
  clearTimeout(lsT);
  lsT = setTimeout(() => {
    try { localStorage.setItem('regieLed.state', JSON.stringify({ show, live })); } catch { /* stockage plein : sans gravité */ }
  }, 300);
}
/** Show pas chargé depuis le serveur (lecture impossible) et aucune copie locale : on n'enregistre RIEN, pour ne jamais écraser le
 *  vrai show par un show vide. Levé dès qu'un enregistrement d'un show chargé correctement est possible (rechargement de la régie). */
let saveBlocked = false;
const UNSAVED_KEY = 'regieLed.unsaved';     // « 1 » tant que le dernier enregistrement a échoué : la copie locale est plus récente
async function saveShow() {
  if (saveBlocked) { $('#save-state').textContent = 'Non enregistré !'; return; }
  clearTimeout(saveT);
  try {
    const r = await fetch('/api/show', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(show) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    $('#save-state').textContent = 'Enregistré';
    try { localStorage.removeItem(UNSAVED_KEY); } catch { /* sans gravité */ }
  } catch {
    $('#save-state').textContent = 'Non enregistré !';
    try { localStorage.setItem(UNSAVED_KEY, '1'); localStorage.setItem('regieLed.state', JSON.stringify({ show, live })); } catch { /* stockage plein */ }
    toast('Impossible d\'enregistrer le show pour l\'instant : nouvel essai toutes les 5 secondes (ton travail est gardé dans la régie).', 'err');
    saveT = setTimeout(saveShow, 5000);                       // nouvel essai jusqu'à ce que le serveur réponde
  }
}
function restoreLive() {
  const l = M.emptyLive();
  try {
    const s = JSON.parse(localStorage.getItem('regieLed.state'));
    if (s?.live?.layers) {
      l.sceneId = M.sceneById(show, s.live.sceneId) ? s.live.sceneId : show.sceneId;
      for (const layer of M.layersFor(show, l)) {
        const L = s.live.layers[layer.id];
        if (L?.clipId && show.clips[L.clipId]) l.layers[layer.id] = { clipId: L.clipId, t0: +L.t0 || Date.now(), fade: L.fade, ...(L.pausedAt ? { pausedAt: +L.pausedAt } : {}) };
      }
      l.cue = Number.isInteger(s.live.cue) && s.live.cue < show.cues.length ? s.live.cue : -1;
      l.mute = !!s.live.mute;                                // son coupé : il le reste après un rechargement
      l.beat0 = +s.live.beat0 || l.beat0;
    }
  } catch { /* rien à reprendre */ }
  return l;
}

/* ---------- actions de lecture ---------- */
/** Là où agit la grille : l'aperçu en mode Préparation, sinon directement la sortie. */
const stage = () => (prepOn ? prep.layers : live.layers);
const clipOn = (layers, id) => layers[id]?.clipId || null;
/** La sortie passe sur la scène en cours d'édition : les calques de l'ancienne scène quittent l'écran. */
function claimLive() {
  if (live.sceneId === show.sceneId) return false;
  for (const id of Object.keys(live.layers)) if (!layerById(id)) delete live.layers[id];
  live.sceneId = show.sceneId;
  return true;
}
function launch(layerId, clipId, fade) {
  if (!show.clips[clipId] || !layerById(layerId)) return;
  if (!prepOn) claimLive();
  stage()[layerId] = { clipId, t0: Date.now(), ...(fade != null ? { fade } : {}) };
  if (!prepOn) { commit(false); renderScenes(); }
  updatePlaying();
}
/** Lance un clip directement à la sortie, même en mode Préparation (raccourci « … directement à la sortie »).
 *  Seul ce calque change : ce qui est préparé ailleurs reste en place ; l'écran Préparation montre ce calque comme le mur. */
function launchDirect(layerId, clipId) {
  if (!show.clips[clipId] || !layerById(layerId)) return;
  claimLive();
  const L = { clipId, t0: Date.now() };
  live.layers[layerId] = L;
  if (prepOn) prep.layers[layerId] = { ...L };
  commit(false); renderScenes(); updatePlaying();
}
function eject(layerId, fade) {
  if (!stage()[layerId]?.clipId) return;
  stage()[layerId] = { clipId: null, t0: Date.now(), ...(fade != null ? { fade } : {}) };
  if (!prepOn) commit(false);
  updatePlaying();
}
/** Petit carré ■ d'un clip : l'éteint là où il est, sans passer par le carré du calque.
 *  Mode Préparation : retiré de la préparation (part au prochain « Envoyer ») ; s'il n'est qu'à la sortie, ou avec Maj, coupé directement à la sortie. */
function stopClip(layerId, clipId, direct) {
  const onLive = clipOn(live.layers, layerId) === clipId, onPrep = prepOn && clipOn(prep.layers, layerId) === clipId;
  if (!onLive && !onPrep) return;
  const now = Date.now();
  if (onPrep) prep.layers[layerId] = { clipId: null, t0: now };
  if (onLive && (!prepOn || direct || !onPrep)) { live.layers[layerId] = { clipId: null, t0: now }; commit(false); }
  updatePlaying();
}
/** L'aperçu repart de ce qui est à la sortie (les vidéos se calent à la même position). */
function syncPrep() {
  prep.layers = {}; prepCue = null;
  for (const l of show.layers) { const L = live.layers[l.id]; if (L?.clipId && show.clips[L.clipId]) prep.layers[l.id] = { ...L }; }
}
function prepDiffers() { return show.layers.some(l => clipOn(prep.layers, l.id) !== clipOn(live.layers, l.id)); }
/** « Envoyer » : ce qui est préparé passe à la sortie, avec le fondu de chaque calque. */
function take() {
  if (!prepOn) return;
  const now = Date.now(); let n = 0;
  if (claimLive()) { n++; renderScenes(); }                              // changement de scène à la sortie
  for (const l of show.layers) {
    const want = clipOn(prep.layers, l.id), ok = want && show.clips[want] ? want : null;
    if (ok === clipOn(live.layers, l.id) && !live.layers[l.id]?.pausedAt) continue;   // déjà à la sortie : on ne relance pas (sauf s'il attend, en pause)
    const f = show.take?.mode === 'cut' ? 0 : (show.take?.dur ?? prep.layers[l.id]?.fade);      // transition choisie sous le bouton « Envoyer »
    live.layers[l.id] = { clipId: ok, t0: now, ...(f != null ? { fade: f } : {}) }; n++;
    if (prep.layers[l.id]) prep.layers[l.id] = { ...prep.layers[l.id], t0: now, pausedAt: undefined };   // la préparation se cale sur le mur : même départ (vidéo, compte à rebours)
  }
  if (prepCue != null && show.cues[prepCue]) {
    const cue = show.cues[prepCue];
    clearAuto(); live.cue = prepCue;
    if (cue.auto > 0) { autoAt = now + cue.auto * 1000; autoTimer = setTimeout(nextCue, cue.auto * 1000); }
  }
  prepCue = null;
  if (!n) toast('La sortie affiche déjà ce qui est préparé.');
  commit(false); updatePlaying(); renderCues();
}
function setPrep(on) {
  prepOn = on;
  try { localStorage.setItem('regieLed.prep', on ? '1' : '0'); } catch { /* sans gravité */ }
  if (on) {
    if (!engPrep) {
      try {
        engPrep = new Engine({ role: 'preview', maxW: 640 });
        engPrep.staging = true;                                                                  // écran Préparation : une vidéo « en attente » reste figée sur son point de départ…
        engPrep.isLive = id => Object.values(live.layers).some(L => L.clipId === id);            // …sauf si elle est déjà à la sortie (alors elle joue en même temps)
      } catch (e) { toast(e.message, 'err'); }
    }
    syncPrep();
  } else { engPrep?.reset(); prepCue = null; }
  $('#mon-prep').hidden = !on;
  $('#monitor').classList.toggle('two', on);
  updatePlaying(); renderCues(); renderShapes();
}
function stopAll() {
  const st = stage(), now = Date.now();
  for (const id of Object.keys(st)) if (st[id]?.clipId) st[id] = { clipId: null, t0: now };     // y compris les calques d'une autre scène à la sortie
  if (!prepOn) { commit(false); clearAuto(); }
  updatePlaying();
}
/** Une colonne est un tableau complet : ses clips se lancent, et les calques qui n'ont rien dans cette colonne s'arrêtent
 *  (sauf ceux réglés sur « Reste affiché »). `direct` : droit à la sortie, même en mode Préparation (Maj+clic). */
function launchColumn(col, direct = false) {
  if (col < 0 || col >= show.cols) return;
  if (!show.layers.some(l => show.cells[l.id][col])) return toast('La colonne ' + (col + 1) + ' est vide.');
  const toLive = direct || !prepOn, dst = toLive ? live.layers : prep.layers, now = Date.now();
  if (toLive) claimLive();
  for (const l of show.layers) {
    const id = show.cells[l.id][col];
    if (id) dst[l.id] = { clipId: id, t0: now };
    else if (dst[l.id]?.clipId && !l.keep) dst[l.id] = { clipId: null, t0: now };
  }
  if (toLive) { commit(false); if (prepOn) syncPrep(); renderScenes(); }
  updatePlaying();
}
function toggleBlackout() { live.blackout = !live.blackout; commit(false); updateTop(); }
/** Son de sortie coupé / rétabli (toutes les sources, toutes les sorties) ; l'image ne bouge pas. */
function toggleAudioMute() {
  live.mute = !live.mute; commit(false); updateTop();
  toast(live.mute ? '🔇 Son de sortie coupé.' : '🔊 Son de sortie rétabli.');
}
function cleanup() {
  M.pruneClips(show);
  for (const l of show.layers) { const L = live.layers[l.id]; if (L?.clipId && !show.clips[L.clipId]) live.layers[l.id] = { clipId: null, t0: Date.now() }; }
  for (const id of Object.keys(prep.layers)) { const P = prep.layers[id]; if (!layerById(id) || (P.clipId && !show.clips[P.clipId])) delete prep.layers[id]; }
  if (sel?.kind === 'clip' && !show.clips[sel.id]) sel = null;
}

/* ---------- pause / reprise / recommencer d'un clip en cours ---------- */
/** Où joue ce clip, et s'il est en pause : {where:['préparation','sortie'], paused}. */
function playState(clip) {
  const where = [], Ls = [];
  for (const l of show.layers) {
    if (prepOn && prep.layers[l.id]?.clipId === clip.id) { where.push('préparation'); Ls.push(prep.layers[l.id]); }
    if (live.layers[l.id]?.clipId === clip.id) { where.push('sortie'); Ls.push(live.layers[l.id]); }
  }
  return { where, paused: Ls.length > 0 && Ls.every(L => !!L.pausedAt) };
}
/** Pause ⇄ reprise : l'instant de pause est noté ; à la reprise, l'heure de lancement est décalée d'autant, donc tout reprend
 *  exactement où il s'était arrêté (compte à rebours, vidéo, diaporama, effet), dans la régie comme sur le mur. */
function pauseToggle(clip) {
  const st = playState(clip);
  if (!st.where.length) return toast('Ce clip n\'est pas en cours : lance-le d\'abord.', 'err');
  const now = Date.now(); let liveTouched = false;
  for (const l of show.layers) for (const [L, isLive] of [[prepOn ? prep.layers[l.id] : null, false], [live.layers[l.id], true]]) {
    if (!L || L.clipId !== clip.id) continue;
    if (st.paused) { L.t0 += now - L.pausedAt; delete L.pausedAt; } else L.pausedAt = now;
    if (isLive) liveTouched = true;
  }
  if (liveTouched) commit(false);
  updatePlaying(); renderInspector();
  toast(st.paused ? `« ${clipLabel(clip)} » reprend.` : `« ${clipLabel(clip)} » en pause.`);
}
/** Clips qui ont une horloge (pause / recommencer possibles). */
const hasClock = c => c && (c.type === 'video' || c.type === 'slideshow' || c.type === 'gen' || (c.type === 'text' && (c.mode === 'countdown' || c.scroll)));
/** Recommencer : nouveau départ là où le clip joue (sans fondu). Un compte à rebours « en attente » est remis à son temps de
 *  départ et reste figé jusqu'au prochain lancement ou envoi à la sortie. */
function restartClip(clip) {
  const now = Date.now(), wait = clip.type === 'text' && clip.mode === 'countdown' && clip.hold !== false; let n = 0, liveTouched = false;
  for (const l of show.layers) for (const [L, isLive] of [[prepOn ? prep.layers[l.id] : null, false], [live.layers[l.id], true]]) {
    if (!L || L.clipId !== clip.id) continue;
    L.t0 = now; if (wait) L.pausedAt = now; else delete L.pausedAt; n++; if (isLive) liveTouched = true;
  }
  if (!n) return toast('Ce clip n\'est pas en cours : lance-le d\'abord.', 'err');
  if (liveTouched) commit(false);
  updatePlaying(); renderInspector();
  toast(wait ? `« ${clipLabel(clip)} » remis à ${countdownStart(clip)}, en attente : il démarre à l'envoi à la sortie (ou ▶).` : `« ${clipLabel(clip)} » recommence.`);
}

/* ---------- conducteur ---------- */
function clearAuto() { clearTimeout(autoTimer); autoTimer = null; autoAt = 0; }
/** Ouvre un autre conducteur. Rien ne change à l'écran : seule la liste de séquences (et sa position) change. */
function switchConductor(id) {
  if (id === show.condId || !show.conductors.some(c => c.id === id)) return;
  M.bindConductor(show, show.condId).pos = live.cue;          // on retient où on en était
  clearAuto(); prepCue = null;
  const c = M.bindConductor(show, id);
  live.cue = Number.isInteger(c.pos) && c.pos >= 0 && c.pos < c.cues.length ? c.pos : -1;
  if (sel?.kind === 'cue' && !cueById(sel.id)) sel = null;
  commit(); renderCues(); renderInspector(); renderGrid();
  toast(`Conducteur « ${c.name} » : ${c.cues.length} séquence${c.cues.length > 1 ? 's' : ''}. « Suivant » (Espace) déroule cette liste.`);
}
async function conductorAction(act) {
  const cur = M.bindConductor(show, show.condId);
  if (act === 'cond-new') {
    const n = await askText('Nouveau conducteur', 'Conducteur ' + (show.conductors.length + 1), { max: 40, ok: 'Créer', hint: 'Par exemple : Jour 2, Plan B (retard), Salle B.' });
    if (n === null) return;
    const c = M.newConductor(show, n.trim().slice(0, 40) || undefined); show.conductors.push(c);
    commit(); switchConductor(c.id);
  }
  if (act === 'cond-ren') {
    const n = await askText('Nom du conducteur', cur.name, { max: 40, ok: 'Renommer' });
    if (n === null || !n.trim()) return;
    cur.name = n.trim().slice(0, 40); commit(); renderCues();
  }
  if (act === 'cond-dup') {
    const c = { ...M.newConductor(show, (cur.name + ' (copie)').slice(0, 40)), cues: cur.cues.map(q => ({ ...q, id: M.uid(), layers: { ...q.layers } })) };
    show.conductors.splice(show.conductors.indexOf(cur) + 1, 0, c);
    commit(); switchConductor(c.id);
  }
  if (act === 'cond-del') {
    if (show.conductors.length <= 1) return toast('Il faut garder au moins un conducteur.', 'err');
    if (!confirm(`Supprimer le conducteur « ${cur.name} » et ses ${cur.cues.length} séquence(s) ?\n\nLa grille et les clips ne sont pas touchés.`)) return;
    const i = show.conductors.indexOf(cur), next = show.conductors[i + 1] || show.conductors[i - 1];
    switchConductor(next.id);
    show.conductors.splice(show.conductors.indexOf(cur), 1);
    cleanup(); commit(); renderCues();
  }
}
function captureCue() {
  const layers = {};
  for (const l of show.layers) layers[l.id] = stage()[l.id]?.clipId || null;      // en mode Préparation : ce qui est dans l'aperçu
  const cue = { id: M.uid(), name: 'Séquence ' + (show.cues.length + 1), layers, fade: 1, auto: 0, sceneId: show.sceneId };
  show.cues.push(cue);
  if (prepOn) prepCue = show.cues.length - 1; else live.cue = show.cues.length - 1;
  sel = { kind: 'cue', id: cue.id };
  commit(); renderCues(); renderInspector(); renderGrid();
  toast('Séquence ajoutée au conducteur');
}
function goCue(i) {
  const cue = show.cues[i];
  if (!cue) return;
  clearAuto();
  if (cue.sceneId && cue.sceneId !== show.sceneId && M.sceneById(show, cue.sceneId)) switchScene(cue.sceneId);   // la séquence appartient à une autre scène
  claimLive(); renderScenes();
  live.cue = i;
  const now = Date.now();
  for (const l of show.layers) {
    if (!(l.id in cue.layers)) continue;
    const want = cue.layers[l.id] && show.clips[cue.layers[l.id]] ? cue.layers[l.id] : null;
    if (want === (live.layers[l.id]?.clipId || null)) continue;        // déjà à l'écran : on ne relance pas
    live.layers[l.id] = { clipId: want, t0: now, fade: cue.fade };
  }
  if (cue.auto > 0) { autoAt = now + cue.auto * 1000; autoTimer = setTimeout(nextCue, cue.auto * 1000); }
  if (prepOn) syncPrep();
  commit(false); updatePlaying(); renderCues();
}
/** Mode Préparation : charge une séquence dans l'aperçu, sans toucher à la sortie. */
function prepareCue(i) {
  const cue = show.cues[i];
  if (!cue) return;
  if (cue.sceneId && cue.sceneId !== show.sceneId && M.sceneById(show, cue.sceneId)) switchScene(cue.sceneId);
  const now = Date.now();
  for (const l of show.layers) {
    if (!(l.id in cue.layers)) continue;
    const want = cue.layers[l.id] && show.clips[cue.layers[l.id]] ? cue.layers[l.id] : null;
    if (want === clipOn(prep.layers, l.id)) continue;
    prep.layers[l.id] = { clipId: want, t0: now, fade: cue.fade };
  }
  prepCue = i;
  updatePlaying(); renderCues();
}
function nextCue() { if (live.cue + 1 < show.cues.length) goCue(live.cue + 1); else clearAuto(); }
function prevCue() { if (live.cue > 0) goCue(live.cue - 1); }
function cueSummary(cue) {
  const parts = [], sc = M.sceneById(show, cue.sceneId);
  for (const l of [...(sc?.layers || show.layers)].reverse()) { const c = show.clips[cue.layers[l.id]]; if (c) parts.push(clipLabel(c)); }
  return (sc && sc.id !== show.sceneId ? '[' + sc.name + '] ' : '') + (parts.join(' + ') || 'Écran vide');
}

/* ---------- scènes : plusieurs grilles de sources, la sortie garde la sienne jusqu'à « Envoyer » ---------- */
function switchScene(id) {
  const sc = M.sceneById(show, id);
  if (!sc || id === show.sceneId) return;
  M.bindScene(show, id);
  sel = null; zoneSel = null; prepCue = null;
  if (prepOn) syncPrep();                                   // la préparation repart de ce qui est à la sortie (si c'est cette scène)
  cleanup(); commit(); renderAll(); renderShapes();
}
function renderScenes() {
  const el = $('#scenebar'); if (!el) return;
  const liveSc = live.sceneId && live.sceneId !== show.sceneId ? M.sceneById(show, live.sceneId) : null;
  el.innerHTML = `<b class="sb-t">Scènes</b>${show.scenes.map(sc => `<button class="btn sm sc${sc.id === show.sceneId ? ' on' : ''}${sc.id === live.sceneId ? ' live' : ''}" data-scene="${sc.id}" title="${sc.id === live.sceneId ? 'Cette scène est à la sortie' : 'Ouvrir cette scène'}">${esc(sc.name)}</button>`).join('')}
    <button class="btn sm ico" data-act="scene-add" title="Nouvelle scène (grille vide)">＋</button>
    <span class="sb-sep"></span>
    <button class="btn sm" data-act="scene-rename" title="Renommer la scène ouverte">✎</button><button class="btn sm" data-act="scene-dup" title="Dupliquer la scène ouverte (mêmes calques et clips)">⧉</button><button class="btn sm danger" data-act="scene-del" title="Supprimer la scène ouverte">✕</button>
    <span class="sb-hint">${liveSc ? `La sortie affiche « ${esc(liveSc.name)} » ; « Envoyer » la remplacera par cette scène.` : 'Une scène = une grille de sources. La sortie garde sa scène jusqu\'à « Envoyer ».'}</span>`;
}
async function renameScene(sc) {
  const n = await askText('Nom de la scène', sc.name, { max: 40 });
  if (n && n.trim() && n.trim() !== sc.name) { sc.name = n.trim().slice(0, 40); commit(); renderScenes(); renderCues(); }
}
function bindScenes() {
  $('#scenebar').addEventListener('dblclick', e => {               // double-clic sur un onglet = renommer
    const id = e.target.closest('[data-scene]')?.dataset.scene, sc = id && M.sceneById(show, id);
    if (sc) { e.preventDefault(); renameScene(sc); }
  });
  $('#scenebar').addEventListener('click', e => {
    const id = e.target.closest('[data-scene]')?.dataset.scene, act = e.target.closest('[data-act]')?.dataset.act;
    if (id) return switchScene(id);
    const cur = M.sceneById(show, show.sceneId);
    if (act === 'scene-add') {
      if (show.scenes.length >= 16) return toast('16 scènes maximum.', 'err');
      const sc = M.newScene(show); show.scenes.push(sc); switchScene(sc.id);
      return toast(`« ${sc.name} » créée : une grille vide, à remplir depuis la médiathèque.`);
    }
    if (act === 'scene-rename') renameScene(cur);
    if (act === 'scene-dup') {
      if (show.scenes.length >= 16) return toast('16 scènes maximum.', 'err');
      const map = {}, layers = cur.layers.map(l => { const n = { ...l, id: M.uid(), fx: { ...l.fx } }; map[l.id] = n.id; return n; });
      const cells = {}; for (const [lid, row] of Object.entries(cur.cells)) cells[map[lid]] = [...row];
      const sc = { id: M.uid(), name: cur.name + ' (copie)', layers, cells, cols: cur.cols };
      show.scenes.splice(show.scenes.indexOf(cur) + 1, 0, sc); switchScene(sc.id);
    }
    if (act === 'scene-del') {
      if (show.scenes.length <= 1) return toast('Il faut garder au moins une scène.', 'err');
      if (!confirm(`Supprimer la scène « ${cur.name} » et sa grille ?` + (live.sceneId === cur.id ? '\n\nElle est à la sortie : le mur passera au noir.' : ''))) return;
      const i = show.scenes.indexOf(cur); show.scenes.splice(i, 1);
      for (const q of M.allCues(show)) if (q.sceneId === cur.id) q.sceneId = '';
      if (live.sceneId === cur.id) { live.layers = {}; live.sceneId = ''; commit(false); }
      show.sceneId = ''; switchScene(show.scenes[Math.max(0, i - 1)].id);
    }
  });
}

/* ---------- médiathèque ---------- */
async function loadMedia() {
  try { mediaAll = await (await fetch('/api/media')).json(); if (!Array.isArray(mediaAll)) mediaAll = []; } catch { mediaAll = []; }
  try { presAll = await (await fetch('/api/ppt/list')).json(); if (!Array.isArray(presAll)) presAll = []; } catch { presAll = []; }
  try { docAll = await (await fetch('/api/docs')).json(); if (!Array.isArray(docAll)) docAll = []; } catch { docAll = []; }
  filterFiles();
}
/* Médiathèque par show : show.files = clés des fichiers du show (nom du média, « doc:<id> », « ppt:<nom> »).
 * null (show ancien) = tout le dossier media est visible, et « Supprimer » efface du disque. Un show créé vide part de [] :
 * « Supprimer » le retire seulement du show, et « Fichiers déjà importés… » permet de reprendre un fichier du dossier. */
const perShowFiles = () => Array.isArray(show?.files);
const fileKeyDoc = d => 'doc:' + d.id, fileKeyPpt = p => 'ppt:' + p.name;
function filterFiles() {
  if (!perShowFiles()) { media = mediaAll; pres = presAll; docList = docAll; return; }
  const set = new Set(show.files);
  media = mediaAll.filter(m => set.has(m.name)); pres = presAll.filter(p => set.has(fileKeyPpt(p))); docList = docAll.filter(d => set.has(fileKeyDoc(d)));
}
/** Ajoute des fichiers (clés) à la médiathèque de ce show. Sans effet pour un show ancien (tout est déjà visible). */
function addFiles(keys) {
  if (!perShowFiles()) return;
  let n = 0;
  for (const k of keys) if (k && !show.files.includes(k)) { show.files.push(k); n++; }
  if (n) commit();
  filterFiles();
}
function removeFiles(keys) {
  if (!perShowFiles()) return;
  show.files = show.files.filter(k => !keys.includes(k)); commit(); filterFiles();
}
function renameFileKey(from, to) {
  if (!perShowFiles() || from === to) return;
  const i = show.files.indexOf(from); if (i >= 0) { show.files[i] = to; commit(); }
  filterFiles();
}
/* ---------- documents à pages (PDF, Word, Excel, PowerPoint en images) ---------- */
const docClip = d => M.newClip('doc', { name: baseName(d.name), doc: d.id, pages: d.pages, page: 0 });
const docLabel = c => `Page ${Math.min(c.pages || 1, (c.page || 0) + 1)} / ${c.pages || 1}`;
/** Pose un document dans la grille et le montre (dans l'aperçu en mode Préparation). */
function addDocClip(d) {
  const c = docClip(d);
  addClipToGrid(c, 1);
  if (!show.clips[c.id]) return;
  showClip(c);
  toast(`« ${c.name} » : ${d.pages} page${d.pages > 1 ? 's' : ''}. Tourne les pages avec ◀ ▶ dans ses réglages, ou les touches ← →.`);
}
/** Tourne la page d'un document : 'next', 'prev', 'first', 'last' ou un numéro de page (à partir de 1). */
function docTurn(clip, how) {
  const n = Math.max(1, +clip.pages || 1), cur = Math.min(n - 1, Math.max(0, +clip.page || 0));
  const to = how === 'next' ? cur + 1 : how === 'prev' ? cur - 1 : how === 'first' ? 0 : how === 'last' ? n - 1 : (+how || 1) - 1;
  clip.page = Math.min(n - 1, Math.max(0, Math.round(to)));
  commit();
  if (sel?.kind === 'clip' && sel.id === clip.id) { const el = $('#doc-pos'); if (el) el.textContent = docLabel(clip); const g = $('#doc-goto'); if (g && document.activeElement !== g) g.value = clip.page + 1; }
  for (const img of $$(`#grid .cell[data-clip="${clip.id}"] .c-th img`)) img.src = docPageUrl(clip.doc, clip.page);
}
/** Clip « à pages » (document ou PowerPoint en direct) piloté par ← → : celui qui est à la sortie, sinon en préparation, sinon sélectionné. */
function activePaged() {
  const paged = c => c && (c.ppt || c.type === 'doc');
  const pick = layers => show.layers.map(l => show.clips[layers[l.id]?.clipId]).find(paged);
  return pick(live.layers) || (prepOn && pick(prep.layers)) || (sel?.kind === 'clip' && paged(show.clips[sel.id]) ? show.clips[sel.id] : null);
}
/** Clip « PowerPoint en direct » pour un fichier gardé par la régie. Reprend la capture déjà choisie pour ce même fichier. */
function pptClip(name) {
  const c = M.newClip('screen', { name: baseName(name), ppt: name, cropT: 40 / 768, cropB: 16 / 768 });
  const other = Object.values(show.clips).find(x => x.ppt === name && window.__ledStreams[x.id]?.active);
  if (other) window.__ledStreams[c.id] = window.__ledStreams[other.id];
  return c;
}
function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/media?name=' + encodeURIComponent(file.name));
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { let r = {}; try { r = JSON.parse(x.responseText); } catch { /* réponse vide */ } x.status === 200 ? resolve(r) : reject(new Error(r.error || 'Envoi refusé')); };
    x.onerror = () => reject(new Error('Envoi interrompu'));
    x.send(file);
  });
}
const DOC_RE = /\.(pdf|pptx?|ppsx?|docx?|xlsx?)$/i;

/* ---------- fenêtre en direct & PowerPoint piloté ---------- */
window.__ledStreams = {};                 // clipId → flux de la fenêtre capturée ; la sortie le relit directement ou par le relais
const relay = startSender(id => window.__ledStreams[id]);
const pptState = {};                      // fichier → {pos, total}
/** Petite fenêtre de choix. Renvoie la valeur du bouton cliqué, ou null si on clique à côté. */
function ask(title, text, options) {
  return new Promise(resolve => {
    const d = document.createElement('div');
    d.className = 'modal';
    d.innerHTML = `<div class="modal-box"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="modal-btns">${options.map((o, i) =>
      `<button class="btn${i === 0 ? ' gold' : ''}" data-i="${i}"><b>${esc(o.label)}</b><small>${esc(o.hint || '')}</small></button>`).join('')}</div></div>`;
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b) { d.remove(); resolve(options[+b.dataset.i].value); } else if (e.target === d) { d.remove(); resolve(null); }
    });
    document.body.append(d);
  });
}
/** Fenêtre générique : renvoie l'élément (d.remove() pour fermer). Clic sur le fond = fermeture, sauf si `d.lock`. */
function openBox(html, cls = '') {
  const d = document.createElement('div');
  d.className = 'modal';
  d.innerHTML = `<div class="modal-box ${cls}">${html}</div>`;
  d.addEventListener('click', e => { if (e.target === d && !d.lock) d.remove(); });
  document.body.append(d);
  return d;
}
/** Demande un texte (remplace prompt(), que l'application de bureau ne propose pas). Renvoie la chaîne saisie, ou null si annulé (Échap, clic à côté). */
function askText(title, def = '', opts = {}) {
  return new Promise(resolve => {
    const d = openBox(`<h3>${esc(title)}</h3>${opts.hint ? `<p>${esc(opts.hint)}</p>` : ''}
      <input type="text" class="ask-input" maxlength="${opts.max || 80}" value="${esc(def)}" spellcheck="false">
      <div class="row ask-btns"><button class="btn gold" data-ok>${esc(opts.ok || 'OK')}</button><button class="btn" data-cancel>Annuler</button></div>`, 'ask');
    const inp = d.querySelector('input'); let done = false;
    const end = v => { if (done) return; done = true; d.remove(); resolve(v); };
    d.addEventListener('click', e => { if (e.target.closest('[data-ok]')) end(inp.value); else if (e.target.closest('[data-cancel]') || e.target === d) end(null); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); end(inp.value); } else if (e.key === 'Escape') { e.preventDefault(); end(null); } e.stopPropagation(); });
    inp.addEventListener('keyup', e => e.stopPropagation());
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}
/** Choix de plusieurs fichiers de la médiathèque (cases à cocher). Renvoie la liste choisie (vide si annulé). */
function pickMedia(title, btn) {
  return new Promise(resolve => {
    const d = openBox(`<h3>${esc(title)}</h3>
      <div class="pick-list">${media.length ? media.map(m => `<label class="pick"><input type="checkbox" value="${esc(m.name)}"><span class="lib-th">${thumbMedia(m)}</span><b>${esc(m.name)}</b></label>`).join('') : '<p class="empty">La médiathèque est vide : importe d\'abord des images ou des vidéos.</p>'}</div>
      <div class="row"><button class="btn gold" data-ok="1">${esc(btn)}</button><button class="btn" data-cancel="1">Annuler</button></div>`, 'pick');
    d.addEventListener('click', e => {
      if (e.target.closest('[data-ok]')) { const names = $$('input:checked', d).map(i => i.value); d.remove(); resolve(mediaByNames(names)); }
      else if (e.target.closest('[data-cancel]')) { d.remove(); resolve([]); }
      else if (e.target === d) resolve([]);                 // fermé par un clic à côté
    });
  });
}

/* ---------- capture d'une source externe → fichier dans la médiathèque ---------- */
const pad2 = n => String(n).padStart(2, '0');
/** Format d'enregistrement : MP4 (H.264) quand Chrome sait l'écrire, sinon WebM. */
function recordMime() {
  const cands = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
  return cands.find(m => window.MediaRecorder?.isTypeSupported(m)) || '';
}
/* Sources en direct (caméras, cartes de capture HDMI/USB) : listées dans la médiathèque comme des médias. La liste est
 * mémorisée (regieLed.cams) pour apparaître dès l'ouverture, avant toute autorisation ; « ↻ » la relit. */
let camKnown = [];
try { camKnown = JSON.parse(localStorage.getItem('regieLed.cams')) || []; } catch { camKnown = []; }
const saveCams = () => { try { localStorage.setItem('regieLed.cams', JSON.stringify(camKnown)); } catch { /* sans gravité */ } };
/** Caméra intégrée à l'ordinateur (FaceTime…) : on ne la liste que si elle a servi — ce qui compte, ce sont les entrées externes. */
const camBuiltin = label => /facetime|isight|int[ée]gr|built-?in|integrated/i.test(label || '');
/** Les sources à montrer dans la médiathèque : les externes, et les intégrées déjà utilisées ; jamais celles qu'on a masquées (✕). */
const camListed = () => camKnown.filter(c => !c.hidden && (c.used || !camBuiltin(c.label)) && (!perShowFiles() || show.files.includes('cam:' + c.deviceId)));   // médiathèque par show : seulement les sources reprises dans ce show
function rememberCams() {
  let added = [];
  for (const d of camDevices) {
    if (!d.deviceId) continue;
    const k = camKnown.find(x => x.deviceId === d.deviceId);
    if (k) { if (!k.custom) k.label = d.label || k.label; }       // un nom donné par l'utilisateur (✎) n'est jamais écrasé
    else { const n = { deviceId: d.deviceId, label: d.label || 'Caméra' }; camKnown.push(n); added.push(n); }
  }
  // Une caméra déjà posée dans la grille compte comme utilisée (donc listée même si elle est intégrée).
  for (const c of Object.values(show?.clips || {})) if (c.type === 'camera' && c.deviceId) { const k = camKnown.find(x => x.deviceId === c.deviceId); if (k) k.used = true; }
  saveCams();
  return added.filter(n => !camBuiltin(n.label));
}
const camLabel = id => { const k = camKnown.find(x => x.deviceId === id); return (k?.custom && k.label) || camDevices.find(d => d.deviceId === id)?.label || k?.label || 'Caméra'; };
function camClip(id) {
  const k = camKnown.find(x => x.deviceId === id);
  if (k && (!k.used || k.hidden)) { k.used = true; k.hidden = false; saveCams(); renderLib(); }
  if (perShowFiles() && !show.files.includes('cam:' + id)) { addFiles(['cam:' + id]); renderLib(); }
  return M.newClip('camera', { deviceId: id, deviceLabel: camLabel(id), name: camLabel(id).slice(0, 40) });
}
/** Une carte ou une caméra vient d'être branchée (ou débranchée) : la liste se met à jour toute seule. */
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const before = camDevices.map(d => d.deviceId).join();
  await listCams(false);
  if (camDevices.map(d => d.deviceId).join() === before) return;
  renderLib();
  const fresh = camListed().filter(c => camDevices.some(d => d.deviceId === c.deviceId) && !c.seen);
  for (const c of camKnown) c.seen = camDevices.some(d => d.deviceId === c.deviceId);
  saveCams();
  if (fresh.length) toast(`Source en direct branchée : ${fresh.map(c => c.label).join(', ')} — elle est dans la médiathèque.`);
  else if (perShowFiles()) { const nw = camKnown.filter(c => !c.hidden && camDevices.some(d => d.deviceId === c.deviceId) && !show.files.includes('cam:' + c.deviceId) && !camBuiltin(c.label)); if (nw.length) toast(`Source en direct branchée : ${nw.map(c => c.label).join(', ')} — « Importer → Fichiers déjà importés… » pour l'ajouter à ce show.`); }
});
/** Liste les caméras. `prompt` : demander l'autorisation s'il le faut (sinon on se contente de ce que le navigateur donne déjà). */
async function listCams(prompt = true) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (prompt && devs.some(d => d.kind === 'videoinput' && !d.label)) {       // sans autorisation, pas de noms : on la demande une fois
      const st = await navigator.mediaDevices.getUserMedia({ video: true });
      st.getTracks().forEach(t => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    camDevices = devs.filter(d => d.kind === 'videoinput' && d.deviceId);
    audioInDevs = devs.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    audioOutDevs = devs.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    if (camDevices.some(d => d.label)) rememberCams();
    return devs;
  } catch { return []; }
}
let audioInDevs = [], audioOutDevs = [];
/** Entrées et sorties audio. Les noms des sorties ne sont donnés par Chrome qu'une fois le micro autorisé (une seule fois). */
async function listAudio(prompt = true) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (prompt && devs.some(d => d.kind === 'audiooutput' && !d.label)) {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach(t => t.stop());
    }
    return listCams(false);
  } catch { return []; }
}
/** Entrée audio « associée » à une caméra / carte : même groupe de périphériques (même carte USB), sinon même nom. */
function audioInFor(videoId) {
  const cam = camDevices.find(d => d.deviceId === videoId), g = cam?.groupId;
  const root = (cam?.label || '').replace(/\(.*?\)/g, '').trim().split(' ')[0];
  return (g && audioInDevs.find(d => d.groupId === g)) || (root && audioInDevs.find(d => d.label.toLowerCase().includes(root.toLowerCase()))) || null;
}
/** « Capturer une source » : caméra, carte de capture HDMI/USB ou fenêtre de l'ordinateur → vidéo (MediaRecorder) ou photo, enregistrée dans media/. */
async function openCaptureModal() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('La capture n\'est pas disponible dans ce navigateur.', 'err');
  const now = new Date(), defName = `Capture ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}h${pad2(now.getMinutes())}`;
  const d = openBox(`<h3>Capturer une source externe</h3>
    <p>Caméra, carte de capture HDMI/USB (ordinateur invité, console vidéo, caméra pro…) ou fenêtre de l'ordinateur. <b>« En direct »</b> l'affiche sur le mur en temps réel, comme un clip ; <b>« Enregistrer »</b> et <b>« Photo »</b> en font un fichier dans la médiathèque.</p>
    <div class="cap-row"><label>Source <select id="cap-src"><option value="">Chargement…</option></select></label>
      <button class="btn sm" id="cap-detect" title="Relire la liste des caméras et cartes de capture branchées">↻</button>
      <label class="chk" title="Enregistre aussi le son (entrée audio de la carte / micro de la caméra, ou son de la fenêtre partagée)"><input type="checkbox" id="cap-audio"> Son</label></div>
    <video id="cap-video" class="live-thumb cap-video" muted playsinline autoplay></video>
    <p class="cap-state" id="cap-state">Choisis une source pour voir son image.</p>
    <div class="cap-row"><label class="grow">Nom du fichier <input type="text" id="cap-name" value="${esc(defName)}"></label></div>
    <div class="row"><button class="btn gold" id="cap-live" disabled title="Crée un clip qui montre cette source en temps réel (sans rien enregistrer) : tu l'envoies sur le mur quand tu veux">📡 En direct</button><button class="btn" id="cap-rec" disabled>⏺ Enregistrer</button><button class="btn" id="cap-photo" disabled>📷 Photo</button><button class="btn" id="cap-close">Fermer</button></div>
    <p class="note">« En direct » : un clip Caméra (ou Fenêtre en direct) est posé dans la grille et préparé ; « Envoyer à la sortie » quand tu veux. L'enregistrement s'arrête avec « ■ Arrêter » ; le fichier apparaît ensuite dans la médiathèque.</p>`, 'cap');
  d.lock = true;
  const q = s => $(s, d), video = q('#cap-video'), state = q('#cap-state'), recBtn = q('#cap-rec'), photoBtn = q('#cap-photo'), liveBtn = q('#cap-live'), srcSel = q('#cap-src');
  let stream = null, rec = null, chunks = [], recT0 = 0, timer = null, devs = [];
  const safe = () => (q('#cap-name').value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'Capture').slice(0, 80);
  const setState = (txt, cls = '') => { state.textContent = txt; state.className = 'cap-state ' + cls; };
  const stopStream = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; recBtn.disabled = photoBtn.disabled = liveBtn.disabled = true; };
  /** « En direct » : la source devient un clip de la grille (Caméra pour une carte/caméra, Fenêtre en direct pour une fenêtre). */
  function goLive() {
    const id = srcSel.value;
    if (!id || !stream) return;
    if (id === 'screen') {
      const c = M.newClip('screen');
      const s = stream; stream = null;                       // le flux appartient maintenant au clip
      d.remove();
      addToPool(c, true);
      window.__ledStreams[c.id]?.getTracks().forEach(t => t.stop()); window.__ledStreams[c.id] = s; relay.reset(c.id);
      s.getVideoTracks()[0]?.addEventListener('ended', () => { if (window.__ledStreams[c.id] === s) { delete window.__ledStreams[c.id]; relay.reset(c.id); } renderLib(); });
      renderLib(); renderInspector();
      return toast('Fenêtre capturée, rangée dans la médiathèque (section « Éléments ») : glisse-la sur une case ou une forme.');
    }
    const label = srcSel.selectedOptions[0]?.textContent || 'Caméra';
    stopStream(); d.remove();
    const c = camClip(id);                                    // marque aussi la source comme utilisée (listée dans la médiathèque)
    addToPool(c, true);
    toast(`« ${label} » est dans la médiathèque (Sources en direct et Éléments) : glisse-la sur une case ou une forme, puis lance-la.`);
  }
  async function fillSources() {
    devs = await listCams();
    const cams = devs.filter(x => x.kind === 'videoinput');
    srcSel.innerHTML = '<option value="">— Choisir une source —</option>' + cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || 'Caméra ' + (i + 1))}</option>`).join('')
      + '<option value="screen">Fenêtre ou écran de l\'ordinateur…</option>';
    if (!cams.length) setState('Aucune caméra ni carte de capture détectée. Branche-la, puis ↻ — ou choisis « Fenêtre ou écran ».', 'warn');
  }
  async function startStream() {
    stopStream();
    const id = srcSel.value, audio = q('#cap-audio').checked;
    if (!id) return setState('Choisis une source pour voir son image.');
    try {
      if (id === 'screen') stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio, selfBrowserSurface: 'exclude' });
      else {
        const cam = devs.find(x => x.deviceId === id), mic = cam && devs.find(x => x.kind === 'audioinput' && x.groupId && x.groupId === cam.groupId);   // l'entrée audio de la même carte
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(mic ? { deviceId: { exact: mic.deviceId } } : {}) } : false,
        });
      }
    } catch (e) {
      return setState(id === 'screen' ? 'Aucune fenêtre choisie.' : 'Impossible d\'ouvrir cette source : est-elle déjà utilisée par une autre application ? (' + (e.message || e) + ')', 'warn');
    }
    video.srcObject = stream; video.play().catch(() => {});
    const t = stream.getVideoTracks()[0], s = t?.getSettings() || {};
    setState(`● ${t?.label || 'Source'} — ${s.width || '?'} × ${s.height || '?'}${s.frameRate ? ' · ' + Math.round(s.frameRate) + ' i/s' : ''}${stream.getAudioTracks().length ? ' · son' : ''}`, 'on');
    recBtn.disabled = photoBtn.disabled = liveBtn.disabled = false;
    t?.addEventListener('ended', () => { if (rec?.state === 'recording') rec.stop(); if (stream) { stopStream(); setState('La source s\'est arrêtée.', 'warn'); } });
  }
  async function save(blob, name) {
    toast(`Enregistrement de « ${name} »…`, 'wait');
    try {
      const r = await uploadOne(new File([blob], name, { type: blob.type }), p => toast(`Enregistrement de « ${name} » — ${Math.round(p * 100)} %`, 'wait'));
      addFiles([r?.name]);
      await loadMedia(); renderLib();
      toast(`« ${name} » (${fmtSize(blob.size)}) ajouté à la médiathèque.`);
    } catch (e) { toast(name + ' : ' + e.message, 'err'); }
  }
  function startRec() {
    const mime = recordMime();
    if (!stream || !mime) return toast('Enregistrement vidéo indisponible dans ce navigateur.', 'err');
    chunks = [];
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6, audioBitsPerSecond: 192e3 }); }
    catch (e) { return toast('Impossible de démarrer l\'enregistrement : ' + (e.message || e), 'err'); }
    const ext = mime.startsWith('video/mp4') ? '.mp4' : '.webm', name = safe() + ext;
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearInterval(timer); timer = null; rec = null;
      recBtn.textContent = '⏺ Enregistrer'; recBtn.classList.remove('rec'); q('#cap-close').disabled = srcSel.disabled = false; photoBtn.disabled = !stream;
      if (stream) setState('Source prête.', 'on');
      const blob = new Blob(chunks, { type: mime.split(';')[0] }); chunks = [];
      if (blob.size) save(blob, name); else toast('Rien n\'a été enregistré.', 'err');
    };
    rec.start(1000);
    recT0 = Date.now();
    recBtn.textContent = '■ Arrêter'; recBtn.classList.add('rec'); q('#cap-close').disabled = srcSel.disabled = photoBtn.disabled = true;
    timer = setInterval(() => { const s = Math.round((Date.now() - recT0) / 1000); setState(`⏺ Enregistrement ${pad2(Math.floor(s / 60))}:${pad2(s % 60)} → ${name}`, 'rec'); }, 250);
  }
  function photo() {
    if (!stream || !video.videoWidth) return toast('L\'image n\'est pas encore arrivée : réessaie.', 'err');
    const cv = document.createElement('canvas'); cv.width = video.videoWidth; cv.height = video.videoHeight;
    cv.getContext('2d').drawImage(video, 0, 0);
    cv.toBlob(b => { if (b) save(b, safe() + '.jpg'); }, 'image/jpeg', 0.92);
  }
  d.addEventListener('click', e => {
    if (e.target.closest('#cap-close')) { if (rec) return; stopStream(); d.remove(); }
    if (e.target.closest('#cap-rec')) rec ? rec.stop() : startRec();
    if (e.target.closest('#cap-photo')) photo();
    if (e.target.closest('#cap-live') && !rec) goLive();
    if (e.target.closest('#cap-detect')) fillSources();
  });
  srcSel.addEventListener('change', startStream);
  q('#cap-audio').addEventListener('change', () => { if (stream && !rec) startStream(); });
  await fillSources();
  renderLib();                                            // les sources détectées apparaissent tout de suite dans la médiathèque
}
/** Demande à Chrome de capturer une fenêtre (ou un écran) et l'associe au clip. Doit partir d'un clic.
 *  Pendant que le sélecteur est ouvert (et juste après), les raccourcis de la régie sont coupés : une touche Entrée ou Espace
 *  destinée au sélecteur ne doit pas « Envoyer à la sortie » ni passer à la séquence suivante. */
let pickingUntil = 0;
async function pickScreen(clip) {
  let s;
  pickingUntil = Infinity;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true, selfBrowserSurface: 'exclude' }); }   // audio : proposé par Chrome pour un onglet ou un écran entier, pas pour une simple fenêtre
  catch { pickingUntil = Date.now() + 1500; return toast(`Aucune fenêtre choisie. Si rien n'est proposé : Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran → autoriser ${window.regieDesktop ? 'Régie LED' : 'Google Chrome'}, puis relancer l'application.`, 'err'); }
  pickingUntil = Date.now() + 1500;
  attachStream(clip, s);
}
/** Arrête la capture d'une fenêtre (PowerPoint en direct ou fenêtre quelconque) : la régie lâche la fenêtre, la case devient noire.
 *  La fenêtre elle-même reste ouverte (le diaporama reste à sa diapositive) : « Reprendre la capture » la rattache. */
function stopCapture(clip) {
  const s = window.__ledStreams[clip.id];
  if (!s) return;
  const ids = Object.keys(window.__ledStreams).filter(id => window.__ledStreams[id] === s);      // clips qui partagent cette capture (même PowerPoint)
  const onAir = ids.some(id => Object.values(live.layers).some(L => L.clipId === id));
  if (onAir && !confirm('Ce clip est à l\'antenne : le mur deviendra noir à cet endroit.\n\nArrêter la capture quand même ?')) return;
  const lab = s.getVideoTracks()[0]?.label || 'fenêtre capturée';                     // pour la reprendre ensuite (clips capturés avant cette version)
  for (const id of ids) { const c = show.clips[id]; if (c && !c.capLabel) c.capLabel = lab; }
  commit();
  s.getTracks().forEach(t => t.stop());
  for (const id of ids) { delete window.__ledStreams[id]; relay.reset(id); }
  renderInspector(); attachLiveThumbs();
  toast(clip.ppt ? 'Capture arrêtée. Le diaporama reste ouvert dans PowerPoint, à la même diapositive : « ▶ Reprendre la capture » le rattache.' : 'Capture arrêtée : « ▶ Reprendre la capture » rattache la fenêtre.');
}
/** Reprend la capture arrêtée. Dans l'application de bureau, la même fenêtre est retrouvée toute seule (sans fenêtre de choix) ;
 *  dans un navigateur, on la resélectionne. Les autres clips du même PowerPoint repartent avec. */
async function resumeCapture(clip) {
  const want = clip.ppt ? { ppt: baseName(clip.ppt) } : { label: clip.capLabel || '' };
  try { await window.regieDesktop?.preferCapture?.(want); } catch { /* ancienne version de l'application : fenêtre de choix */ }
  await pickScreen(clip);
  const s = window.__ledStreams[clip.id];
  if (s && clip.ppt) for (const c of Object.values(show.clips)) if (c !== clip && c.ppt === clip.ppt && !window.__ledStreams[c.id]?.active) { window.__ledStreams[c.id] = s; relay.reset(c.id); }
  if (!s && clip.ppt) toast('Fenêtre du diaporama introuvable : s\'il a été fermé, clique sur « Relancer le diaporama », puis sur « Reprendre la capture ».', 'err');
}
/** Associe un flux capturé au clip et montre tout de suite le clip (dans l'aperçu en mode Préparation). */
function attachStream(clip, s) {
  window.__ledStreams[clip.id]?.getTracks().forEach(t => t.stop());
  window.__ledStreams[clip.id] = s;
  const lab = s.getVideoTracks()[0]?.label || '';
  if (lab && clip.capLabel !== lab) { clip.capLabel = lab; commit(); }        // pour retrouver la même fenêtre à la reprise
  s.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (window.__ledStreams[clip.id] === s) { delete window.__ledStreams[clip.id]; relay.reset(clip.id); }
    if (sel?.kind === 'clip' && sel.id === clip.id) renderInspector();
    attachLiveThumbs();
  });
  relay.reset(clip.id);                    // la sortie redemande la nouvelle capture
  const onAir = Object.values(live.layers).some(L => L.clipId === clip.id);
  showClip(clip);
  renderInspector(); attachLiveThumbs();   // la case de la grille montre tout de suite la fenêtre capturée
  if (onAir) toast('Fenêtre capturée. Attention : ce clip est déjà à la sortie, le mur l\'affiche maintenant.', 'err');
  else toast(prepOn ? 'Fenêtre capturée : elle est dans l\'écran Préparation. « Envoyer à la sortie » (Entrée) quand tu veux l\'afficher sur le mur.' : 'Fenêtre capturée. Clique sur le clip dans la grille pour l\'afficher sur le mur.');
}
/** Montre le clip dans l'écran Préparation s'il n'y est pas déjà. Jamais directement à la sortie : c'est toujours
 *  un geste de la régie (clic sur le clip, « Envoyer », colonne, conducteur) qui met quelque chose sur le mur. */
function showClip(clip) {
  if (!prepOn) return;
  const lid = Object.keys(show.cells).find(id => show.cells[id].includes(clip.id));
  if (lid && prep.layers[lid]?.clipId !== clip.id) launch(lid, clip.id);
}
async function pptCmd(clip, act) {
  try {
    const r = await fetch('/api/ppt/cmd?do=' + act + '&file=' + encodeURIComponent(clip.ppt), { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Commande refusée');
    pptState[clip.ppt] = { pos: j.pos, total: j.total };
    if (act === 'open') { clip.cropT = j.cropT; clip.cropB = j.cropB; clip.cropL = j.cropL || 0; clip.cropR = j.cropR || 0; commit(); }   // bandes noires d'une diapositive A4 / 4:3 comprises
    const el = $('#ppt-pos');
    if (el && sel?.kind === 'clip' && sel.id === clip.id) el.textContent = pptLabel(clip);
  } catch (e) { toast(e.message, 'err'); }
}
const pptLabel = clip => { const p = pptState[clip.ppt]; return p?.total ? `Diapositive ${p.pos} / ${p.total}` : ''; };
/** Clip PowerPoint actuellement à la sortie (sinon celui qu'on prépare ou qu'on a sélectionné) : c'est lui que pilotent ← →. */
function activePpt() {
  const pick = layers => show.layers.map(l => show.clips[layers[l.id]?.clipId]).find(c => c?.ppt);
  return pick(live.layers) || (prepOn && pick(prep.layers)) || (sel?.kind === 'clip' && show.clips[sel.id]?.ppt ? show.clips[sel.id] : null);
}
/** PowerPoint « en direct » : le serveur garde le fichier et lance le diaporama dans une fenêtre ; il reste à désigner cette fenêtre. */
function importPptLive(file) {
  toast(`Ouverture de « ${file.name} » dans PowerPoint…`, 'wait');
  return new Promise(resolve => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/ppt/open?name=' + encodeURIComponent(file.name));
    x.onload = () => {
      let r = {}; try { r = JSON.parse(x.responseText); } catch { /* réponse vide */ }
      if (x.status !== 200) { toast(file.name + ' : ' + (r.error || 'ouverture refusée'), 'err'); return resolve(); }
      pptState[r.file] = { pos: r.pos, total: r.total };
      addFiles(['ppt:' + r.file]);
      loadMedia().then(renderLib);                       // le PowerPoint apparaît aussi dans la médiathèque
      const clip = M.newClip('screen', { name: baseName(file.name), ppt: r.file, cropT: r.cropT, cropB: r.cropB, cropL: r.cropL || 0, cropR: r.cropR || 0 });
      addClipToGrid(clip, 1);
      if (show.clips[clip.id]) showClip(clip);          // visible tout de suite dans l'aperçu (un carton d'attente tant que la fenêtre n'est pas choisie)
      toast('Diaporama lancé dans PowerPoint. Dans les réglages à droite, clique sur « Choisir la fenêtre à afficher » puis sélectionne « Diaporama PowerPoint ».');
      resolve();
    };
    x.onerror = () => { toast('Ouverture interrompue (le serveur local tourne-t-il toujours ?)', 'err'); resolve(); };
    x.send(file);
  });
}
/* PDF lus par la régie elle-même avec pdf.js (Mozilla) : même résultat sur Mac et Windows, sans Office. Une image JPEG par page,
 * envoyée au serveur qui range le tout comme un document converti (data/documents/<nom>/). */
let pdfjsP = null;
function pdfjsLib() {
  if (!pdfjsP) pdfjsP = import('./pdf.min.js').then(m => { m.GlobalWorkerOptions.workerSrc = '/js/pdf.worker.min.js'; return m; }).catch(e => { pdfjsP = null; throw new Error('Lecteur PDF indisponible (' + e.message + ')'); });
  return pdfjsP;
}
async function pdfToDoc(blob, name) {
  const lib = await pdfjsLib();
  let pdf;
  try { pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise; }
  catch (e) { throw new Error(/password/i.test(e?.name || e?.message) ? 'Ce PDF est protégé par un mot de passe : enregistre-le sans protection puis réimporte-le.' : 'Ce PDF n\'a pas pu être lu (fichier abîmé ?).'); }
  const n = Math.min(pdf.numPages, 200), max = Math.max(show.comp.w, show.comp.h), tok = Math.random().toString(36).slice(2, 12);
  try {
    for (let i = 1; i <= n; i++) {
      toast(`Lecture de « ${name} » — page ${i} / ${n}`, 'wait');
      const page = await pdf.getPage(i), v1 = page.getViewport({ scale: 1 }), k = Math.min(4, max / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale: k }), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);   // fond blanc : une page sans fond reste lisible
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const jpg = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
      const r = await fetch(`/api/doc-page?tok=${tok}&i=${i}`, { method: 'POST', body: jpg });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Page refusée par le serveur');
      page.cleanup(); cv.width = cv.height = 0;
    }
  } finally { pdf.destroy(); }
  const r = await fetch(`/api/doc-done?tok=${tok}&name=${encodeURIComponent(name)}`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Document refusé par le serveur');
  if (n < pdf.numPages) toast(`« ${name} » : seules les 200 premières pages ont été gardées.`, 'err');
  return j;
}
/** PowerPoint, Word, Excel ou PDF → document à pages. PDF : lu ici (pdf.js). Office : converti par l'application installée ;
 *  quand le serveur ne sait pas faire les images (Windows), il renvoie un PDF que la régie lit elle-même. */
async function importDoc(file) {
  if (/\.pdf$/i.test(file.name)) return pdfToDoc(file, file.name);
  const max = Math.max(show.comp.w, show.comp.h);
  let r;
  try { r = await fetch('/api/import-doc?name=' + encodeURIComponent(file.name) + '&max=' + max, { method: 'POST', body: file }); }
  catch { throw new Error('Conversion interrompue (le serveur local tourne-t-il toujours ?)'); }
  if ((r.headers.get('content-type') || '').startsWith('application/pdf')) return pdfToDoc(await r.blob(), file.name);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Conversion refusée');
  return j;
}
async function uploadFiles(files) {
  const done = [], docs = [];
  for (const [i, f] of [...files].entries()) {
    try {
      if (/\.pp(tx?|sx?)$/i.test(f.name) && await ask('Importer « ' + f.name + ' »', 'Comment veux-tu afficher ce PowerPoint ?', [
        { value: 'live', label: 'En direct', hint: 'PowerPoint joue la présentation : animations, transitions et vidéos intégrées. PowerPoint doit rester ouvert.' },
        { value: 'images', label: 'En images', hint: 'Un document dont tu tournes les pages (◀ ▶ ou ← →). Images fixes, sans animations ; rien d\'autre à lancer pendant l\'événement.' },
      ]) === 'live') { await importPptLive(f); continue; }
      if (DOC_RE.test(f.name)) {
        toast(/\.pdf$/i.test(f.name) ? `Lecture de « ${f.name} »…` : `Conversion de « ${f.name} »… L'application Office va s'ouvrir un instant ; cela peut prendre une minute.`, 'wait');
        docs.push(await importDoc(f));
      } else done.push(await uploadOne(f, p => toast(`Import ${i + 1}/${files.length} — ${Math.round(p * 100)} %`)));
    } catch (e) { toast(f.name + ' : ' + e.message, 'err'); }
  }
  addFiles([...done.map(d => d?.name), ...docs.map(d => d?.id && fileKeyDoc(d))]);
  await loadMedia(); renderLib();
  const dups = done.filter(d => d?.dup).length, fresh = done.length - dups;
  if (done.length) toast((fresh ? (fresh > 1 ? fresh + ' médias importés' : 'Média importé') : '') + (dups ? `${fresh ? ' · ' : ''}${dups > 1 ? dups + ' fichiers étaient' : '1 fichier était'} déjà dans le dossier : réutilisé${dups > 1 ? 's' : ''}, pas de doublon` : ''));
  // Un document va dans la médiathèque (rien dans la grille) : on le pose ensuite où on veut, comme un média.
  const okDocs = docs.filter(d => d?.id);
  if (okDocs.length) toast(okDocs.length > 1 ? `${okDocs.length} documents ajoutés à la médiathèque : glisse-les sur une case ou une forme.` : `« ${baseName(okDocs[0].name)} » (${okDocs[0].pages} page${okDocs[0].pages > 1 ? 's' : ''}) ajouté à la médiathèque : glisse-le sur une case ou une forme.`);
  return done.map(d => media.find(m => m.name === d.name)).filter(Boolean);
}
function clipFromMedia(m) {
  return M.newClip(m.type, { src: m.url, name: baseName(m.name), fit: m.type === 'image' ? 'contain' : 'cover' });
}
const mediaByNames = names => names.map(n => media.find(m => m.name === n)).filter(Boolean);
/** Un diaporama à partir de plusieurs fichiers de la médiathèque (dans l'ordre de la liste). */
function slideshowFromMedia(list) {
  const items = list.map(m => ({ src: m.url, type: m.type, name: baseName(m.name) }));
  return M.newClip('slideshow', { name: 'Diaporama (' + items.length + ')', items });
}
/** Ajoute des fichiers à un diaporama existant. */
function addToSlideshow(clip, list) {
  const items = list.map(m => ({ src: m.url, type: m.type, name: baseName(m.name) }));
  if (!items.length) return;
  clip.items.push(...items);
  commit(); renderGrid();
  if (sel?.kind === 'clip' && sel.id === clip.id) renderInspector();
  toast(`${items.length} média${items.length > 1 ? 's ajoutés' : ' ajouté'} au diaporama « ${clipLabel(clip)} » (${clip.items.length} au total).`);
}
/** Pose des clips dans les premières cases libres d'un calque (ajoute des colonnes s'il le faut). Renvoie ceux qui ont trouvé une place. */
function addClipsToGrid(clips, layerIdx) {
  const layer = sel?.kind === 'layer' ? layerById(sel.id) : show.layers[Math.min(layerIdx, show.layers.length - 1)];
  const placed = [];
  for (const clip of clips) {
    let col = show.cells[layer.id].indexOf(null);
    if (col < 0) {
      if (show.cols >= 32) { toast('Ce calque est plein : libère une case.', 'err'); break; }
      show.cols++; for (const l of show.layers) show.cells[l.id].push(null);
      col = show.cols - 1;
    }
    show.clips[clip.id] = clip; show.cells[layer.id][col] = clip.id; placed.push(clip);
  }
  if (placed.length) { sel = { kind: 'clip', id: placed[placed.length - 1].id }; commit(); renderGrid(); renderInspector(); }
  return placed;
}
function addClipToGrid(clip, layerIdx) { addClipsToGrid([clip], layerIdx); }
const thumbMedia = m => (m.type === 'image' ? `<img src="${esc(m.url)}" loading="lazy" draggable="false" alt="">` : vthumb(m.url, 0.5));
/* ---------- miniatures des vidéos : des images fixes, fabriquées une seule fois ----------
 * Avant, chaque miniature était un vrai lecteur <video>, recréé à chaque reconstruction de la grille ou de la médiathèque (à chaque
 * clic). Avec une centaine de vidéos, Chromium n'ouvre que 6 connexions à la fois vers le serveur local : les miniatures restaient
 * noires (en attente) puis réapparaissaient, et la fenêtre de sortie — qui passe par les mêmes connexions — attendait ses images
 * vidéo plusieurs secondes : saccades de 3 à 6 s sur le mur (mesuré sous Windows : 33 miniatures bloquées, sortie > 12 s pour
 * démarrer une vidéo). Maintenant : une image JPEG par (fichier, instant), fabriquée une vidéo à la fois, gardée en mémoire et dans
 * le cache du navigateur (elle survit au redémarrage ; elle est refaite si le fichier change de taille). */
const vthumb = (src, t) => `<img class="vthumb" data-vsrc="${esc(src)}" data-t="${+t || 0}" draggable="false" alt="">`;
const vthumbMem = new Map(), vthumbWait = new Map(), vthumbQueue = [];   // clé → URL de l'image | 'err' ; clé → <img> en attente
let vthumbBusy = 0;
const vthumbCache = (async () => { try { return await caches.open('regie-vthumbs-v1'); } catch { return null; } })();
async function vthumbMake(src, t) {
  let size = '';
  try { size = (await fetch(src, { method: 'HEAD' })).headers.get('content-length') || ''; } catch { /* sans gravité */ }
  const key = `/__vthumb?src=${encodeURIComponent(src)}&t=${t}&n=${size}`, cache = await vthumbCache;
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return URL.createObjectURL(await hit.blob());
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  const wait = (ev, ms = 10000) => new Promise((ok, ko) => {
    const tm = setTimeout(() => ko(new Error('délai dépassé')), ms);
    v.addEventListener(ev, () => { clearTimeout(tm); ok(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(tm); ko(new Error(v.error?.message || 'illisible')); }, { once: true });
  });
  try {
    v.src = src;
    await wait('loadedmetadata');
    const at = Math.min(Math.max(0, t), Math.max(0, (v.duration || 0) - 0.1));
    if (at > 0) { const s = wait('seeked'); v.currentTime = at; await s; } else if (v.readyState < 2) await wait('loadeddata');
    const W = 320, H = Math.max(1, Math.round(W * (v.videoHeight || 9) / (v.videoWidth || 16)));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(v, 0, 0, W, H);
    const blob = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.8));
    if (!blob) throw new Error('image vide');
    cache?.put(key, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })).catch(() => {});
    return URL.createObjectURL(blob);
  } finally { v.removeAttribute('src'); v.load(); }                      // la connexion au serveur est rendue tout de suite
}
function vthumbApply(img) {
  const u = vthumbMem.get(img.dataset.k);
  if (u === 'err') img.classList.add('vthumb-err'); else if (u && img.getAttribute('src') !== u) img.src = u;
}
function vthumbPump() {
  while (vthumbBusy < 1 && vthumbQueue.length) {                         // une seule vidéo à la fois : 1 connexion au plus
    const { src, t, k } = vthumbQueue.shift(); vthumbBusy++;
    vthumbMake(src, t).then(u => vthumbMem.set(k, u), e => { vthumbMem.set(k, 'err'); console.warn(`Miniature impossible pour « ${decodeURIComponent(src.split('/').pop())} » : ${e.message}`); })
      .finally(() => { vthumbBusy--; for (const img of vthumbWait.get(k) || []) vthumbApply(img); vthumbWait.delete(k); vthumbPump(); });
  }
}
function vthumbHydrate(img) {
  const src = img.dataset.vsrc, t = +img.dataset.t || 0, k = src + '|' + t;
  if (!src) return;
  img.dataset.k = k;
  if (vthumbMem.has(k)) return vthumbApply(img);
  const w = vthumbWait.get(k);
  if (w) return void w.push(img);
  vthumbWait.set(k, [img]); vthumbQueue.push({ src, t, k }); vthumbPump();
}
// Toute miniature qui apparaît (grille, médiathèque, listes) reçoit son image : depuis la mémoire, sinon fabriquée dans la file.
new MutationObserver(ms => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.matches('img.vthumb')) vthumbHydrate(n);
    for (const img of n.querySelectorAll('img.vthumb')) vthumbHydrate(img);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
/** Ligne de médiathèque d'un document à pages : un seul élément, dont on tourne les pages. */
const docItem = d => `<div class="lib-item${libSel.has('doc:' + d.id) ? ' sel' : ''}" draggable="true" data-doc="${esc(d.id)}" title="Document à pages : glisse-moi sur une case ou une forme (ou double-clic). Coche pour sélectionner plusieurs fichiers.">
    <input type="checkbox" class="lib-ck" data-ck="${esc('doc:' + d.id)}"${libSel.has('doc:' + d.id) ? ' checked' : ''} title="Sélectionner">
    <div class="lib-th doc"><img src="${esc(docPageUrl(d.id, 0))}" loading="lazy" draggable="false" alt=""></div>
    <div class="lib-meta"><b>${esc(d.name)}</b><small>Document · ${d.pages} page${d.pages > 1 ? 's' : ''}</small></div>
    <button class="x" data-ren-doc="${esc(d.id)}" title="Renommer">✎</button><button class="x" data-del-doc="${esc(d.id)}" title="Retirer ce document de la régie">✕</button></div>`;
/** Ligne de médiathèque d'un PowerPoint « en direct » : se glisse dans la grille ou sur une forme comme un média. */
const presItem = p => `<div class="lib-item${libSel.has('ppt:' + p.name) ? ' sel' : ''}" draggable="true" data-ppt="${esc(p.name)}" title="PowerPoint en direct : glisse-moi sur une case ou une forme (ou double-clic). Coche pour sélectionner plusieurs fichiers.">
    <input type="checkbox" class="lib-ck" data-ck="${esc('ppt:' + p.name)}"${libSel.has('ppt:' + p.name) ? ' checked' : ''} title="Sélectionner">
    <div class="lib-th ppt"><span>PPT</span><img src="/api/ppt/thumb?name=${encodeURIComponent(p.name)}" loading="lazy" draggable="false" alt="" onerror="this.remove()"></div>
    <div class="lib-meta"><b>${esc(p.name)}</b><small>PowerPoint en direct · ${fmtSize(p.size)}</small></div>
    <button class="x" data-ren-ppt="${esc(p.name)}" title="Renommer">✎</button><button class="x" data-del-ppt="${esc(p.name)}" title="Retirer ce PowerPoint de la régie">✕</button></div>`;
/** Ligne de médiathèque d'une source en direct (caméra, carte HDMI) : se glisse dans la grille ou sur une forme comme un média. */
function camItem(c) {
  const on = camDevices.some(d => d.deviceId === c.deviceId);
  return `<div class="lib-item" draggable="true" data-cam="${esc(c.deviceId)}" title="Source en direct : glisse-moi sur une case ou une forme (ou double-clic). Rien n'est enregistré.">
    <div class="lib-th cam${on ? '' : ' off'}">${on ? `<video class="cam-thumb" data-dev="${esc(c.deviceId)}" muted autoplay playsinline></video>` : ''}<span>${/hdmi|capture|usb/i.test(c.label) ? 'HDMI' : 'CAM'}</span></div>
    <div class="lib-meta"><b>${esc(c.label)}</b><small>${on ? 'En direct · branchée' : 'En direct · non détectée (↻)'}</small></div>
    <button class="x" data-ren-cam="${esc(c.deviceId)}" title="Renommer cette source">✎</button><button class="x" data-del-cam="${esc(c.deviceId)}" title="Oublier cette source">✕</button></div>`;
}
/* ---------- vignettes vivantes : image réelle des caméras / cartes HDMI et des fenêtres capturées ---------- */
// Un petit flux (320×180) par appareil, partagé par toutes les vignettes (médiathèque + grille) ; Chrome n'ouvre la caméra
// qu'une fois pour tout le navigateur, donc la sortie et la préparation ne sont pas gênées.
const camThumbStreams = new Map();      // deviceId → MediaStream | Promise
function attachLiveThumbs() {
  const want = new Set();
  for (const v of $$('video.cam-thumb[data-dev]')) {
    const dev = v.dataset.dev, key = dev || '*';
    if (dev && !camDevices.some(d => d.deviceId === dev) && camDevices.length) continue;      // appareil débranché : vignette vide
    want.add(key);
    let s = camThumbStreams.get(key);
    if (!s) {
      s = navigator.mediaDevices.getUserMedia({ video: { ...(dev ? { deviceId: { exact: dev } } : {}), width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15 } }, audio: false })
        .then(st => { camThumbStreams.set(key, st); return st; })
        .catch(() => { camThumbStreams.delete(key); return null; });
      camThumbStreams.set(key, s);
    }
    Promise.resolve(s).then(st => { if (st && v.isConnected && v.srcObject !== st) { v.srcObject = st; v.parentElement.classList.add('live'); v.play().catch(() => {}); } });
  }
  for (const [key, s] of camThumbStreams) if (!want.has(key) && s instanceof MediaStream) { s.getTracks().forEach(t => t.stop()); camThumbStreams.delete(key); }
  for (const v of $$('video.cam-thumb[data-stream]')) {                 // fenêtre capturée : le flux choisi dans la régie
    const st = window.__ledStreams[v.dataset.stream];
    if (st?.active) { if (v.srcObject !== st) { v.srcObject = st; v.parentElement.classList.add('live'); v.play().catch(() => {}); } }
    else if (v.srcObject) { v.srcObject = null; v.parentElement.classList.remove('live'); }
  }
}
/* ---------- éléments créés (texte, horloge, effet, diaporama, fenêtre, source en direct) : rangés dans la médiathèque ---------- */
/** Ajoute un élément à la médiathèque (section « Éléments ») et ouvre ses réglages ; il n'entre dans la grille que quand on l'y pose. */
function addToPool(clip, quiet = false) {
  show.clips[clip.id] = clip;
  if (!show.pool.includes(clip.id)) show.pool.push(clip.id);
  sel = { kind: 'clip', id: clip.id };
  commit(); renderLib(); renderGrid(); renderInspector();
  if (!quiet) toast(`« ${clipLabel(clip)} » est dans la médiathèque : règle-le à droite, puis glisse-le sur une case ou une forme.`);
}
/** Copie d'un élément de la médiathèque, posée dans la grille : l'original reste disponible pour d'autres cases. */
function cloneClip(c) {
  const n = { ...JSON.parse(JSON.stringify(c)), id: M.uid() };
  if (c.type === 'screen' && window.__ledStreams[c.id]) window.__ledStreams[n.id] = window.__ledStreams[c.id];     // même fenêtre capturée
  return n;
}
/* ---------- renommer ce qui est dans la médiathèque ---------- */
async function apiRename(kind, name, to) {
  const r = await fetch(`/api/rename?kind=${kind}&name=${encodeURIComponent(name)}&to=${encodeURIComponent(to)}`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Renommage refusé (le serveur est-il à jour ? relance-le)');
  return j;
}
/** Renomme le fichier dans media/ et met à jour tous les clips (et diaporamas) qui l'utilisent, dans toutes les scènes. */
async function renameMedia(name) {
  const m = media.find(x => x.name === name); if (!m) return;
  const to = await askText('Nouveau nom du fichier', baseName(name));
  if (!to || !to.trim() || to.trim() === baseName(name)) return;
  try {
    const r = await apiRename('media', name, to.trim()), nb = baseName(r.name); let n = 0;
    for (const c of Object.values(show.clips)) {
      if (c.src === m.url) { c.src = r.url; if (c.name === baseName(name)) c.name = nb; n++; }
      for (const it of c.items || []) if (it.src === m.url) { it.src = r.url; if (it.name === baseName(name)) it.name = nb; n++; }
    }
    if (libSel.has(name)) { libSel.delete(name); libSel.add(r.name); }
    renameFileKey(name, r.name);
    await loadMedia(); renderLib();
    if (n) { commit(); renderGrid(); renderInspector(); }
    toast(`Renommé en « ${r.name} »${n ? ` — ${n} clip${n > 1 ? 's' : ''} mis à jour` : ''}.`);
  } catch (e) { toast(e.message, 'err'); }
}
async function renameDoc(id) {
  const d = docList.find(x => x.id === id); if (!d) return;
  const to = await askText('Nouveau nom du document', d.name);
  if (!to || !to.trim() || to.trim() === d.name) return;
  try {
    const r = await apiRename('doc', id, to.trim()); let n = 0;
    for (const c of Object.values(show.clips)) if (c.doc === id && c.name === baseName(d.name)) { c.name = baseName(r.name); n++; }
    await loadMedia(); renderLib();
    if (n) { commit(); renderGrid(); renderInspector(); }
    toast(`Document renommé « ${r.name} ».`);
  } catch (e) { toast(e.message, 'err'); }
}
async function renamePpt(name) {
  const to = await askText('Nouveau nom du PowerPoint', baseName(name));
  if (!to || !to.trim() || to.trim() === baseName(name)) return;
  try {
    const r = await apiRename('ppt', name, to.trim()); let n = 0;
    for (const c of Object.values(show.clips)) if (c.ppt === name) { c.ppt = r.name; if (c.name === baseName(name)) c.name = baseName(r.name); n++; }
    if (pptState[name]) { pptState[r.name] = pptState[name]; delete pptState[name]; }
    renameFileKey('ppt:' + name, 'ppt:' + r.name);
    await loadMedia(); renderLib();
    if (n) { commit(); renderGrid(); renderInspector(); }
    toast(`PowerPoint renommé « ${r.name} ». S'il est ouvert dans PowerPoint, clique sur « Relancer le diaporama ».`);
  } catch (e) { toast(e.message, 'err'); }
}
/** Nom affiché d'une source en direct (caméra, carte HDMI) : remplace le nom technique donné par le système. */
async function renameCam(id) {
  const k = camKnown.find(x => x.deviceId === id); if (!k) return;
  const to = await askText('Nom de cette source', k.label, { max: 60 });
  if (!to || !to.trim() || to.trim() === k.label) return;
  const old = k.label; k.label = to.trim().slice(0, 60); k.custom = true; saveCams(); let n = 0;
  for (const c of Object.values(show.clips)) if (c.type === 'camera' && c.deviceId === id) { c.deviceLabel = k.label; if (c.name === old || c.name === old.slice(0, 40)) c.name = k.label.slice(0, 40); n++; }
  renderLib();
  if (n) { commit(); renderGrid(); renderInspector(); }
  toast(`Source renommée « ${k.label} ».`);
}
function renderLib() {
  const item = m => `<div class="lib-item${libSel.has(m.name) ? ' sel' : ''}" draggable="true" data-media="${esc(m.name)}" title="Glisse-moi sur une case de la grille (ou double-clic). Coche pour sélectionner plusieurs fichiers.">
      <input type="checkbox" class="lib-ck" data-ck="${esc(m.name)}"${libSel.has(m.name) ? ' checked' : ''} title="Sélectionner">
      <div class="lib-th">${thumbMedia(m)}</div>
      <div class="lib-meta"><b>${esc(m.name)}</b><small>${m.type === 'video' ? 'Vidéo' : 'Image'} · ${fmtSize(m.size)}</small></div>
      <button class="x" data-ren="${esc(m.name)}" title="Renommer ce fichier">✎</button><button class="x" data-del="${esc(m.name)}" title="${perShowFiles() ? 'Retirer ce fichier du show' : 'Supprimer ce fichier'}">✕</button></div>`;
  const poolItem = c => `<div class="lib-item${sel?.kind === 'clip' && sel.id === c.id ? ' sel' : ''}" draggable="true" data-pool="${c.id}" title="Glisse-moi sur une case ou une forme (ou double-clic) ; un clic ouvre ses réglages à droite">
      <div class="lib-th pool">${thumb(c)}</div>
      <div class="lib-meta"><b>${esc(clipLabel(c))}</b><small>${esc(TYPE_NAME[c.type] || c.type)}</small></div>
      <button class="x" data-ren-pool="${c.id}" title="Renommer">✎</button><button class="x" data-del-pool="${c.id}" title="Retirer de la médiathèque">✕</button></div>`;
  const pool = show.pool.map(id => show.clips[id]).filter(Boolean);
  const poolSec = pool.length ? `<div class="lib-sec"><span>Éléments</span></div>` + pool.map(poolItem).join('') : '';
  const cams = `<div class="lib-sec"><span>Sources en direct</span><button class="btn sm" data-act="cams-detect" title="Rechercher les caméras et cartes de capture branchées">↻ Détecter</button></div>`
    + (camListed().length ? camListed().map(camItem).join('') : `<p class="empty sm">${perShowFiles() ? 'Aucune source en direct dans ce show : « Importer → Fichiers déjà importés… » ou « Capturer une source → En direct ».' : 'Branche une caméra ou une carte de capture HDMI : elle apparaît ici (sinon « Détecter »).'}</p>`);
  $('#lib').innerHTML = `
    <div class="panel-h"><h3>Médiathèque</h3><button class="btn sm panel-hide" data-act="hide-lib" title="Masquer la médiathèque (plus de place pour la grille)">‹</button><div class="lib-menu-wrap"><button class="btn sm gold" data-act="lib-menu" title="Importer des fichiers, capturer une source ou créer un élément">＋ Importer ▾</button>
      <div class="lib-menu" id="lib-menu" hidden>
        <button data-act="upload"><b>Fichiers de l'ordinateur…</b><small>Vidéos, images, PowerPoint, Word, Excel, PDF (plusieurs à la fois)</small></button>
        <button data-act="capture"><b>⏺ Capturer une source</b><small>Caméra, carte HDMI ou fenêtre : en direct, enregistrer, photo</small></button>
        ${perShowFiles() ? '<button data-act="pick-existing"><b>Fichiers déjà importés…</b><small>Reprendre un fichier déjà sur cet ordinateur (importé pour un autre show)</small></button>' : ''}
        <span class="lib-menu-sep"></span>
        <button data-new="slideshow"><b>Diaporama</b><small>Images et vidéos enchaînées avec un fondu</small></button>
        <button data-new="screen"><b>Fenêtre en direct</b><small>Une fenêtre ou un écran de l'ordinateur</small></button>
        <button data-new="text"><b>Texte</b></button>
        <button data-new="clock"><b>Horloge</b></button>
        <button data-new="countdown"><b>Compte à rebours</b></button>
        <button data-new="gen"><b>Effet visuel</b></button>
      </div></div></div>
    <div id="lib-selbar"></div>
    <div class="lib-list">${poolSec}${cams}<div class="lib-sec"><span>Fichiers</span></div>${media.length || pres.length || docList.length ? pres.map(presItem).join('') + docList.map(docItem).join('') + media.map(item).join('') : `<p class="empty">${perShowFiles() ? 'La médiathèque de ce show est vide.' : 'Aucun média pour l\'instant.'}<br>Clique sur « Importer » ou glisse ici tes vidéos (mp4, mov, webm), tes images, ou un PowerPoint, Word, Excel ou PDF.${perShowFiles() && mediaAll.length + presAll.length + docAll.length ? '<br>« Importer → Fichiers déjà importés… » reprend un fichier déjà sur cet ordinateur.' : ''}</p>`}</div>
    <div class="lib-foot"><button class="btn sm" data-act="open-folder">Ouvrir le dossier</button><button class="btn sm" data-act="sel-all" title="Tout sélectionner">☑ Tout</button><button class="btn sm" data-act="refresh" title="Relire le dossier">↻</button></div>`;
  refreshLibSel(); attachLiveThumbs();
}
/** Met à jour la sélection dans la liste (cases, surlignage, barre d'actions) sans tout redessiner. */
/** Clé de sélection d'une ligne de la médiathèque : nom du média, « doc:<id> » ou « ppt:<nom> » (les mêmes clés que show.files). */
const libKey = el => (el?.dataset.media != null ? el.dataset.media : el?.dataset.doc != null ? 'doc:' + el.dataset.doc : el?.dataset.ppt != null ? 'ppt:' + el.dataset.ppt : null);
/** Tous les fichiers de la médiathèque, dans l'ordre affiché (pour « Tout » et Maj-clic). */
const libOrder = () => [...pres.map(fileKeyPpt), ...docList.map(fileKeyDoc), ...media.map(m => m.name)];
function refreshLibSel() {
  const all = new Set(libOrder());
  for (const n of [...libSel]) if (!all.has(n)) libSel.delete(n);
  for (const el of $$('#lib .lib-item')) {
    const k = libKey(el); if (k == null) continue;
    const on = libSel.has(k);
    el.classList.toggle('sel', on);
    const ck = el.querySelector('.lib-ck'); if (ck) ck.checked = on;
  }
  const n = libSel.size;
  $('#lib-selbar').innerHTML = n ? `<div class="lib-selbar"><b>${n} sélectionné${n > 1 ? 's' : ''}</b>
      <button class="btn sm" data-act="sel-slideshow" title="Crée un diaporama avec les fichiers sélectionnés">▶ Diaporama</button>
      <button class="btn sm" data-act="sel-grid" title="Pose chaque fichier sélectionné dans une case de la grille">＋ Grille</button>
      <button class="btn sm danger" data-act="sel-del" title="${perShowFiles() ? 'Retirer les fichiers sélectionnés de ce show (touche Suppr) — ils restent sur l\'ordinateur' : 'Supprimer les fichiers sélectionnés (touche Suppr)'}">${perShowFiles() ? '✕ Retirer' : '🗑 Supprimer'}</button>
      <button class="x on" data-act="sel-clear" title="Désélectionner">✕</button></div>` : '';
}
const usedBy = url => Object.values(show.clips).filter(c => c.src === url || c.items?.some(i => i.src === url)).length;
/** Retire (médiathèque par show) ou supprime (ancien show) tous les fichiers cochés : médias, documents et PowerPoint. */
async function deleteSelection() {
  const keys = libOrder().filter(k => libSel.has(k));
  if (!keys.length) return;
  const docs = keys.filter(k => k.startsWith('doc:')).map(k => k.slice(4)), ppts = keys.filter(k => k.startsWith('ppt:')).map(k => k.slice(4)), names = keys.filter(k => !/^(doc|ppt):/.test(k));
  if (!docs.length && !ppts.length) return deleteMedia(names);                 // que des médias : le chemin habituel
  const used = names.reduce((a, n) => a + usedBy('/media/' + encodeURIComponent(n)), 0)
    + Object.values(show.clips).filter(c => (c.doc && docs.includes(c.doc)) || (c.ppt && ppts.includes(c.ppt))).length;
  const what = `ces ${keys.length} fichiers (${[names.length && names.length + ' média(s)', docs.length && docs.length + ' document(s)', ppts.length && ppts.length + ' PowerPoint'].filter(Boolean).join(', ')})`;
  if (perShowFiles()) {
    if (!confirm(`Retirer ${what} de ce show ?` + (used ? `\n\n${used} clip(s) de la grille les utilisent et deviendront noirs.` : '') + '\n\nLes fichiers restent sur l\'ordinateur.')) return;
    removeFiles(keys); libSel.clear(); renderLib();
    return toast(keys.length + ' fichiers retirés du show');
  }
  if (!confirm(`Supprimer ${what} de la régie ?` + (used ? `\n\n${used} clip(s) de la grille les utilisent et deviendront noirs.` : '') + '\n\nTes fichiers d\'origine ne sont pas touchés.')) return;
  const r = await Promise.allSettled([
    ...names.map(n => fetch('/api/media?name=' + encodeURIComponent(n), { method: 'DELETE' })),
    ...docs.map(id => fetch('/api/docs?id=' + encodeURIComponent(id), { method: 'DELETE' })),
    ...ppts.map(n => fetch('/api/ppt?name=' + encodeURIComponent(n), { method: 'DELETE' })),
  ].map(pr => pr.then(x => { if (!x.ok) throw new Error(); })));
  const ko = r.filter(x => x.status === 'rejected').length;
  libSel.clear(); await loadMedia(); renderLib();
  toast(ko ? `${ko} fichier(s) n'ont pas pu être supprimés.` : keys.length + ' fichiers supprimés', ko ? 'err' : '');
}
/** Supprime des fichiers de la médiathèque (après confirmation), en prévenant si des clips les utilisent. */
async function deleteMedia(names) {
  const list = mediaByNames(names);
  if (!list.length) return;
  const used = list.reduce((a, m) => a + usedBy(m.url), 0);
  const what = list.length === 1 ? `« ${list[0].name} »` : `ces ${list.length} fichiers`;
  if (perShowFiles()) {                                   // médiathèque par show : on retire du show, le fichier reste sur l'ordinateur
    if (!confirm(`Retirer ${what} de ce show ?` + (used ? `\n\n${used} clip(s) de la grille les utilisent et deviendront noirs.` : '') + '\n\nLe fichier reste sur l\'ordinateur : « Importer → Fichiers déjà importés… » pour le reprendre ou le supprimer définitivement.')) return;
    for (const m of list) libSel.delete(m.name);
    removeFiles(list.map(m => m.name)); renderLib();
    return toast(list.length > 1 ? list.length + ' fichiers retirés du show' : 'Fichier retiré du show');
  }
  if (!confirm(`Supprimer définitivement ${what} du dossier des médias ?` + (used ? `\n\n${used} clip(s) de la grille les utilisent et deviendront noirs.` : ''))) return;
  const r = await Promise.allSettled(list.map(m => fetch('/api/media?name=' + encodeURIComponent(m.name), { method: 'DELETE' }).then(x => { if (!x.ok) throw new Error(); })));
  const ko = r.filter(x => x.status === 'rejected').length;
  for (const m of list) libSel.delete(m.name);
  await loadMedia(); renderLib();
  toast(ko ? `${ko} fichier(s) n'ont pas pu être supprimés.` : (list.length > 1 ? list.length + ' fichiers supprimés' : 'Fichier supprimé'), ko ? 'err' : '');
}
/** « Fichiers déjà importés… » : tout ce que le dossier contient et qui n'est pas dans ce show — à reprendre, ou à supprimer définitivement du disque. */
async function openExistingFiles() {
  await loadMedia();
  const set = new Set(show.files || []);
  const rows = [
    ...camKnown.filter(c => !c.hidden && !set.has('cam:' + c.deviceId)).map(c => ({ key: 'cam:' + c.deviceId, label: c.label, sub: 'Source en direct' + (camDevices.some(d => d.deviceId === c.deviceId) ? ' · branchée' : ' · non détectée'), th: `<span class="lib-th cam off"><span>${/hdmi|capture|usb/i.test(c.label) ? 'HDMI' : 'CAM'}</span></span>`, del: async () => { c.hidden = true; c.used = false; saveCams(); return { ok: true }; } })),
    ...presAll.filter(p => !set.has(fileKeyPpt(p))).map(p => ({ key: fileKeyPpt(p), label: p.name, sub: 'PowerPoint en direct · ' + fmtSize(p.size), th: `<span class="lib-th ppt"><span>PPT</span></span>`, del: () => fetch('/api/ppt?name=' + encodeURIComponent(p.name), { method: 'DELETE' }) })),
    ...docAll.filter(d => !set.has(fileKeyDoc(d))).map(d => ({ key: fileKeyDoc(d), label: d.name, sub: `Document · ${d.pages} page${d.pages > 1 ? 's' : ''}`, th: `<span class="lib-th doc"><img src="${esc(docPageUrl(d.id, 0))}" loading="lazy" alt=""></span>`, del: () => fetch('/api/docs?id=' + encodeURIComponent(d.id), { method: 'DELETE' }) })),
    ...mediaAll.filter(m => !set.has(m.name)).map(m => ({ key: m.name, label: m.name, sub: (m.type === 'video' ? 'Vidéo' : 'Image') + ' · ' + fmtSize(m.size), th: `<span class="lib-th">${thumbMedia(m)}</span>`, del: () => fetch('/api/media?name=' + encodeURIComponent(m.name), { method: 'DELETE' }) })),
  ];
  const d = openBox(`<h3>Fichiers déjà importés</h3><p>${rows.length ? 'Fichiers présents sur cet ordinateur mais pas dans ce show. Coche ceux à reprendre.' : 'Tous les fichiers de l\'ordinateur sont déjà dans ce show.'}</p>
    <div class="pick-list">${rows.map((r, i) => `<label class="pick"><input type="checkbox" value="${i}">${r.th}<b>${esc(r.label)}</b><small>${esc(r.sub)}</small></label>`).join('')}</div>
    <div class="row">${rows.length ? '<button class="btn gold" data-ok="1">＋ Ajouter au show</button><button class="btn danger" data-wipe="1" title="Efface les fichiers cochés du disque : ils ne seront plus disponibles pour aucun show">🗑 Supprimer du disque</button>' : ''}<button class="btn" data-cancel="1">Fermer</button></div>`, 'pick');
  d.addEventListener('click', async e => {
    const picked = $$('input:checked', d).map(i => rows[+i.value]).filter(Boolean);
    if (e.target.closest('[data-cancel]')) return d.remove();
    if (e.target.closest('[data-ok]')) {
      if (!picked.length) return toast('Coche d\'abord un ou plusieurs fichiers.', 'err');
      d.remove(); addFiles(picked.map(r => r.key)); renderLib();
      return toast(picked.length > 1 ? picked.length + ' fichiers ajoutés au show' : 'Fichier ajouté au show');
    }
    if (e.target.closest('[data-wipe]')) {
      if (!picked.length) return toast('Coche d\'abord un ou plusieurs fichiers.', 'err');
      if (!confirm(`Supprimer définitivement ${picked.length === 1 ? '« ' + picked[0].label + ' »' : 'ces ' + picked.length + ' fichiers'} de l'ordinateur ?\n\nIls disparaîtront pour tous les shows. Cette action est irréversible (une source en direct est seulement oubliée : elle revient si on la réutilise).`)) return;
      d.remove();
      const r = await Promise.allSettled(picked.map(p => p.del().then(x => { if (!x.ok) throw new Error(); })));
      const ko = r.filter(x => x.status === 'rejected').length;
      await loadMedia(); renderLib();
      toast(ko ? `${ko} fichier(s) n'ont pas pu être supprimés.` : (picked.length > 1 ? picked.length + ' fichiers supprimés du disque' : 'Fichier supprimé du disque'), ko ? 'err' : '');
    }
  });
}
/* ---------- aperçu agrandi au survol d'une source ---------- */
let peekT = null, peekFor = null;
function peekContent(it) {
  const ds = it.dataset;
  if (ds.media != null) { const m = media.find(x => x.name === ds.media); if (!m) return null; return { html: m.type === 'image' ? `<img src="${esc(m.url)}" alt="">` : `<video src="${esc(m.url)}" muted autoplay loop playsinline></video>`, title: m.name }; }
  if (ds.cam != null) return { html: '<video class="pk-cam" muted autoplay playsinline></video>', title: camLabel(ds.cam), cam: ds.cam };
  if (ds.ppt != null) return { html: `<img src="/api/ppt/thumb?name=${encodeURIComponent(ds.ppt)}" alt="" onerror="this.replaceWith('PPT')">`, title: ds.ppt };
  if (ds.doc != null) { const d = docList.find(x => x.id === ds.doc); return d ? { html: `<img src="${esc(docPageUrl(d.id, 0))}" alt="">`, title: d.name } : null; }
  return null;
}
function showPeek(it) {
  const pk = $('#lib-peek'), c = peekContent(it);
  if (!c) return hidePeek();
  pk.innerHTML = `<div class="pk">${c.html}</div><b>${esc(c.title)}</b>`;
  if (c.cam) { const v = $('.pk-cam', pk), s = camThumbStreams.get(c.cam || '*'); if (s instanceof MediaStream) { v.srcObject = s; v.play().catch(() => {}); } }
  const r = it.getBoundingClientRect(), lib = $('#lib').getBoundingClientRect();
  pk.hidden = false;
  const h = pk.offsetHeight, top = Math.max(8, Math.min(innerHeight - h - 8, r.top - 10));
  pk.style.left = Math.round(lib.right + 8) + 'px'; pk.style.top = Math.round(top) + 'px';
  peekFor = it;
}
function hidePeek() { clearTimeout(peekT); peekT = null; peekFor = null; const pk = $('#lib-peek'); if (!pk.hidden) { pk.hidden = true; pk.innerHTML = ''; } }
function bindLib() {
  const lib = $('#lib');
  // Survol d'une source : après un court délai, un aperçu agrandi (image, vidéo qui joue, source en direct, PowerPoint, document).
  lib.addEventListener('mouseover', e => {
    const it = e.target.closest('.lib-item');
    if (!it || it === peekFor) return;
    clearTimeout(peekT);
    peekT = setTimeout(() => { if (it.isConnected && it.matches(':hover')) showPeek(it); }, 350);
  });
  lib.addEventListener('mouseout', e => { const it = e.target.closest('.lib-item'); if (it && !it.contains(e.relatedTarget)) hidePeek(); });
  lib.addEventListener('mouseleave', hidePeek);
  document.addEventListener('click', e => { const m = $('#lib-menu'); if (m && !m.hidden && !e.target.closest('.lib-menu-wrap')) m.hidden = true; });   // clic ailleurs : le menu se ferme
  addEventListener('keydown', e => { const m = $('#lib-menu'); if (e.key === 'Escape' && m && !m.hidden) m.hidden = true; });
  lib.addEventListener('dragstart', hidePeek);
  lib.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act, nw = e.target.closest('[data-new]')?.dataset.new, del = e.target.closest('[data-del]')?.dataset.del;
    const menu = $('#lib-menu');
    if (act === 'hide-lib') return togglePanel('lib', true);
    if (act === 'lib-menu') { menu.hidden = !menu.hidden; return; }
    if (menu && !menu.hidden && (act || nw)) menu.hidden = true;        // un choix dans le menu le referme
    if (act === 'upload') $('#file-input').click();
    if (act === 'refresh') { await loadMedia(); renderLib(); }
    if (act === 'cams-detect') {
      await listCams(true); renderLib();
      return toast(camDevices.length ? `${camDevices.length} source${camDevices.length > 1 ? 's' : ''} en direct : ${camDevices.map(d => d.label || 'Caméra').join(', ')}` : 'Aucune caméra ni carte de capture détectée. Vérifie le branchement et l\'autorisation de Chrome (Réglages Système → Confidentialité → Caméra).', camDevices.length ? '' : 'err');
    }
    const delCam = e.target.closest('[data-del-cam]')?.dataset.delCam;
    if (delCam) {
      if (perShowFiles()) { removeFiles(['cam:' + delCam]); renderLib(); return toast('Source retirée de ce show. « Importer → Fichiers déjà importés… » pour la reprendre.'); }
      const k = camKnown.find(x => x.deviceId === delCam); if (k) { k.hidden = true; k.used = false; saveCams(); } renderLib(); return toast('Source masquée. Elle reviendra si tu l\'utilises depuis « Capturer une source » (bouton « En direct »).');
    }
    if (act === 'open-folder') { await fetch('/api/open-media', { method: 'POST' }).catch(() => {}); toast(perShowFiles() ? 'Dépose tes fichiers dans ce dossier, puis « Importer → Fichiers déjà importés… » pour les ajouter à ce show.' : 'Dépose tes fichiers dans ce dossier puis clique sur ↻'); }
    if (act === 'capture') return openCaptureModal();
    if (act === 'pick-existing') return openExistingFiles();
    if (act === 'sel-all') { libSel = new Set(libOrder()); return refreshLibSel(); }
    if (act === 'sel-clear') { libSel.clear(); return refreshLibSel(); }
    if (act === 'sel-del') return deleteSelection();
    if (act === 'sel-grid') {                                   // médias, documents et PowerPoint cochés, chacun dans sa case
      const clips = libOrder().filter(k => libSel.has(k)).map(k => {
        if (k.startsWith('doc:')) { const d = docList.find(x => x.id === k.slice(4)); return d && docClip(d); }
        if (k.startsWith('ppt:')) return pptClip(k.slice(4));
        const m = media.find(x => x.name === k); return m && clipFromMedia(m);
      }).filter(Boolean);
      const placed = addClipsToGrid(clips, 1);
      for (const c of placed) if (c.ppt && show.clips[c.id]) pptCmd(c, 'open');      // un PowerPoint en direct se lance dans PowerPoint
      if (placed.length) toast(placed.length > 1 ? placed.length + ' clips posés dans la grille' : 'Clip posé dans la grille');
      return;
    }
    if (act === 'sel-slideshow') {
      const list = media.filter(m => libSel.has(m.name));
      if ([...libSel].some(k => /^(doc|ppt):/.test(k))) toast('Un diaporama ne prend que des images et des vidéos : les documents et PowerPoint cochés n\'y sont pas ajoutés.', list.length ? '' : 'err');
      if (!list.length) return;
      addClipToGrid(slideshowFromMedia(list), 1);
      libSel.clear(); refreshLibSel();
      toast(`Diaporama de ${list.length} média${list.length > 1 ? 's' : ''} posé dans la grille : règle la durée et le fondu à droite.`);
      return;
    }
    // Les éléments créés vont dans la médiathèque (section « Éléments »), jamais directement dans la grille : on les pose où on veut.
    if (nw === 'slideshow') { addToPool(M.newClip('slideshow')); return toast('Diaporama vide ajouté à la médiathèque : sélectionne des fichiers (cases à cocher) puis « ▶ Diaporama », ou glisse-les sur sa liste « Contenu » à droite.'); }
    if (nw === 'text') addToPool(M.newClip('text', { name: '', text: 'Votre texte' }));
    if (nw === 'clock') addToPool(M.newClip('text', { name: '', mode: 'clock', size: 22 }));
    if (nw === 'countdown') addToPool(M.newClip('text', { name: '', mode: 'countdown', size: 26 }));
    if (nw === 'camera') addToPool(M.newClip('camera'));
    if (nw === 'gen') addToPool(M.newClip('gen'));
    if (nw === 'screen') addToPool(M.newClip('screen'));
    const poolRen = e.target.closest('[data-ren-pool]')?.dataset.renPool, poolDel = e.target.closest('[data-del-pool]')?.dataset.delPool;
    if (poolRen) { const c = show.clips[poolRen]; const n = c && await askText('Nom de l\'élément', clipLabel(c), { max: 60 }); if (n && n.trim()) { c.name = n.trim().slice(0, 60); commit(); renderLib(); renderInspector(); } return; }
    if (poolDel) {
      const c = show.clips[poolDel]; if (!c) return;
      if (!confirm(`Retirer « ${clipLabel(c)} » de la médiathèque ?` + '\n\nLes copies déjà posées dans la grille restent.')) return;
      show.pool = show.pool.filter(x => x !== poolDel); if (sel?.kind === 'clip' && sel.id === poolDel) sel = null;
      cleanup(); commit(); renderLib(); renderInspector(); return;
    }
    const poolId = e.target.closest('.lib-item')?.dataset.pool;
    if (poolId && show.clips[poolId]) {                               // clic : on règle l'élément (à droite) sans le poser
      sel = { kind: 'clip', id: poolId }; renderGrid(); renderInspector(); renderCues();
      $$('#lib .lib-item.sel').forEach(x => x.classList.remove('sel')); e.target.closest('.lib-item').classList.add('sel');
      return;
    }
    const delDoc = e.target.closest('[data-del-doc]')?.dataset.delDoc;
    if (delDoc) {
      const used = Object.values(show.clips).filter(c => c.doc === delDoc).length;
      if (!confirm(`Retirer le document « ${docList.find(d => d.id === delDoc)?.name || delDoc} » ${perShowFiles() ? 'de ce show' : 'de la régie'} ?` + (used ? `\n\n${used} clip(s) de la grille l'utilisent et deviendront noirs.` : '') + '\n\nTon fichier d\'origine n\'est pas touché.')) return;
      if (perShowFiles()) { removeFiles(['doc:' + delDoc]); return renderLib(); }
      await fetch('/api/docs?id=' + encodeURIComponent(delDoc), { method: 'DELETE' }).catch(() => {});
      await loadMedia(); return renderLib();
    }
    const delPpt = e.target.closest('[data-del-ppt]')?.dataset.delPpt;
    if (delPpt) {
      const used = Object.values(show.clips).filter(c => c.ppt === delPpt).length;
      if (!confirm(`Retirer « ${delPpt} » ${perShowFiles() ? 'de ce show' : 'de la régie'} ?` + (used ? `\n\n${used} clip(s) de la grille l'utilisent : ils ne pourront plus relancer ce diaporama.` : '') + '\n\nTon fichier d\'origine n\'est pas touché.')) return;
      if (perShowFiles()) { removeFiles(['ppt:' + delPpt]); return renderLib(); }
      await fetch('/api/ppt?name=' + encodeURIComponent(delPpt), { method: 'DELETE' }).catch(() => {});
      await loadMedia(); return renderLib();
    }
    if (del) return deleteMedia([del]);
    const ds = e.target.closest('[data-ren],[data-ren-doc],[data-ren-ppt],[data-ren-cam]')?.dataset;
    if (ds) { e.stopPropagation(); return ds.ren != null ? renameMedia(ds.ren) : ds.renDoc != null ? renameDoc(ds.renDoc) : ds.renPpt != null ? renamePpt(ds.renPpt) : renameCam(ds.renCam); }
    if (act || nw) return;
    // Sélection : case à cocher = ajoute/retire ; clic = ce fichier seul ; ⌘/Ctrl-clic = ajoute/retire ; Maj-clic = plage.
    const ck = e.target.closest('[data-ck]')?.dataset.ck, it = libKey(e.target.closest('.lib-item'));
    if (it == null) return;
    if (ck || e.metaKey || e.ctrlKey) { if (libSel.has(it)) libSel.delete(it); else libSel.add(it); }
    else if (e.shiftKey && libLast) {
      const order = libOrder(), a = order.indexOf(libLast), b = order.indexOf(it);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) libSel.add(order[i]);
    } else libSel = new Set([it]);
    libLast = it;
    refreshLibSel();
  });
  lib.addEventListener('dblclick', e => {
    const name = e.target.closest('.lib-item')?.dataset.media, m = media.find(x => x.name === name);
    if (m && !e.target.closest('.x, .lib-ck')) addClipToGrid(clipFromMedia(m), 1);
    const docD = docList.find(d => d.id === e.target.closest('.lib-item')?.dataset.doc);
    if (docD && !e.target.closest('.x')) addDocClip(docD);
    const pptName = e.target.closest('.lib-item')?.dataset.ppt;
    if (pptName && !e.target.closest('.x')) {
      const c = pptClip(pptName);
      addClipToGrid(c, 1);
      if (show.clips[c.id]) { showClip(c); pptCmd(c, 'open'); }
    }
    const camId = e.target.closest('.lib-item')?.dataset.cam;
    if (camId && !e.target.closest('.x')) {
      const c = camClip(camId);
      addClipToGrid(c, 1);
      if (show.clips[c.id]) showClip(c);
    }
    const poolId = e.target.closest('.lib-item')?.dataset.pool;
    if (poolId && show.clips[poolId] && !e.target.closest('.x')) { const c = cloneClip(show.clips[poolId]); addClipToGrid(c, 1); if (show.clips[c.id]) showClip(c); }
  });
  lib.addEventListener('dragstart', e => {
    const name = e.target.closest('.lib-item')?.dataset.media;
    const poolDrag = e.target.closest('.lib-item')?.dataset.pool;
    if (poolDrag) { e.dataTransfer.setData('application/x-led-pool', poolDrag); e.dataTransfer.effectAllowed = 'copy'; }
    const pptName = e.target.closest('.lib-item')?.dataset.ppt;
    if (pptName) { e.dataTransfer.setData('application/x-led-ppt', pptName); e.dataTransfer.effectAllowed = 'copy'; }
    const camDrag = e.target.closest('.lib-item')?.dataset.cam;
    if (camDrag) { e.dataTransfer.setData('application/x-led-cam', camDrag); e.dataTransfer.effectAllowed = 'copy'; }
    const docDrag = e.target.closest('.lib-item')?.dataset.doc;
    if (docDrag) { e.dataTransfer.setData('application/x-led-doc', docDrag); e.dataTransfer.effectAllowed = 'copy'; }
    if (!name) return;
    e.dataTransfer.setData('application/x-led-media', name); e.dataTransfer.effectAllowed = 'copy';
    // Plusieurs fichiers sélectionnés : on les glisse tous (déposés sur une case → diaporama ; sur un diaporama → ajoutés).
    if (libSel.has(name) && libSel.size > 1) e.dataTransfer.setData('application/x-led-media-list', JSON.stringify(media.filter(m => libSel.has(m.name)).map(m => m.name)));
  });
  lib.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); lib.classList.add('drop'); } });
  lib.addEventListener('dragleave', () => lib.classList.remove('drop'));
  lib.addEventListener('drop', e => { lib.classList.remove('drop'); if (e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); } });
  $('#file-input').addEventListener('change', e => { if (e.target.files.length) uploadFiles(e.target.files); e.target.value = ''; });
}

/* ---------- grille de clips ---------- */
function thumb(c) {
  if (c.type === 'image') return `<img src="${esc(c.src)}" loading="lazy" draggable="false" alt="">`;
  if (c.type === 'video') return vthumb(c.src, +c.start > 0 ? +c.start : 0.5);   // vignette = image du point de départ (image fixe, voir vthumb)
  if (c.type === 'doc') return `<img src="${esc(docPageUrl(c.doc, c.page || 0))}" loading="lazy" draggable="false" alt="">`;
  if (c.type === 'slideshow') {
    const f = c.items?.[0];
    return `<div class="th-ss">${f ? (f.type === 'image' ? `<img src="${esc(f.src)}" loading="lazy" draggable="false" alt="">` : vthumb(f.src, 0.5)) : ''}<span class="th-ss-n">${c.items?.length || 0}</span></div>`;
  }
  if (c.type === 'gen') return `<div class="th-gen" style="background:linear-gradient(135deg, ${hex(c.colorA)}, ${hex(c.colorB)})"></div>`;
  if (c.type === 'text') return `<div class="th-text" style="color:${hex(c.color)}">${esc(c.mode === 'clock' ? '12:34' : c.mode === 'countdown' ? countdownStart(c) : String(c.text || '').slice(0, 40))}</div>`;
  // Caméra / carte HDMI et fenêtre capturée : la vignette montre l'image en direct (voir attachLiveThumbs).
  if (c.type === 'camera') return `<div class="th-cam"><video class="cam-thumb" data-dev="${esc(c.deviceId || '')}" muted autoplay playsinline></video><span>CAM</span></div>`;
  return `<div class="th-cam"><video class="cam-thumb" data-stream="${esc(c.id)}" muted autoplay playsinline></video><span>${c.ppt ? 'POWERPOINT' : 'EN DIRECT'}</span></div>`;
}
/** Temps de départ d'un compte à rebours, tel qu'il s'affichera (vignette) : la durée réglée, ou l'heure visée. */
function countdownStart(c) {
  if (c.cdMode === 'heure') return '→ ' + (c.cdTime || '--:--');
  const s = Math.max(0, Math.round((+c.cdMin || 0) * 60)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
}
function renderGrid() {
  const cols = show.cols;
  let h = '<div class="g-corner"><button class="btn sm" data-act="add-layer" title="Ajouter un calque par-dessus les autres">＋ Calque</button><span class="head-resizer" title="Tire pour élargir ou rétrécir la colonne des calques (double-clic : largeur d\'origine)"></span></div>';
  for (let i = 0; i < cols; i++) h += `<button class="g-col" data-col="${i}" title="Afficher la colonne ${i + 1} à la place du reste${i < 9 ? ' (touche ' + (i + 1) + ')' : ''} — Maj+clic : directement à la sortie">▶ ${i + 1}</button>`;
  h += '<button class="g-col add" data-act="add-col" title="Ajouter une colonne">＋</button>';
  for (const l of [...show.layers].reverse()) {
    h += `<div class="l-head${sel?.kind === 'layer' && sel.id === l.id ? ' sel' : ''}" data-layer="${l.id}" draggable="true" title="Glisse cette ligne sur une autre pour changer l'ordre des calques (celui du haut passe devant)">
        <div class="l-top"><span class="l-move"><button class="l-mv" data-act="row-up" title="Monter ce calque (passe devant)"${show.layers.indexOf(l) === show.layers.length - 1 ? ' disabled' : ''}>▲</button><button class="l-mv" data-act="row-down" title="Descendre ce calque (passe derrière)"${show.layers.indexOf(l) === 0 ? ' disabled' : ''}>▼</button></span>
          <button class="l-name" data-act="sel-layer" title="${esc(l.name)} — régler ce calque (mélange, fondu, effets)">${esc(l.name)}${l.zone && zoneName(l.zone) ? `<small class="l-zone">→ ${esc(zoneName(l.zone))}</small>` : ''}${(() => { const hid = show.outputs.filter(o => o.hidden.includes(l.id)); return hid.length ? `<small class="l-out" title="Masqué sur : ${esc(hid.map(o => o.name).join(', '))}">⊘ ${esc(hid.map(o => o.name).join(', '))}</small>` : ''; })()}</button>
          <button class="l-btn${l.mute ? ' on' : ''}" data-act="mute" title="Masquer ce calque">M</button>
          <button class="l-btn" data-act="eject" title="Arrêter ce calque (fondu vers le vide)">■</button></div>
        <input type="range" class="l-op" min="0" max="1" step="0.01" value="${+l.opacity}" title="Opacité du calque">
      </div>`;
    show.cells[l.id].forEach((id, col) => {
      const c = show.clips[id];
      h += c ? `<div class="cell${sel?.kind === 'clip' && sel.id === id ? ' sel' : ''}" data-layer="${l.id}" data-col="${col}" data-clip="${id}" draggable="true">
          <div class="c-th">${thumb(c)}</div><div class="c-bar"><i></i></div>
          <div class="c-name">${c.retour ? '<span class="tag ret" title="Aussi sur l\'écran retour">R</span>' : ''}<span class="tag">${TYPE_TAG[c.type]}</span>${esc(clipLabel(c))}</div>
          ${hasClock(c) ? '<button class="c-pause" title="Pause / reprise"></button><button class="c-restart" title="Recommencer (compte à rebours : remis au départ, en attente de l\'envoi)">↺</button>' : ''}<button class="c-stop" title="Éteindre ce clip (fondu vers le vide) — en mode Préparation : retiré de la préparation ; Maj+clic : coupé directement à la sortie">■</button><button class="c-edit" title="Régler ce clip sans le lancer">✎</button><button class="c-x" title="Retirer de la grille">✕</button></div>`
        : `<div class="cell empty" data-layer="${l.id}" data-col="${col}"></div>`;
    });
    h += '<div class="g-fill"></div>';
  }
  $('#grid').innerHTML = `<div class="grid" style="--cols:${cols}">${h}</div>`;
  updatePlaying(); attachLiveThumbs();
}
function updatePlaying() {
  for (const el of $$('#grid .cell')) {
    const id = el.dataset.clip, lid = el.dataset.layer, onLive = !!id && clipOn(live.layers, lid) === id, onPrep = prepOn && !!id && clipOn(prep.layers, lid) === id;
    el.classList.toggle('playing', onLive);
    el.classList.toggle('staged', onPrep && !onLive);              // préparé, pas encore à la sortie
    el.classList.toggle('leaving', prepOn && onLive && !onPrep);   // à la sortie, quittera l'écran au prochain envoi
    el.classList.toggle('paused', (onLive && !!live.layers[lid]?.pausedAt) || (onPrep && !onLive && !!prep.layers[lid]?.pausedAt));
  }
  // Panneau à côté des écrans, volontairement réduit : « Envoyer » et « Tout arrêter ». (Mode Préparation et Mire : Réglages / Mapping.)
  const pending = prepOn && prepDiffers();
  const tk = show.take || { mode: 'fade', dur: 0.5 }, cut = tk.mode === 'cut';
  $('#mon-side').innerHTML = `${prepOn ? `<button class="btn take${pending ? ' pending' : ''}" data-act="take" title="Envoie à la sortie ce qui est préparé (touche Entrée) — ${cut ? 'coupure franche' : 'fondu de ' + String(tk.dur).replace('.', ',') + ' s'}">Envoyer à la sortie ▶<small>Entrée · ${cut ? 'coupure' : 'fondu ' + String(tk.dur).replace('.', ',') + ' s'}</small></button>
    <div class="take-tr"><div class="seg"><button class="${cut ? '' : 'on'}" data-act="tr-fade" title="Fondu enchaîné entre l'ancienne et la nouvelle image">Fondu</button><button class="${cut ? 'on' : ''}" data-act="tr-cut" title="Changement instantané, sans fondu">Coupure</button></div>
      <label class="tr-dur" title="Durée du fondu (secondes)"><input type="number" id="tr-dur" min="0" max="10" step="0.1" value="${tk.dur}"${cut ? ' disabled' : ''}> s</label></div>` : ''}
    <div class="mon-btns"><button class="btn sm" data-act="stop-all">■ Tout arrêter</button>
    <label class="chk" title="Affiche la barre Formes (ajouter, dessiner, fusionner des formes) sous les écrans"><input type="checkbox" id="shapebar-on"${shapeBarOn ? ' checked' : ''}> Formes</label></div>`;
  $('#mon-tag').textContent = live.test ? 'MIRE' : live.blackout ? 'NOIR' : '';
  applyShapeBar(); renderOutSel();
}
/** Écran « Sortie » de la régie : avec plusieurs sorties, un petit menu choisit laquelle on regarde (la LED par défaut). */
function renderOutSel() {
  const sel2 = $('#mon-outsel'); if (!sel2) return;
  if (!show.outputs.some(o => o.id === monOut)) monOut = 'main';
  sel2.hidden = show.outputs.length < 2;
  const html = show.outputs.map(o => `<option value="${esc(o.id)}"${o.id === monOut ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
  if (sel2.innerHTML !== html) sel2.innerHTML = html;
  $('#mon-out .mon-label').textContent = monOut === 'main' ? 'Sortie' : 'Sortie · ' + M.outputById(show, monOut).name;
}
/** Barre Formes sous les écrans : masquée par défaut, affichée par la case « Formes » (mémorisé). */
let shapeBarOn = localStorage.getItem('regieLed.shapebar') === '1';
function applyShapeBar() { const b = $('#shapebar'); if (b) b.hidden = !shapeBarOn; }
function setCell(layerId, col, clipId) { show.cells[layerId][col] = clipId; }
function bindGrid() {
  const grid = $('#grid');
  // Largeur de la colonne des calques : poignée à droite de « ＋ Calque », mémorisée (double-clic = largeur d'origine).
  const applyHeadW = w => { if (w) grid.style.setProperty('--headw', w + 'px'); else grid.style.removeProperty('--headw'); };
  applyHeadW(+localStorage.getItem('regieLed.headW') || 0);
  grid.addEventListener('pointerdown', e => {
    const hz = e.target.closest('.head-resizer'); if (!hz) return;
    e.preventDefault(); e.stopPropagation(); hz.setPointerCapture(e.pointerId); hz.classList.add('on'); document.body.classList.add('resizing');
    const x0 = e.clientX, w0 = grid.querySelector('.g-corner').getBoundingClientRect().width;
    const move = ev => { const w = Math.round(Math.max(110, Math.min(420, w0 + ev.clientX - x0))); applyHeadW(w); try { localStorage.setItem('regieLed.headW', String(w)); } catch { /* sans gravité */ } };
    const up = () => { hz.classList.remove('on'); document.body.classList.remove('resizing'); hz.removeEventListener('pointermove', move); hz.removeEventListener('pointerup', up); hz.removeEventListener('pointercancel', up); };
    hz.addEventListener('pointermove', move); hz.addEventListener('pointerup', up); hz.addEventListener('pointercancel', up);
  }, true);
  grid.addEventListener('dblclick', e => { if (e.target.closest('.head-resizer')) { applyHeadW(0); try { localStorage.removeItem('regieLed.headW'); } catch { /* sans gravité */ } } });
  grid.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const head = e.target.closest('.l-head'), cell = e.target.closest('.cell'), colBtn = e.target.closest('.g-col[data-col]');
    if (act === 'add-layer') {
      if (show.layers.length >= MAX_LAYERS) return toast(MAX_LAYERS + ' calques maximum.', 'err');
      const l = M.newLayer('Calque ' + (show.layers.length + 1));
      show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null);
      sel = { kind: 'layer', id: l.id };
      commit(); renderGrid(); renderInspector(); return;
    }
    if (act === 'add-col') {
      if (show.cols >= 32) return toast('32 colonnes maximum.', 'err');
      show.cols++; for (const l of show.layers) show.cells[l.id].push(null);
      commit(); renderGrid(); return;
    }
    if (colBtn) return launchColumn(+colBtn.dataset.col, e.shiftKey);
    if (head) {
      const id = head.dataset.layer, l = layerById(id);
      if (act === 'eject') return eject(id);
      if (act === 'mute') { l.mute = !l.mute; commit(); renderGrid(); return; }
      if (act === 'row-up' || act === 'row-down') { if (moveIn(show.layers, l, act === 'row-up' ? 1 : -1)) { commit(); renderGrid(); renderCues(); if (sel?.kind === 'layer') renderInspector(); } return; }
      if (act === 'sel-layer') { sel = { kind: 'layer', id }; renderGrid(); renderInspector(); }
      return;
    }
    if (cell?.dataset.clip) {
      const { layer, col, clip } = cell.dataset;
      if (e.target.closest('.c-x')) { setCell(layer, +col, null); cleanup(); commit(); renderGrid(); renderInspector(); renderCues(); return; }
      if (e.target.closest('.c-stop')) return stopClip(layer, clip, e.shiftKey);
      if (e.target.closest('.c-pause')) return pauseToggle(show.clips[clip]);
      if (e.target.closest('.c-restart')) return restartClip(show.clips[clip]);
      const changed = !(sel?.kind === 'clip' && sel.id === clip);
      sel = { kind: 'clip', id: clip };
      if (!e.target.closest('.c-edit')) launch(layer, clip);
      if (changed) { $$('#grid .cell.sel, #grid .l-head.sel').forEach(x => x.classList.remove('sel')); cell.classList.add('sel'); renderInspector(); renderCues(); }
    }
  });
  grid.addEventListener('input', e => {
    if (!e.target.classList.contains('l-op')) return;
    layerById(e.target.closest('.l-head').dataset.layer).opacity = +e.target.value; commit();
  });
  grid.addEventListener('dragstart', e => {
    const cell = e.target.closest('.cell[data-clip]');
    if (cell) { e.dataTransfer.setData('application/x-led-cell', cell.dataset.layer + ':' + cell.dataset.col); e.dataTransfer.effectAllowed = 'move'; return; }
    const head = e.target.closest('.l-head');                        // une ligne de calque se glisse sur une autre pour changer l'ordre
    if (head && !e.target.closest('input')) { e.dataTransfer.setData('application/x-led-layer', head.dataset.layer); e.dataTransfer.effectAllowed = 'move'; }
  });
  const okDrag = e => ['application/x-led-media', 'application/x-led-ppt', 'application/x-led-doc', 'application/x-led-cam', 'application/x-led-pool', 'application/x-led-cell', 'Files'].some(t => e.dataTransfer.types.includes(t));
  grid.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('application/x-led-layer')) {
      const row = e.target.closest('.l-head, .cell');
      if (!row) return;
      e.preventDefault();
      const head = $(`#grid .l-head[data-layer="${row.dataset.layer}"]`);
      $$('#grid .l-head.over').forEach(x => x !== head && x.classList.remove('over'));
      head?.classList.add('over');
      return;
    }
    const cell = e.target.closest('.cell');
    if (!cell || !okDrag(e)) return;
    e.preventDefault();
    $$('#grid .cell.over').forEach(x => x !== cell && x.classList.remove('over'));
    cell.classList.add('over');
  });
  grid.addEventListener('dragleave', e => e.target.closest('.cell')?.classList.remove('over'));
  grid.addEventListener('drop', async e => {
    const movedLayer = e.dataTransfer.getData('application/x-led-layer');
    if (movedLayer) {                                                 // dépôt d'une ligne de calque : prend la place de la ligne visée
      e.preventDefault(); $$('#grid .l-head.over').forEach(x => x.classList.remove('over'));
      const target = e.target.closest('.l-head, .cell')?.dataset.layer, from = layerById(movedLayer), to = target && layerById(target);
      if (!from || !to || from === to) return;
      const up = show.layers.indexOf(from) < show.layers.indexOf(to);        // vers le haut de la grille (devant) → se place devant la ligne visée
      show.layers.splice(show.layers.indexOf(from), 1); show.layers.splice(show.layers.indexOf(to) + (up ? 1 : 0), 0, from);
      commit(); renderGrid(); renderCues(); if (sel?.kind === 'layer') renderInspector();
      return;
    }
    const cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault(); cell.classList.remove('over');
    const layerId = cell.dataset.layer, col = +cell.dataset.col;
    const from = e.dataTransfer.getData('application/x-led-cell'), name = e.dataTransfer.getData('application/x-led-media');
    const list = e.dataTransfer.getData('application/x-led-media-list');
    let names = [];
    try { names = list ? JSON.parse(list) : name ? [name] : []; } catch { names = name ? [name] : []; }
    const target = show.clips[cell.dataset.clip];
    let clip = null;
    if (from) {
      const [fl, fc] = from.split(':');
      if (!show.cells[fl]) return;
      const a = show.cells[fl][+fc], b = show.cells[layerId][col];
      setCell(layerId, col, a); setCell(fl, +fc, b);                    // échange des deux cases
    } else if (names.length && target?.type === 'slideshow') {
      return addToSlideshow(target, mediaByNames(names));             // déposé sur un diaporama : on l'y ajoute
    } else if (names.length > 1) {
      clip = slideshowFromMedia(mediaByNames(names));                  // plusieurs fichiers d'un coup : un diaporama
      toast(`Diaporama de ${clip.items.length} médias : règle la durée et le fondu à droite.`);
    } else if (name) {
      const m = media.find(x => x.name === name);
      if (m) clip = clipFromMedia(m);
    } else if (docList.some(d => d.id === e.dataTransfer.getData('application/x-led-doc'))) {
      clip = docClip(docList.find(d => d.id === e.dataTransfer.getData('application/x-led-doc')));      // document à pages glissé depuis la médiathèque
    } else if (e.dataTransfer.getData('application/x-led-ppt')) {
      clip = pptClip(e.dataTransfer.getData('application/x-led-ppt'));      // PowerPoint en direct glissé depuis la médiathèque
    } else if (e.dataTransfer.getData('application/x-led-cam')) {
      clip = camClip(e.dataTransfer.getData('application/x-led-cam'));      // caméra / carte HDMI glissée depuis la médiathèque
    } else if (show.clips[e.dataTransfer.getData('application/x-led-pool')]) {
      clip = cloneClip(show.clips[e.dataTransfer.getData('application/x-led-pool')]);   // élément créé : une copie va dans la case, l'original reste dans la médiathèque
    } else if (e.dataTransfer.files.length) {
      const [m] = await uploadFiles(e.dataTransfer.files);
      if (m) clip = clipFromMedia(m);
    }
    if (clip) { show.clips[clip.id] = clip; setCell(layerId, col, clip.id); sel = { kind: 'clip', id: clip.id }; }
    if (clip?.ppt) setTimeout(() => { if (show.clips[clip.id]) pptCmd(clip, 'open'); }, 0);      // lance (ou retrouve) son diaporama dans PowerPoint
    cleanup(); commit(); renderGrid(); renderInspector();
  });
  $('#mon-side').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'stop-all') stopAll();
    if (act === 'take') take();
    if (act === 'tr-fade' || act === 'tr-cut') { show.take = { ...(show.take || { dur: 0.5 }), mode: act === 'tr-cut' ? 'cut' : 'fade' }; commit(); updatePlaying(); }
  });
  $('#mon-outsel')?.addEventListener('change', e => { monOut = e.target.value; renderOutSel(); });
  $('#mon-side').addEventListener('change', e => {
    if (e.target.id === 'tr-dur') {                          // durée du fondu de « Envoyer »
      show.take = { ...(show.take || {}), mode: 'fade', dur: M.clamp(Math.round((+e.target.value || 0) * 10) / 10, 0, 10) };
      commit(); updatePlaying(); return;
    }
    if (e.target.id !== 'shapebar-on') return;
    shapeBarOn = e.target.checked; try { localStorage.setItem('regieLed.shapebar', shapeBarOn ? '1' : '0'); } catch { /* sans gravité */ }
    applyShapeBar(); if (shapeBarOn) renderShapeBar(); else cancelDraw();
  });
}

/** Crée un calque dédié à une zone du mapping (appelé depuis l'onglet Mapping). */
function addLayerForZone(zone) {
  if (show.layers.length >= MAX_LAYERS) return toast(MAX_LAYERS + ' calques maximum.', 'err');
  const l = M.newLayer(zone.name); l.zone = zone.id;
  show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null);
  sel = { kind: 'layer', id: l.id };
  commit(); renderGrid(); renderInspector();
  toast(`Calque « ${zone.name} » créé : dépose-y les clips de cet écran (onglet Régie).`);
}

/* ---------- conducteur (affichage) ---------- */
function renderCues() {
  const list = show.cues.map((c, i) => `<li class="cue${i === live.cue ? ' current' : ''}${prepOn && i === prepCue ? ' staged' : ''}${sel?.kind === 'cue' && sel.id === c.id ? ' sel' : ''}" data-cue="${i}" draggable="true" title="Glisse pour changer l'ordre ; clic = réglages ; ▶ ou double-clic = lancer">
      <span class="n">${i + 1}</span>
      <div class="cue-txt"><b>${esc(c.name)}</b><small>${esc(cueSummary(c))}${c.auto > 0 ? ' · suite auto ' + c.auto + ' s' : ''}</small></div>
      <button class="cue-go" title="${prepOn ? 'Préparer cette séquence dans l\'aperçu (puis « Envoyer »)' : 'Envoyer cette séquence à l\'écran'}">▶</button></li>`).join('');
  $('#cues').innerHTML = `
    <div class="panel-h"><h3>Conducteur</h3><div><button class="btn sm gold" data-act="capture" title="Ajoute ce qui joue en ce moment comme nouvelle séquence">＋ Capturer</button><button class="btn sm panel-hide" data-act="hide-right" title="Masquer le conducteur et les réglages (plus de place pour la grille)">›</button></div></div>
    <div class="cond-bar"><select id="cond-sel" title="Conducteur ouvert : Espace / « Suivant » déroule cette liste">${show.conductors.map(c => `<option value="${esc(c.id)}"${c.id === show.condId ? ' selected' : ''}>${esc(c.name)} (${c.cues.length})</option>`).join('')}</select>
      <button class="btn sm" data-act="cond-new" title="Nouveau conducteur (Jour 2, Plan B…)">＋</button><button class="btn sm" data-act="cond-ren" title="Renommer ce conducteur">✎</button><button class="btn sm" data-act="cond-dup" title="Dupliquer ce conducteur (par exemple pour un plan B)">⧉</button><button class="btn sm danger" data-act="cond-del" title="Supprimer ce conducteur"${show.conductors.length <= 1 ? ' disabled' : ''}>✕</button></div>
    <div class="cue-nav"><button class="btn" data-act="prev" title="Séquence précédente">◀</button>
      <button class="btn next" data-act="next">Suivant ▶<small>Espace</small></button></div>
    <div class="cue-auto" id="cue-auto"></div>
    ${show.cues.length ? `<ol class="cue-list">${list}</ol>` : '<p class="empty">Prépare ta soirée : compose une image avec la grille, puis « Capturer ». Le jour J, « Suivant » déroule les séquences dans l\'ordre.</p>'}`;
}
function bindCues() {
  $('#cues').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act, li = e.target.closest('.cue');
    if (act === 'capture') return captureCue();
    if (act === 'hide-right') return togglePanel('right', true);
    if (act?.startsWith('cond-')) return conductorAction(act);
    if (act === 'next') return nextCue();
    if (act === 'prev') return prevCue();
    if (li) {
      const i = +li.dataset.cue;
      if (e.target.closest('.cue-go')) return prepOn ? prepareCue(i) : goCue(i);
      sel = { kind: 'cue', id: show.cues[i].id };
      renderCues(); renderGrid(); renderInspector();
    }
  });
  $('#cues').addEventListener('change', e => { if (e.target.id === 'cond-sel') switchConductor(e.target.value); });
  // Ordre des séquences à la souris : on glisse une séquence au-dessus ou au-dessous d'une autre.
  let dragCue = null;
  const clearMarks = () => $$('#cues .cue.drop-before, #cues .cue.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  $('#cues').addEventListener('dragstart', e => {
    const li = e.target.closest?.('.cue'); if (!li) return;
    dragCue = +li.dataset.cue;
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-led-cue', String(dragCue));
    li.classList.add('dragging');
  });
  $('#cues').addEventListener('dragover', e => {
    const li = e.target.closest?.('.cue');
    if (dragCue == null || !li) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    clearMarks(); li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  $('#cues').addEventListener('dragleave', e => { if (!e.relatedTarget || !$('#cues').contains(e.relatedTarget)) clearMarks(); });
  $('#cues').addEventListener('dragend', () => { dragCue = null; clearMarks(); $$('#cues .cue.dragging').forEach(x => x.classList.remove('dragging')); });
  $('#cues').addEventListener('drop', e => {
    const li = e.target.closest?.('.cue');
    if (dragCue == null || !li) return;
    e.preventDefault();
    const from = dragCue, r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    let to = +li.dataset.cue + (after ? 1 : 0);
    dragCue = null; clearMarks();
    if (to > from) to--;                                     // l'élément retiré décale ceux qui le suivent
    if (to === from) return;
    const curLive = show.cues[live.cue], curPrep = prepCue != null ? show.cues[prepCue] : null;
    const [moved] = show.cues.splice(from, 1); show.cues.splice(to, 0, moved);
    live.cue = curLive ? show.cues.indexOf(curLive) : -1;    // la séquence à l'antenne (et celle préparée) restent les mêmes
    if (curPrep) prepCue = show.cues.indexOf(curPrep);
    commit(); renderCues(); renderInspector();
  });
  $('#cues').addEventListener('dblclick', e => { const li = e.target.closest('.cue'); if (li && !e.target.closest('.cue-go')) (prepOn ? prepareCue : goCue)(+li.dataset.cue); });
}

/* ---------- inspecteur (réglages du clip / calque / séquence sélectionné) ---------- */
const fmtT = s => { s = Math.max(0, +s || 0); return Math.floor(s / 60) + ':' + pad2(Math.floor(s % 60)) + '.' + Math.floor((s % 1) * 10); };
const vidSegLabel = c => (+c.start > 0 || +c.stop > 0 ? `Lecture de ${fmtT(c.start)} à ${+c.stop > 0 ? fmtT(c.stop) : 'la fin'}` : 'Lecture de toute la vidéo');
const FMT = {
  pct: v => Math.round(v * 100) + ' %', x: v => (+v).toFixed(2) + ' ×', deg: v => Math.round(v) + '°', s: v => (+v).toFixed(1) + ' s',
  hue: v => Math.round(v * 360) + '°', num: v => String(Math.round(v * 100) / 100),
};
const fRange = (s, k, label, v, min, max, step, fmt = 'pct') => `<label class="f"><span>${label}</span><input type="range" data-s="${s}" data-k="${k}" data-fmt="${fmt}" min="${min}" max="${max}" step="${step}" value="${+v}"><output>${FMT[fmt](+v)}</output></label>`;
const fSelect = (s, k, label, v, opts, re = false) => `<label class="f"><span>${label}</span><select data-s="${s}" data-k="${k}"${re ? ' data-re="1"' : ''}${typeof opts[0][0] === 'number' ? ' data-num="1"' : ''}>${opts.map(([val, txt]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
const fText = (s, k, label, v, ph = '') => `<label class="f"><span>${label}</span><input type="text" data-s="${s}" data-k="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></label>`;
const fNum = (s, k, label, v, min, max, step = 1) => `<label class="f"><span>${label}</span><input type="number" data-s="${s}" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${+v}"></label>`;
const fColor = (s, k, label, v) => `<label class="f"><span>${label}</span><input type="color" data-s="${s}" data-k="${k}" value="${hex(v)}"></label>`;
const fCheck = (s, k, label, v, re = false) => `<label class="f chk"><input type="checkbox" data-s="${s}" data-k="${k}"${v ? ' checked' : ''}${re ? ' data-re="1"' : ''}><span>${label}</span></label>`;

const zoneName = id => show.slices.find(z => z.id === id)?.name || '';
const zoneOpts = (first) => [...first, ...show.slices.map((z, i) => [z.id, (i + 1) + ' · ' + z.name])];
function clipInspector(c) {
  let h = `<div class="panel-h"><h3>${TYPE_NAME[c.type]}</h3><button class="btn sm gold" data-act="launch-sel">▶ Lancer</button></div><div class="fields">`;
  h += fText('clip', 'name', 'Nom', c.name, clipLabel({ ...c, name: '' }));
  h += fCheck('clip', 'retour', 'Aussi sur l\'écran retour (badge R)', c.retour, true);
  if (c.retour && !show.outputs.some(o => o.mode === 'retour')) h += '<p class="note">Aucune sortie n\'est encore en « Retour conférenciers » : onglet Outputs → « ＋ Sortie », puis choisis ce mode.</p>';
  // Pause / reprise / recommencer, pour ce qui a une horloge : compte à rebours, bandeau, vidéo, diaporama, effet.
  if (c.type === 'video' || c.type === 'slideshow' || c.type === 'gen' || (c.type === 'text' && (c.mode === 'countdown' || c.scroll))) {
    const st = playState(c);
    if (st.where.length) h += `<div class="f"><span>Lecture</span><div class="row" style="margin:0"><button class="btn sm${st.paused ? ' gold' : ''}" data-act="pause-toggle" title="Raccourci : voir Réglages → Mes raccourcis (action « Pause / reprise »)">${st.paused ? '▶ Reprendre' : '⏸ Pause'}</button><button class="btn sm" data-act="restart" title="${c.type === 'text' ? 'Repart du début du décompte' : 'Repart du début'}">↺ Recommencer</button><small class="note" style="margin:0">${st.paused ? 'en pause' : 'en cours'} · ${st.where.join(' + ')}</small></div></div>`;
    else if (c.type === 'text' && c.mode === 'countdown') h += '<p class="note">Lance le compte à rebours (case de la grille) : tu pourras ici le mettre en pause, le reprendre ou le recommencer.</p>';
  }
  const ck = show.keys.find(k => k.action === 'clip' && k.target === c.id);
  h += `<div class="f"><span>Raccourci</span><div class="row" style="margin:0"><kbd>${ck ? esc(keyLabel(ck)) : '—'}</kbd><button class="btn sm capture" data-act="key-clip" title="Appuie ensuite sur la touche qui lancera ce clip">⌨ ${ck ? 'Changer' : 'Assigner'}</button>${ck ? '<button class="btn sm" data-act="key-clip-del" title="Retirer le raccourci">✕</button>' : ''}</div></div>`;
  if (c.type === 'video') {
    h += fSelect('clip', 'end', 'À la fin', c.end, [['loop', 'Recommencer (boucle)'], ['hold', 'Rester sur la dernière image'], ['next', 'Passer à la séquence suivante']]);
    h += fRange('clip', 'speed', 'Vitesse', c.speed, 0.25, 2, 0.05, 'x');
    h += fCheck('clip', 'hold', 'En préparation : attendre l\'envoi (figée sur le point de départ, démarre quand elle passe à la sortie)', c.hold !== false);
    h += fRange('clip', 'volume', 'Son (volume)', c.volume, 0, 1, 0.01);
    h += `<p class="note">Le son de la vidéo sort par la fenêtre de sortie, vers ${show.audioOutLabel ? '« ' + esc(show.audioOutLabel) + ' »' : 'la sortie son du Mac'} (à choisir dans Réglages → Son). 0 = vidéo muette.</p>`;
    const playing = show.layers.some(l => stage()[l.id]?.clipId === c.id || live.layers[l.id]?.clipId === c.id);
    h += `<h4>Aperçu et découpe</h4>
      <video class="live-thumb vid-prev" id="vid-prev" src="${esc(c.src)}#t=${+c.start || 0}" controls muted playsinline preload="metadata"></video>
      <p class="note">Avance dans cet aperçu (muet, il ne touche pas au mur) et mets-le en <b>pause</b> là où la vidéo doit démarrer : c'est le point de départ. La vignette de la case montre cette image. « Fin » découpe la fin.</p>
      <div class="row"><button class="btn sm" data-act="vid-in" title="La lecture partira de la position actuelle de l'aperçu">Début = position</button><button class="btn sm" data-act="vid-out" title="La lecture s'arrêtera (ou rebouclera) à la position actuelle de l'aperçu">Fin = position</button><button class="btn sm" data-act="vid-clear">Toute la vidéo</button></div>
      <p class="note" id="vid-seg">${esc(vidSegLabel(c))}</p>
      ${playing ? '<button class="btn sm gold" data-act="vid-jump" title="La vidéo en cours (préparation ou sortie) saute à la position de l\'aperçu">▶ Sauter à la position de l\'aperçu</button>' : ''}`;
  }
  if (c.type === 'slideshow') {
    const items = c.items || [];
    h += fNum('clip', 'dur', 'Durée par image (s)', c.dur, 0.5, 600, 0.5);
    h += fRange('clip', 'fade', 'Fondu entre deux', c.fade, 0, 5, 0.1, 's');
    h += fSelect('clip', 'order', 'Ordre', c.order, [['seq', 'Dans l\'ordre de la liste'], ['random', 'Aléatoire']]);
    h += fSelect('clip', 'end', 'À la fin', c.end, [['loop', 'Recommencer (boucle)'], ['hold', 'Rester sur la dernière'], ['next', 'Passer à la séquence suivante']]);
    h += fRange('clip', 'volume', 'Son des vidéos', c.volume, 0, 1, 0.01);
    h += `<h4>Contenu (${items.length})</h4>
      <ol class="ss-list" id="ss-list">${items.map((it, i) => `<li data-i="${i}" draggable="true" title="Glisse pour changer l'ordre"><span class="lib-th">${thumbMedia({ type: it.type, url: it.src })}</span>
        <div class="lib-meta"><b>${esc(it.name || it.src)}</b><small>${it.type === 'video' ? 'Vidéo · jouée en entier' : 'Image'}</small></div>
        <span class="ss-acts"><button data-ss="up" title="Monter">↑</button><button data-ss="down" title="Descendre">↓</button><button data-ss="del" title="Retirer du diaporama">✕</button></span></li>`).join('')}</ol>
      <p class="note ss-drop">${items.length ? 'Glisse ici d\'autres médias de la médiathèque pour les ajouter.' : 'Diaporama vide : glisse ici des médias de la médiathèque, ou sélectionne-les à gauche (cases à cocher) puis « ▶ Diaporama ».'}</p>
      <button class="btn sm" data-act="ss-add">＋ Ajouter depuis la médiathèque</button>`;
  }
  if (c.type === 'doc') {
    h += `<div class="row"><button class="btn" data-act="doc-prev" title="Touche ←">◀ Page précédente</button><button class="btn gold" data-act="doc-next" title="Touche →">Page suivante ▶</button></div>
      <p class="note" id="doc-pos">${esc(docLabel(c))}</p>
      <div class="row"><button class="btn sm" data-act="doc-first">Première</button><button class="btn sm" data-act="doc-last">Dernière</button>
        <label class="doc-goto">Aller à la page <input type="number" id="doc-goto" min="1" max="${c.pages || 1}" value="${(c.page || 0) + 1}"></label></div>
      <p class="note">Les touches ← et → tournent les pages quand ce document est à l'écran. Le changement de page part tout de suite à la sortie.</p>`;
  }
  if (c.type === 'screen') {
    const st = window.__ledStreams[c.id], on = st && st.active, hasAudio = on && st.getAudioTracks().length > 0;
    h += `<p class="live-state${on ? ' on' : ''}">${on ? '● En direct : ' + esc(st.getVideoTracks()[0]?.label || 'fenêtre capturée') + (hasAudio ? ' · avec son' : ' · sans son') : (c.ppt || c.capLabel) ? '⏸ Capture arrêtée : la case est noire' : '○ Aucune fenêtre choisie pour l\'instant'}</p>`;
    if (hasAudio) h += fRange('clip', 'volume', 'Son (volume)', c.volume, 0, 1, 0.01);
    if (on) h += '<video class="live-thumb" id="live-thumb" muted playsinline autoplay></video>';
    if (on) h += `<div class="row"><button class="btn sm" data-act="pick-screen">Changer de fenêtre…</button><button class="btn sm danger" data-act="cap-stop" title="La régie lâche la fenêtre : la case devient noire. ${c.ppt ? 'Le diaporama reste ouvert dans PowerPoint.' : 'La fenêtre reste ouverte.'}">⏸ Arrêter la capture</button></div>`;
    else if (c.ppt || c.capLabel) h += `<div class="row"><button class="btn gold" data-act="cap-resume" title="Rattache la même fenêtre${window.regieDesktop ? ' (retrouvée automatiquement)' : ''}">▶ Reprendre la capture</button><button class="btn sm" data-act="pick-screen">Choisir une autre fenêtre…</button></div>`;
    else h += `<button class="btn gold" data-act="pick-screen">Choisir la fenêtre à afficher…</button>`;
    if (c.ppt) {
      h += `<h4>Diaporama PowerPoint</h4><div class="row"><button class="btn" data-act="ppt-prev" title="Touche ←">◀ Précédent</button><button class="btn gold" data-act="ppt-next" title="Touche →">Suivant ▶</button></div>
        <p class="note" id="ppt-pos">${esc(pptLabel(c))}</p>
        <div class="row"><button class="btn sm" data-act="ppt-first">Revenir au début</button><button class="btn sm" data-act="ppt-open">Relancer le diaporama</button></div>
        <p class="note">« Suivant » fait comme un clic dans PowerPoint : l'animation suivante, puis la diapositive suivante. Les touches ← et → font la même chose quand ce clip est à l'écran. La fenêtre « Diaporama PowerPoint » peut rester derrière les autres, mais ne la réduis pas dans le Dock et ne la ferme pas.</p>`;
    } else h += '<p class="note">La régie te demande quelle fenêtre (ou quel écran) afficher. Le choix est à refaire si tu recharges la régie. La fenêtre peut rester derrière les autres, mais pas réduite (Dock ou barre des tâches).</p>';
  }
  if (c.type === 'camera') {
    const opts = [['', 'Caméra par défaut'], ...camDevices.map(d => [d.deviceId, d.label || 'Caméra'])];
    if (c.deviceId && !opts.some(o => o[0] === c.deviceId)) opts.push([c.deviceId, c.deviceLabel || 'Caméra enregistrée']);
    h += fSelect('clip', 'deviceId', 'Source', c.deviceId, opts);
    h += '<button class="btn sm" data-act="cams">Détecter les caméras</button><p class="note">Une carte de capture HDMI/USB (ordinateur invité, console vidéo…) apparaît ici comme une caméra : son image est reprise en direct, rien n\'est enregistré.</p>';
    h += '<h4>Son de la source</h4>' + fCheck('clip', 'audio', 'Reprendre aussi le son (entrée audio de la carte / micro)', c.audio, true);
    if (c.audio) {
      const aopts = [['', 'Entrée audio associée (automatique)'], ...audioInDevs.map(d => [d.deviceId, d.label || 'Entrée audio'])];
      if (c.audioDeviceId && !aopts.some(o => o[0] === c.audioDeviceId)) aopts.push([c.audioDeviceId, c.audioLabel || 'Entrée enregistrée']);
      h += fSelect('clip', 'audioDeviceId', 'Entrée audio', c.audioDeviceId, aopts);
      h += fRange('clip', 'volume', 'Son (volume)', c.volume, 0, 1, 0.01);
      h += `<p class="note">Le son sort par la fenêtre de sortie, vers ${show.audioOutLabel ? '« ' + esc(show.audioOutLabel) + ' »' : 'la sortie son du Mac'} (Réglages → Son). Une carte HDMI fournit en général sa propre entrée audio (« USB Digital Audio »…) : elle est choisie automatiquement quand elle porte le même nom que la vidéo.</p>`;
    }
  }
  if (c.type === 'text') {
    h += fSelect('clip', 'mode', 'Type', c.mode, [['text', 'Texte'], ['clock', 'Horloge'], ['countdown', 'Compte à rebours']], true);
    if (c.mode === 'text') {
      h += `<label class="f col"><span>Texte</span><textarea data-s="clip" data-k="text" rows="3" dir="auto">${esc(c.text)}</textarea></label>`;
      h += fCheck('clip', 'scroll', 'Texte défilant (bandeau)', c.scroll, true);
      if (c.scroll) h += fRange('clip', 'scrollSpeed', 'Vitesse', c.scrollSpeed, 0.2, 4, 0.1, 'x');
    }
    if (c.mode === 'clock') h += fCheck('clip', 'secs', 'Afficher les secondes', c.secs);
    if (c.mode === 'countdown') {
      h += fSelect('clip', 'cdMode', 'Décompte', c.cdMode, [['duree', 'Durée, à partir du lancement'], ['heure', 'Jusqu\'à une heure précise']], true);
      h += c.cdMode === 'heure' ? `<label class="f"><span>Heure visée</span><input type="time" data-s="clip" data-k="cdTime" value="${esc(c.cdTime)}"></label>` : fNum('clip', 'cdMin', 'Minutes', c.cdMin, 0, 600, 0.5);
      h += fText('clip', 'cdEnd', 'À zéro, afficher', c.cdEnd, '00:00');
      if (c.cdMode !== 'heure') h += fCheck('clip', 'hold', 'En préparation : attendre l\'envoi (affiche le temps de départ, décompte dès la sortie)', c.hold !== false);
    }
    h += `<label class="f"><span>Police</span><input type="text" data-s="clip" data-k="font" list="fonts" value="${esc(c.font)}"><datalist id="fonts">${M.FONTS.map(f => `<option value="${esc(f)}">`).join('')}</datalist></label>`;
    h += fRange('clip', 'size', 'Taille', c.size, 2, 60, 0.5, 'num');
    h += fColor('clip', 'color', 'Couleur', c.color);
    h += fCheck('clip', 'bold', 'Gras', c.bold) + fCheck('clip', 'shadow', 'Ombre', c.shadow) + fCheck('clip', 'outline', 'Contour noir', c.outline);
    if (!(c.scroll && c.mode === 'text')) h += fSelect('clip', 'align', 'Alignement', c.align, [['left', 'Gauche'], ['center', 'Centre'], ['right', 'Droite']]);
    h += fSelect('clip', 'valign', 'Hauteur', c.valign, [['top', 'En haut'], ['middle', 'Au milieu'], ['bottom', 'En bas']]);
    h += fSelect('clip', 'bg', 'Fond', c.bg, [['none', 'Transparent'], ['bar', 'Bandeau derrière le texte'], ['full', 'Fond plein']], true);
    if (c.bg !== 'none') h += fColor('clip', 'bgColor', 'Couleur du fond', c.bgColor) + fRange('clip', 'bgAlpha', 'Opacité du fond', c.bgAlpha, 0, 1, 0.01);
  }
  if (c.type === 'gen') {
    h += fSelect('clip', 'kind', 'Motif', c.kind, M.GENS);
    h += fColor('clip', 'colorA', 'Couleur 1', c.colorA) + fColor('clip', 'colorB', 'Couleur 2', c.colorB);
    h += fCheck('clip', 'transp', 'Couleur 2 transparente', c.transp);
    h += fRange('clip', 'speed', 'Vitesse', c.speed, 0, 4, 0.05, 'x') + fRange('clip', 'density', 'Densité', c.density, 0.2, 4, 0.05, 'x');
    h += fCheck('clip', 'sync', 'Suivre le tempo (BPM)', c.sync);
  }
  if (['video', 'camera', 'screen', 'slideshow'].includes(c.type)) {
    const atOut = show.layers.some(l => live.layers[l.id]?.clipId === c.id);
    const local = c.type === 'video' ? 'Aperçu (ici)' : c.type === 'camera' && c.audio ? 'Entrée (ici)' : c.type === 'screen' ? 'Capture (ici)' : '';
    h += `<h4>Niveau sonore</h4>
      ${local ? `<div class="vu-row"><span>${local}</span><i class="vu big" id="vu-in"><b></b></i><small id="vu-in-txt"></small></div>` : ''}
      <div class="vu-row"><span>À la sortie</span><i class="vu big" data-vu="${c.id}"><b></b></i><small id="vu-out-txt">${atOut ? '' : 'pas à la sortie'}</small></div>
      <p class="note">« À la sortie » = ce que le mur entend (après le volume et le fondu), mesuré dans la fenêtre de sortie${c.type === 'video' ? ' ; « Aperçu » = le son de la vidéo pendant que tu la fais jouer dans l\'aperçu ci-dessus' : c.type === 'camera' && c.audio ? ' ; « Entrée » = le signal qui arrive sur l\'entrée audio choisie, même sans envoyer le clip' : ''}.</p>`;
  }
  h += '<h4>Cadrage</h4>';
  if (show.slices.length > 1) h += fSelect('clip', 'zone', 'Affiché dans', c.zone, zoneOpts([['', 'Comme le calque'], ['all', 'Toute l\'image']]));
  if (['video', 'image', 'slideshow', 'camera', 'screen', 'doc'].includes(c.type)) h += fSelect('clip', 'fit', 'Remplissage', c.fit, M.FITS);
  h += fRange('clip', 'scale', 'Taille', c.scale, 0.1, 3, 0.01, 'x') + fRange('clip', 'x', 'Position ↔', c.x, -1, 1, 0.005, 'num') + fRange('clip', 'y', 'Position ↕', c.y, -1, 1, 0.005, 'num') + fRange('clip', 'rot', 'Rotation', c.rot, -180, 180, 1, 'deg');
  h += '<button class="btn sm" data-act="reset-frame">Réinitialiser le cadrage</button>';
  if (['video', 'image', 'slideshow', 'camera', 'screen', 'doc'].includes(c.type)) {
    h += `<details${c.cropL || c.cropR || c.cropT || c.cropB ? ' open' : ''}><summary>Rogner les bords</summary>`
      + fRange('clip', 'cropT', 'Haut', c.cropT, 0, 0.45, 0.002) + fRange('clip', 'cropB', 'Bas', c.cropB, 0, 0.45, 0.002)
      + fRange('clip', 'cropL', 'Gauche', c.cropL, 0, 0.45, 0.002) + fRange('clip', 'cropR', 'Droite', c.cropR, 0, 0.45, 0.002) + '</details>';
  }
  return h + '</div>';
}
function layerInspector(l) {
  const fx = l.fx;
  return `<div class="panel-h"><h3>Calque</h3><div><button class="btn sm" data-act="layer-up" title="Passer devant">↑</button><button class="btn sm" data-act="layer-down" title="Passer derrière">↓</button><button class="btn sm danger" data-act="layer-del">Supprimer</button></div></div><div class="fields">
    ${fText('layer', 'name', 'Nom', l.name)}
    ${fSelect('layer', 'zone', 'Affiché dans', l.zone, zoneOpts([['', 'Toute l\'image']]), true)}
    ${l.zone ? fCheck('layer', 'opaque', 'Fond noir dans la zone (cache les calques derrière, seulement quand un clip joue ici)', l.opaque) : ''}
    <p class="note">Les clips de ce calque sont cadrés dans la zone choisie (onglet Mapping). Un calque par écran = chaque écran a son propre contenu.${l.zone ? ' Si l\'image ne remplit pas toute la zone (bandes sur les côtés), coche « Fond noir » ou passe le clip en « Remplir (rogner) ».' : ''}</p>
    ${show.outputs.length > 1 ? `<h4>Visible sur</h4><div class="outvis">${show.outputs.map(o => `<label class="chk" title="${esc(o.name)} : ${o.hidden.includes(l.id) ? 'masqué' : 'visible'}"><input type="checkbox" data-outvis="${esc(o.id)}"${o.hidden.includes(l.id) ? '' : ' checked'}> ${esc(o.name)}</label>`).join('')}</div>
    <p class="note">Décoche une sortie pour que ce calque n'y apparaisse pas (ex. : les effets et le logo absents du retour conférenciers). Réglages → Sorties pour créer des sorties.</p>` : ''}
    ${fCheck('layer', 'keep', 'Reste affiché quand on lance une autre colonne', l.keep)}
    ${fSelect('layer', 'blend', 'Mélange', l.blend, M.BLENDS)}
    ${fRange('layer', 'fade', 'Fondu entre clips', l.fade, 0, 5, 0.1, 's')}
    <h4>Effets du calque</h4>
    ${fRange('fx', 'bri', 'Luminosité', fx.bri, 0, 2, 0.01)}${fRange('fx', 'con', 'Contraste', fx.con, 0, 2, 0.01)}${fRange('fx', 'sat', 'Saturation', fx.sat, 0, 2, 0.01)}
    ${fRange('fx', 'hue', 'Teinte', fx.hue, 0, 1, 0.005, 'hue')}${fRange('fx', 'inv', 'Négatif', fx.inv, 0, 1, 0.01)}
    ${fColor('fx', 'tint', 'Coloriser', fx.tint)}${fRange('fx', 'tintAmt', 'Quantité', fx.tintAmt, 0, 1, 0.01)}
    ${fSelect('fx', 'mirror', 'Miroir', fx.mirror, M.MIRRORS)}
    ${fRange('fx', 'pix', 'Gros pixels', fx.pix, 0, 1, 0.01)}${fRange('fx', 'rgb', 'Décalage RVB', fx.rgb, 0, 1, 0.01)}
    <h4>Au rythme de la musique</h4>
    ${fSelect('fx', 'strobe', 'Stroboscope', fx.strobe, M.STROBES)}
    ${fRange('fx', 'pulse', 'Pulsation', fx.pulse, 0, 1, 0.01)}${fRange('fx', 'zoom', 'Zoom sur le temps', fx.zoom, 0, 1, 0.01)}
    ${fRange('fx', 'audio', 'Réaction au son', fx.audio, 0, 1, 0.01)}
    <p class="note">Stroboscope, pulsation et zoom suivent le tempo (Tap). « Réaction au son » demande d'activer le micro.</p>
    <button class="btn sm" data-act="fx-reset">Remettre les effets à zéro</button></div>`;
}
function cueInspector(c) {
  const i = show.cues.indexOf(c);
  const rows = [...show.layers].reverse().map(l => `<div class="np${show.clips[c.layers[l.id]] ? ' on' : ''}"><span>${esc(l.name)}</span><b>${esc(clipLabel(show.clips[c.layers[l.id]]) || '—')}</b></div>`).join('');
  return `<div class="panel-h"><h3>Séquence ${i + 1}</h3><div><button class="btn sm" data-act="cue-up" title="Monter">↑</button><button class="btn sm" data-act="cue-down" title="Descendre">↓</button><button class="btn sm danger" data-act="cue-del">Supprimer</button></div></div><div class="fields">
    ${fText('cue', 'name', 'Nom', c.name)}
    ${fRange('cue', 'fade', 'Fondu d\'entrée', c.fade, 0, 10, 0.1, 's')}
    ${fNum('cue', 'auto', 'Suite automatique après (s)', c.auto, 0, 36000, 1)}
    <p class="note">0 = on attend « Suivant ». Pour enchaîner à la fin d'une vidéo, règle la vidéo sur « À la fin : passer à la séquence suivante ».</p>
    <div class="np-list">${rows}</div>
    <button class="btn sm" data-act="cue-update">Remplacer par ce qui joue maintenant</button>
    <button class="btn sm gold" data-act="cue-go">▶ Envoyer à l'écran</button></div>`;
}
function renderInspector() {
  const el = $('#inspector');
  const c = sel?.kind === 'clip' && show.clips[sel.id], l = sel?.kind === 'layer' && layerById(sel.id), q = sel?.kind === 'cue' && cueById(sel.id);
  el.innerHTML = c ? clipInspector(c) : l ? layerInspector(l) : q ? cueInspector(q)
    : '<div class="panel-h"><h3>Réglages</h3></div><p class="empty">Clique sur un clip pour le lancer et le régler ici.<br>Clique sur le nom d\'un calque pour ses effets, ou sur une séquence du conducteur.</p>';
  const thumb = $('#live-thumb');                      // vignette de contrôle : ce que Chrome capture réellement
  if (thumb && c) { thumb.srcObject = window.__ledStreams[c.id] || null; thumb.play?.().catch(() => {}); }
  stopLocalMeter(); localTry = 0;
  if (c && ['camera', 'screen'].includes(c.type)) startLocalMeter(c);
  const pv = $('#vid-prev');                           // aperçu vidéo : une pause (ou un déplacement en pause) fixe le point de départ
  if (pv && c?.type === 'video') {
    pv.addEventListener('play', () => meterCtx());     // le vumètre de l'aperçu démarre avec la lecture
    const setStart = () => {
      if (pv.ended || !isFinite(pv.currentTime)) return;
      const p = Math.round(pv.currentTime * 10) / 10;
      if (p === (+c.start || 0)) return;
      c.start = p; if (+c.stop > 0 && c.stop <= p) c.stop = 0;
      commit(); const seg = $('#vid-seg'); if (seg) seg.textContent = vidSegLabel(c);
      refreshVideoThumb(c);
      if (engPrep) for (const l of show.layers) if (prep.layers[l.id]?.clipId === c.id) prep.layers[l.id] = { ...prep.layers[l.id], t0: Date.now() };   // la préparation se recale sur le nouveau départ
    };
    pv.addEventListener('pause', setStart);
    pv.addEventListener('seeked', () => { if (pv.paused) setStart(); });
  }
}
/* ---------- vumètres ---------- */
// Niveaux mesurés dans la fenêtre de sortie (ce que le mur entend), reçus 10 fois par seconde : {clipId: {in, out}}.
let levels = {}, levelsAt = 0, levelsRun = false;
// Vumètre local du clip sélectionné : entrée audio d'une source en direct, ou son de l'aperçu vidéo.
let localMeter = null, localStream = null, localTry = 0;
function stopLocalMeter() {
  localMeter?.dispose(); localMeter = null;
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
}
async function startLocalMeter(c) {
  stopLocalMeter();
  if (c.type === 'camera' && c.audio) {
    const dev = c.audioDeviceId || audioInFor(c.deviceId)?.deviceId;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(dev ? { deviceId: { exact: dev } } : {}) } });
      if (sel?.kind !== 'clip' || sel.id !== c.id) return s.getTracks().forEach(t => t.stop());
      localStream = s; localMeter = new Meter(s);
    } catch { const t = $('#vu-in-txt'); if (t) t.textContent = 'entrée indisponible'; }
  } else if (c.type === 'screen') {
    const s = window.__ledStreams[c.id];
    if (s?.getAudioTracks().length) localMeter = new Meter(s); else { const t = $('#vu-in-txt'); if (t) t.textContent = 'pas de son dans la capture'; }
  }
  // vidéo : le vumètre de l'aperçu est créé dès que l'aperçu joue (voir vuFrame)
}
const vuWidth = (el, v) => { const b = el.firstElementChild; const w = v < 0 ? 0 : Math.round(v * 100) + '%'; if (b.style.width !== w) b.style.width = w; el.classList.toggle('none', v < 0); };
function vuFrame() {
  const fresh = Date.now() - levelsAt < 1500;
  for (const el of $$('[data-vu]')) { const L = fresh ? levels[el.dataset.vu] : null; vuWidth(el, L ? L.out : 0); }
  const c = sel?.kind === 'clip' && show.clips[sel.id];
  const txt = $('#vu-out-txt');
  if (txt && c) {
    const atOut = show.layers.some(l => live.layers[l.id]?.clipId === c.id), L = fresh ? levels[c.id] : null;
    const want = !atOut ? 'pas à la sortie' : !fresh ? 'fenêtre de sortie fermée' : !levelsRun ? 'clique une fois dans la fenêtre de sortie' : L && L.in < 0 ? 'pas de piste audio' : '';
    if (txt.textContent !== want) txt.textContent = want;
  }
  const vin = $('#vu-in');
  if (vin && c) {
    if (c.type === 'video' && !localMeter?.ok && Date.now() - localTry > 1000) {
      localTry = Date.now();
      const pv = $('#vid-prev');
      if (pv && pv.readyState >= 2 && !pv.paused) { meterCtx(); localMeter?.dispose(); localMeter = new Meter(pv); }
    }
    vuWidth(vin, localMeter?.ok ? localMeter.level() : 0);
    const t = $('#vu-in-txt');
    if (t && c.type === 'video' && !t.textContent && !localMeter?.ok) t.textContent = 'lance l\'aperçu';
    if (t && c.type === 'video' && localMeter?.ok && t.textContent === 'lance l\'aperçu') t.textContent = '';
  }
}
/** La vignette d'une vidéo dans la grille montre l'image de son point de départ. */
function refreshVideoThumb(c) {
  for (const img of $$(`#grid .cell[data-clip="${c.id}"] img.vthumb`)) { img.dataset.t = +c.start > 0 ? +c.start : 0.5; img.removeAttribute('src'); vthumbHydrate(img); }
}
function scopeObj(s) {
  if (s === 'clip') return show.clips[sel?.id];
  if (s === 'layer') return layerById(sel?.id);
  if (s === 'fx') return layerById(sel?.id)?.fx;
  if (s === 'cue') return cueById(sel?.id);
  return null;
}
function moveIn(arr, item, d) { const i = arr.indexOf(item), j = i + d; if (i < 0 || j < 0 || j >= arr.length) return false; arr.splice(i, 1); arr.splice(j, 0, item); return true; }
function bindInspector() {
  const el = $('#inspector');
  el.addEventListener('input', e => {
    const t = e.target, s = t.dataset.s, k = t.dataset.k, obj = s && scopeObj(s);
    if (!obj) return;
    let v = t.type === 'checkbox' ? t.checked : (t.type === 'range' || t.type === 'number' || t.dataset.num) ? +t.value : t.value;
    if (typeof v === 'number' && !isFinite(v)) return;
    obj[k] = v;
    if (t.type === 'range') t.nextElementSibling.textContent = FMT[t.dataset.fmt](v);
    if (s === 'clip' && k === 'deviceId') obj.deviceLabel = t.selectedOptions?.[0]?.textContent || '';
    if (s === 'clip' && k === 'audioDeviceId') obj.audioLabel = v ? (t.selectedOptions?.[0]?.textContent || '') : '';
    if (s === 'clip' && k === 'audio' && v && !obj.audioDeviceId) {        // on vient d'activer le son : entrée audio de la même carte
      const a = audioInFor(obj.deviceId);
      if (a) { obj.audioDeviceId = a.deviceId; obj.audioLabel = a.label; }
    }
    commit();
  });
  el.addEventListener('change', e => {
    if (e.target.id === 'doc-goto') { const dc = sel?.kind === 'clip' && show.clips[sel.id]; if (dc?.type === 'doc') docTurn(dc, +e.target.value || 1); return; }
    if (e.target.dataset.outvis != null) {                                    // calque visible ou masqué sur une sortie
      const l = sel?.kind === 'layer' && layerById(sel.id), o = M.outputById(show, e.target.dataset.outvis);
      if (!l || !o) return;
      o.hidden = o.hidden.filter(id => id !== l.id); if (!e.target.checked) o.hidden.push(l.id);
      commit(); renderGrid(); return;
    }
    const t = e.target, s = t.dataset.s, k = t.dataset.k;
    if (!s) return;
    if (t.dataset.re) renderInspector();
    if (s === 'cue') renderCues();
    else if (s === 'layer' && (k === 'name' || k === 'zone')) { renderGrid(); renderCues(); }
    else if (s === 'clip' && ['name', 'text', 'color', 'mode', 'kind', 'colorA', 'colorB', 'cdMin', 'cdMode', 'cdTime', 'retour'].includes(k)) { renderGrid(); renderCues(); if (show.pool.includes(sel?.id)) renderLib(); }
  });
  // Diaporama : liste « Contenu » (monter / descendre / retirer, réordonner en glissant, dépôt de médias depuis la médiathèque).
  const ssClip = () => (sel?.kind === 'clip' && show.clips[sel.id]?.type === 'slideshow' ? show.clips[sel.id] : null);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-ss]'), c = ssClip();
    if (!b || !c) return;
    const i = +b.closest('li').dataset.i, d = b.dataset.ss;
    if (d === 'del') c.items.splice(i, 1);
    else if ((d === 'up' && i > 0) || (d === 'down' && i < c.items.length - 1)) { const j = d === 'up' ? i - 1 : i + 1; [c.items[i], c.items[j]] = [c.items[j], c.items[i]]; }
    else return;
    commit(); renderGrid(); renderInspector();
  });
  let ssFrom = null;
  el.addEventListener('dragstart', e => {
    const li = e.target.closest('#ss-list li');
    if (!li) return;
    ssFrom = +li.dataset.i; e.dataTransfer.setData('application/x-led-ss', String(ssFrom)); e.dataTransfer.effectAllowed = 'move';
  });
  const ssDroppable = e => ['application/x-led-media', 'application/x-led-ss'].some(t => e.dataTransfer.types.includes(t));
  el.addEventListener('dragover', e => {
    if (!ssClip() || !ssDroppable(e)) return;
    e.preventDefault();
    $$('#ss-list li.over', el).forEach(x => x.classList.remove('over'));
    e.target.closest('#ss-list li')?.classList.add('over');
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) { el.classList.remove('drop'); $$('#ss-list li.over', el).forEach(x => x.classList.remove('over')); } });
  el.addEventListener('drop', e => {
    const c = ssClip();
    el.classList.remove('drop');
    if (!c || !ssDroppable(e)) return;
    e.preventDefault();
    const li = e.target.closest('#ss-list li'), at = li ? +li.dataset.i : c.items.length;
    const moved = e.dataTransfer.getData('application/x-led-ss');
    if (moved !== '') {                                   // réordonner
      const from = +moved; if (!(from >= 0 && from < c.items.length) || from === at) return;
      const [it] = c.items.splice(from, 1); c.items.splice(from < at ? at - 1 : at, 0, it);
      commit(); renderGrid(); renderInspector(); return;
    }
    const list = e.dataTransfer.getData('application/x-led-media-list'), name = e.dataTransfer.getData('application/x-led-media');
    let names = []; try { names = list ? JSON.parse(list) : name ? [name] : []; } catch { names = name ? [name] : []; }
    const items = mediaByNames(names).map(m => ({ src: m.url, type: m.type, name: baseName(m.name) }));
    if (!items.length) return;
    c.items.splice(at, 0, ...items);
    commit(); renderGrid(); renderInspector();
    toast(`${items.length} média${items.length > 1 ? 's ajoutés' : ' ajouté'} au diaporama.`);
  });
  el.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const clip = sel?.kind === 'clip' && show.clips[sel.id], layer = sel?.kind === 'layer' && layerById(sel.id), cue = sel?.kind === 'cue' && cueById(sel.id);
    if (act === 'launch-sel' && clip) {
      const lid = Object.keys(show.cells).find(id => show.cells[id].includes(clip.id)) || Object.keys(live.layers).find(id => live.layers[id]?.clipId === clip.id);
      if (lid) launch(lid, clip.id);
    }
    if (act === 'pause-toggle' && clip) return pauseToggle(clip);
    if (act === 'restart' && clip) return restartClip(clip);
    if (act === 'reset-frame' && clip) { Object.assign(clip, { scale: 1, x: 0, y: 0, rot: 0 }); commit(); renderInspector(); }
    if (clip?.type === 'video' && act.startsWith('vid-')) {
      const pv = $('#vid-prev'), pos = pv ? +pv.currentTime || 0 : 0, seg = $('#vid-seg');
      if (act === 'vid-in') { clip.start = Math.round(pos * 10) / 10; if (+clip.stop > 0 && clip.stop <= clip.start) clip.stop = 0; }
      if (act === 'vid-out') { clip.stop = pos > (+clip.start || 0) + 0.2 ? Math.round(pos * 10) / 10 : 0; if (!clip.stop) toast('Place l\'aperçu après le point de début pour définir la fin.', 'err'); }
      if (act === 'vid-clear') { clip.start = 0; clip.stop = 0; if (pv) pv.currentTime = 0; }
      if (act !== 'vid-jump') refreshVideoThumb(clip);
      if (act === 'vid-jump') {                                    // la vidéo en cours repart de cet instant : on recule son heure de lancement
        const rel = Math.max(0, pos - (+clip.start || 0)) / (+clip.speed || 1) * 1000, t0 = Date.now() - rel;   // la source se cale sur « maintenant − t0 »
        let n = 0;
        for (const l of show.layers) for (const L of [prep.layers[l.id], live.layers[l.id]]) if (L?.clipId === clip.id) { L.t0 = t0; n++; }
        if (n) { commit(false); toast(`Lecture reprise à ${fmtT(pos)}.`); } else { toast('Cette vidéo n\'est pas en cours de lecture.', 'err'); }
        return;
      }
      commit(); if (seg) seg.textContent = vidSegLabel(clip);
      return;
    }
    if (clip && act === 'key-clip') return captureKey(e.target.closest('.btn'), k => { setKey({ ...k, action: 'clip', target: clip.id }); renderInspector(); toast(`${keyLabel(k)} lance maintenant « ${clipLabel(clip)} ».`); });
    if (clip && act === 'key-clip-del') { show.keys = show.keys.filter(k => !(k.action === 'clip' && k.target === clip.id)); commit(); renderInspector(); return; }
    if (clip?.type === 'slideshow' && act === 'ss-add') {
      const list = await pickMedia('Ajouter au diaporama', 'Ajouter');
      if (list.length) addToSlideshow(clip, list);
      return;
    }
    if (clip?.type === 'doc' && act.startsWith('doc-')) return docTurn(clip, act.slice(4));
    if (clip && act === 'pick-screen') return pickScreen(clip);
    if (clip && act === 'cap-stop') return stopCapture(clip);
    if (clip && act === 'cap-resume') return resumeCapture(clip);
    if (clip?.ppt && act.startsWith('ppt-')) return pptCmd(clip, act.slice(4));
    if (act === 'cams') {
      await listAudio(true);                                 // caméras + entrées audio (les cartes HDMI ont souvent les deux)
      renderInspector(); renderLib();
      toast(camDevices.length ? camDevices.length + ' caméra(s) trouvée(s)' : 'Aucune caméra trouvée. Accès refusé ? Autorise la caméra dans Chrome.', camDevices.length ? '' : 'err');
    }
    if (layer) {
      if (act === 'fx-reset') { layer.fx = { ...M.FX_DEFAULT }; commit(); renderInspector(); }
      if ((act === 'layer-up' && moveIn(show.layers, layer, 1)) || (act === 'layer-down' && moveIn(show.layers, layer, -1))) { commit(); renderGrid(); renderCues(); }
      if (act === 'layer-del') {
        if (show.layers.length <= 1) return toast('Il faut garder au moins un calque.', 'err');
        if (!confirm(`Supprimer le calque « ${layer.name} » et ses clips ?`)) return;
        show.layers.splice(show.layers.indexOf(layer), 1);
        delete show.cells[layer.id]; delete live.layers[layer.id]; delete prep.layers[layer.id];
        for (const q of M.allCues(show)) delete q.layers[layer.id];
        sel = null; cleanup(); commit(); renderAll();
      }
    }
    if (cue) {
      const cur = show.cues[live.cue];
      const keep = () => { live.cue = cur ? show.cues.indexOf(cur) : -1; commit(); renderCues(); renderInspector(); };
      if ((act === 'cue-up' && moveIn(show.cues, cue, -1)) || (act === 'cue-down' && moveIn(show.cues, cue, 1))) keep();
      if (act === 'cue-del') { show.cues.splice(show.cues.indexOf(cue), 1); sel = null; cleanup(); keep(); renderGrid(); }
      if (act === 'cue-update') { for (const l of show.layers) cue.layers[l.id] = stage()[l.id]?.clipId || null; cleanup(); commit(); renderCues(); renderInspector(); toast('Séquence mise à jour'); }
      if (act === 'cue-go') goCue(show.cues.indexOf(cue));
    }
  });
}

/* ---------- barre du haut : tempo, micro, général, noir, sortie ---------- */
let taps = [], micOn = false, analyser = null, micData = null, micStream = null, micCtx = null, micEnv = 0, micPeak = 0.1;
function tap() {
  const now = Date.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now); if (taps.length > 8) taps.shift();
  live.beat0 = now;
  if (taps.length >= 2) { show.bpm = M.clamp(Math.round(600000 * (taps.length - 1) / (now - taps[0])) / 10, 20, 300); $('#bpm').value = show.bpm; commit(); }
  else commit(false);
}
async function toggleMic() {
  if (micOn) {
    micOn = false; micStream?.getTracks().forEach(t => t.stop()); micCtx?.close(); analyser = null;
    if (eng) eng.audio = 0.5; bc.postMessage({ t: 'audio', v: 0.5 });
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micCtx = new AudioContext();
      analyser = micCtx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.5;
      micCtx.createMediaStreamSource(micStream).connect(analyser);
      micData = new Uint8Array(analyser.frequencyBinCount); micOn = true; micPeak = 0.1;
    } catch { toast('Accès au micro refusé : autorise-le dans le navigateur.', 'err'); }
  }
  updateTop();
}
function micFrame() {
  if (!analyser) return;
  analyser.getByteFrequencyData(micData);
  let s = 0; for (let i = 1; i <= 8; i++) s += micData[i];                 // les basses (≈ 50–400 Hz) : le pied
  const lvl = s / 8 / 255;
  micEnv = Math.max(lvl, micEnv * 0.88);
  micPeak = Math.max(micPeak * 0.9995, lvl, 0.1);
  const v = M.clamp(micEnv / micPeak, 0, 1);
  if (eng) eng.audio = v;
  bc.postMessage({ t: 'audio', v });
  $('#mic-level').style.width = Math.round(v * 100) + '%';
}
function updateTop() {
  const sn = $('#show-name'); if (sn) { sn.textContent = show.name || 'Show'; sn.title = `Show en cours : « ${show.name || 'Show'} » (nom modifiable dans Réglages → Show)`; }
  $('#blackout').classList.toggle('on', !!live.blackout);
  const am = $('#audio-mute'); if (am) { am.classList.toggle('on', !!live.mute); am.innerHTML = live.mute ? '🔇<span class="lbl"> Muet</span>' : '🔊<span class="lbl"> Son</span>'; am.title = live.mute ? 'Son de sortie coupé : clic pour le rétablir' : 'Couper tout le son de sortie (vidéos, sources en direct), sans toucher à l\'image'; }
  $('#mic').classList.toggle('on', micOn);
  $('#mon-tag').textContent = live.test ? 'MIRE' : live.blackout ? 'NOIR' : '';
  if (document.activeElement !== $('#bpm')) $('#bpm').value = show.bpm;
  $('#master').value = show.master.opacity;
}
function extScreen() {
  if (!screens) return null;
  const want = localStorage.getItem('regieLed.screen');
  return screens.screens.find(s => s.label === want && s !== screens.currentScreen) || screens.screens.find(s => s !== screens.currentScreen) || null;
}
async function loadScreens(ask) {
  if (!('getScreenDetails' in window)) return;
  try {
    if (!ask) { const p = await navigator.permissions.query({ name: 'window-management' }); if (p.state !== 'granted') return; }
    screens = await window.getScreenDetails();
  } catch { /* refusé : la fenêtre s'ouvrira sur l'écran courant */ }
}
/** Recharge la fenêtre de sortie déjà ouverte (retrouvée par son nom). Renvoie false si elle est hors d'atteinte. */
function refreshOutput() {
  if (window.regieDesktop) return false;          // application de bureau : la sortie n'est pas une fenêtre de la régie ; openOutput() la recharge sur place
  let w = null;
  try { w = window.open('', 'regie-led-sortie'); } catch { /* bloqué */ }
  if (!w || w === window) return false;
  try {
    if (w.location.href === 'about:blank') { w.close(); return false; }      // aucune sortie à ce nom : on referme la fenêtre vide
    w.location.reload();
    return true;
  } catch { return false; }
}
/** Écran choisi pour une sortie secondaire (son champ `screen` = étiquette de l'écran), s'il est branché. */
const screenFor = o => (screens && o?.screen ? screens.screens.find(s => s.label === o.screen && s !== screens.currentScreen) || null : null);
const outIsOpen = id => (id === 'main' ? Date.now() - outSeen < 2600 && !!outInfo : Date.now() - (outInfos[id]?.seen || 0) < 2600);
async function openOutput(id = 'main') {
  const o = M.outputById(show, id), main = o.id === 'main';
  // Ouverture immédiate (sinon le navigateur bloque la fenêtre), sur l'écran prévu s'il est déjà connu.
  const s = main ? extScreen() : screenFor(o);
  const feat = s ? `popup,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}` : 'popup,left=80,top=80,width=1280,height=720';
  const w = window.open(main ? 'output.html' : 'output.html?out=' + encodeURIComponent(o.id), main ? 'regie-led-sortie' : 'regie-led-sortie-' + o.id, feat);
  if (window.regieDesktop) return toast(`« ${o.name} » ouverte : en plein écran sur l'écran externe s'il y en a un, sinon en fenêtre. Menu Sortie → « Écran de la sortie » pour choisir ; Échap dans la sortie quitte le plein écran.`);
  if (!w) return toast('Le navigateur a bloqué la fenêtre de sortie : autorise les pop-ups pour cette page.', 'err');   // (l'application de bureau crée elle-même la fenêtre : w est vide, c'est normal)
  if (main) outWin = w;
  if (!screens) await loadScreens(true);
  const placed = main ? extScreen() : screenFor(o);
  // Chrome ouvre souvent la fenêtre sur l'écran de la régie malgré la position demandée : on vérifie où elle est et on la déplace
  // sur l'écran choisi (autorisé une fois la détection des écrans accordée), plusieurs fois car la fenêtre met un instant à exister.
  if (placed) {
    const onTarget = () => { try { const x = w.screenLeft, y = w.screenTop; return x >= placed.left - 2 && x < placed.left + placed.width && y >= placed.top - 2 && y < placed.top + placed.height; } catch { return true; } };
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, i ? 350 : 150));
      if (w.closed) break;
      if (onTarget() && Math.abs(w.outerWidth - placed.availWidth) < 40) break;
      try { w.moveTo(placed.availLeft, placed.availTop); w.resizeTo(placed.availWidth, placed.availHeight); } catch { /* déplacement refusé */ }
    }
    if (!w.closed && !onTarget()) toast(`Chrome n'a pas laissé la régie placer la fenêtre sur « ${placed.label} » : glisse-la dessus, puis clique dedans (plein écran).`, 'err');
  }
  toast(placed ? `« ${o.name} » ouverte sur l'écran « ${placed.label || '2'} » — clique dedans pour le plein écran.` : `Fenêtre « ${o.name} » ouverte : glisse-la sur le bon écran puis clique dedans (plein écran).`);
}
/** Supprime une sortie (jamais la sortie spectateurs) : confirmation, fermeture de sa fenêtre, oubli de son écran. */
function deleteOutput(id) {
  const o = show.outputs.find(x => x.id === id); if (!o || o.id === 'main') return;
  if (!confirm(`Supprimer la sortie « ${o.name} » ?\n\nSa fenêtre se ferme si elle est ouverte ; l'écran qui l'affichait devient libre.`)) return;
  show.outputs = show.outputs.filter(x => x.id !== o.id); delete outInfos[o.id]; if (monOut === o.id) monOut = 'main';
  bc.postMessage({ t: 'close', out: o.id });                                   // la fenêtre de cette sortie se ferme d'elle-même
  try { window.regieDesktop?.setOutputDisplay?.(o.id, 'auto'); } catch { /* ancienne version */ }   // oublie l'écran choisi pour elle
  if (!window.regieDesktop) try { const w = window.open('', 'regie-led-sortie-' + o.id); if (w && w !== window) w.close(); } catch { /* hors d'atteinte */ }
  commit(); renderGrid(); renderInspector(); updatePlaying();
  if (tab === 'reglages') renderSettings();
  if (tab === 'outputs') renderOutputsView();
  toast(`Sortie « ${o.name} » supprimée.`);
}
function updateOutStatus() {
  const el = $('#out-status'), on = Date.now() - outSeen < 2600 && outInfo;
  let txt = 'Sortie fermée', cls = 'out-status';
  if (on) {
    const okSize = outInfo.w === show.output.w && outInfo.h === show.output.h;
    txt = `Sortie ${outInfo.w}×${outInfo.h} · ${outInfo.fps} i/s` + (outInfo.fs ? '' : ' · fenêtre');
    cls += okSize && outInfo.fs ? ' ok' : ' warn';
    if (outInfo.audioBlocked) txt += ' · son bloqué (clique dans la sortie)';
    // Sortie restée sur une ancienne version (elle ne connaît pas les nouveautés), ou qui ne reçoit pas la fenêtre capturée.
    const capturing = Object.values(live.layers).some(L => show.clips[L.clipId]?.type === 'screen' && window.__ledStreams[L.clipId]?.active);
    const stale = Date.now() - staleSeen < 4000, noCap = !stale && outInfo.noCapture && capturing;      // la régie capture bien, mais la sortie ne reçoit rien
    if (stale || noCap) {
      txt = stale ? 'Sortie pas à jour : clique sur « Mettre à jour la sortie »' : 'La sortie ne reçoit pas la fenêtre en direct : ferme-la puis rouvre-la ici';
      cls = 'out-status warn';
    }
    el.title = stale || noCap ? 'Ferme la fenêtre de sortie, puis clique sur « Ouvrir la sortie » : elle doit être ouverte par ce bouton pour recevoir la fenêtre capturée.' : okSize ? (outInfo.fs ? 'Tout est bon.' : 'La sortie n\'est pas en plein écran : clique dans la fenêtre de sortie.')
      : `La fenêtre de sortie fait ${outInfo.w}×${outInfo.h} px alors que le mapping est réglé pour ${show.output.w}×${show.output.h} px : l'image sera redimensionnée.`;
  }
  $('#out-banner').hidden = !(on && Date.now() - staleSeen < 4000);
  const extras = show.outputs.slice(1), openExtras = extras.filter(o => outIsOpen(o.id));
  if (extras.length) txt += ` · ${openExtras.length}/${extras.length} autre${extras.length > 1 ? 's' : ''} sortie${extras.length > 1 ? 's' : ''}${openExtras.length ? ' : ' + openExtras.map(o => o.name).join(', ') : ''}`;
  el.textContent = txt; el.className = cls;
  $('#open-out').textContent = on ? 'Sortie ouverte' : 'Ouvrir la sortie';
  $('#open-out').classList.toggle('gold', !on);
}
/* ---------- indicateur Santé : prévenir avant que la sortie ne saccade ----------
 * Chaque fenêtre de sortie mesure sa fluidité (images en retard, images de vidéo perdues, vidéos lourdes, mémoire) ;
 * l'application de bureau donne aussi processeur, mémoire totale et chaleur. Vert = tout va bien, orange = à surveiller,
 * rouge = ça risque de couper. Les changements d'état sont notés dans un journal (heure + cause). */
const healthHist = {}, healthLog = []; let healthLevel = 'ok', machine = null, machineAt = 0, regieFrames = 0, regieFps = 0, regieFpsT = performance.now();
function healthOf(o) {
  const inf = o.id === 'main' ? outInfo : outInfos[o.id];
  if (!outIsOpen(o.id) || !inf) return null;
  const h = inf.health || {}, hist = (healthHist[o.id] ||= []);
  hist.push(inf.fps || 0); if (hist.length > 300) hist.shift();
  const ref = Math.max(30, [...hist].sort((a, b) => a - b)[Math.floor(hist.length * 0.9)] || 60);      // fréquence habituelle de cet écran
  const why = [];
  let lvl = 'ok';
  const up = (l, msg) => { why.push(msg); if (l === 'bad' || lvl === 'ok') lvl = l; };
  if (h.hidden) up('warn', 'fenêtre cachée ou réduite : le navigateur la ralentit');
  else {
    if (inf.fps < ref * 0.6) up('bad', `${inf.fps} images/s au lieu de ${ref}`); else if (inf.fps < ref * 0.85) up('warn', `${inf.fps} images/s au lieu de ${ref}`);
    if (h.late >= 6) up('bad', `${h.late} saccades par seconde`); else if (h.late >= 2) up('warn', `${h.late} saccades par seconde`);
    if (h.dropped >= 10) up('bad', `${h.dropped} images de vidéo perdues par seconde`); else if (h.dropped >= 2) up('warn', `${h.dropped} images de vidéo perdues par seconde`);
  }
  if (h.heavy?.length) up(lvl === 'ok' ? 'warn' : lvl, 'vidéo plus grande que du 1080p : ' + h.heavy.join(', '));
  return { lvl, why, inf, h, ref };
}
async function healthMachine() {
  if (!window.regieDesktop?.metrics || Date.now() - machineAt < 2000) return;
  machineAt = Date.now();
  try { machine = await window.regieDesktop.metrics(); } catch { machine = null; }
}
function healthMachineLevel() {
  if (!machine) return { lvl: 'ok', why: [] };
  const why = []; let lvl = 'ok';
  const up = (l, msg) => { why.push(msg); if (l === 'bad' || lvl === 'ok') lvl = l; };
  if (machine.thermal === 'critical') up('bad', 'ordinateur très chaud : il se bride'); else if (machine.thermal === 'serious') up('warn', 'ordinateur chaud : il commence à se brider');
  if (machine.mem > 6000) up('bad', `Régie LED utilise ${(machine.mem / 1024).toFixed(1)} Go de mémoire`); else if (machine.mem > 3500) up('warn', `Régie LED utilise ${(machine.mem / 1024).toFixed(1)} Go de mémoire`);
  return { lvl, why };
}
function healthUpdate() {
  regieFps = Math.round(regieFrames * 1000 / Math.max(1, performance.now() - regieFpsT)); regieFrames = 0; regieFpsT = performance.now();
  healthMachine();
  const outs = show.outputs.map(o => ({ o, r: healthOf(o) })), mach = healthMachineLevel();
  const all = [...outs.filter(x => x.r).map(x => x.r.lvl), mach.lvl], lvl = all.includes('bad') ? 'bad' : all.includes('warn') ? 'warn' : 'ok';
  if (lvl !== healthLevel) {
    const cause = [...outs.filter(x => x.r && x.r.lvl !== 'ok').map(x => x.o.name + ' : ' + x.r.why.join(', ')), ...mach.why].join(' · ') || 'tout est revenu à la normale';
    healthLog.unshift({ t: Date.now(), lvl, cause }); healthLog.length = Math.min(healthLog.length, 100);
    if (lvl === 'bad') toast('⚠ Santé : ' + cause, 'err');
    healthLevel = lvl;
  }
  const b = $('#health');
  if (b) {
    b.className = 'health ' + lvl;
    b.title = lvl === 'ok' ? 'Santé : tout est fluide (clic pour le détail)' : 'Santé : ' + [...outs.filter(x => x.r && x.r.lvl !== 'ok').map(x => x.o.name + ' — ' + x.r.why.join(', ')), ...mach.why].join(' · ');
  }
  if (!$('#health-panel').hidden) renderHealthPanel(outs, mach);
}
function renderHealthPanel(outs, mach) {
  outs ||= show.outputs.map(o => ({ o, r: healthOf(o) })); mach ||= healthMachineLevel();
  const LBL = { ok: 'fluide', warn: 'à surveiller', bad: 'risque de coupure' };
  const spark = id => { const h = healthHist[id] || [], max = Math.max(60, ...h); return `<svg class="hp-spark" viewBox="0 0 300 30" preserveAspectRatio="none"><polyline points="${h.map((v, i) => `${i},${30 - v / max * 28}`).join(' ')}"/></svg>`; };
  $('#health-panel').innerHTML = `<div class="hp-h"><b>Santé</b><button class="x" data-act="health-close" title="Fermer">✕</button></div>
    ${outs.map(({ o, r }) => `<div class="hp-out ${r ? r.lvl : 'off'}"><div class="hp-row"><i></i><b>${esc(o.name)}</b><span>${r ? LBL[r.lvl] : 'fenêtre fermée'}</span></div>
      ${r ? `<div class="hp-num"><span><b>${r.inf.fps}</b> i/s</span><span><b>${r.h.late ?? '–'}</b> saccades/s</span><span><b>${r.h.dropped ?? '–'}</b> img vidéo perdues/s</span><span><b>${r.h.videos ?? 0}</b> vidéo(s)</span><span>pire image ${r.h.maxMs ?? '–'} ms</span></div>${spark(o.id)}${r.why.length ? `<p class="hp-why">${esc(r.why.join(' · '))}</p>` : ''}` : ''}</div>`).join('')}
    <div class="hp-out ${mach.lvl}"><div class="hp-row"><i></i><b>Ordinateur</b><span>${machine ? LBL[mach.lvl] : 'disponible dans l\'application Régie LED'}</span></div>
      ${machine ? `<div class="hp-num"><span>processeur <b>${machine.cpu} %</b></span><span>mémoire <b>${(machine.mem / 1024).toFixed(1)} Go</b></span><span>chaleur <b>${({ nominal: 'normale', fair: 'correcte', serious: 'élevée', critical: 'critique' })[machine.thermal] || '–'}</b></span><span>régie ${regieFps} i/s</span></div>${mach.why.length ? `<p class="hp-why">${esc(mach.why.join(' · '))}</p>` : ''}` : `<div class="hp-num"><span>régie ${regieFps} i/s</span></div>`}</div>
    <div class="hp-log"><b>Journal</b>${healthLog.length ? healthLog.slice(0, 15).map(e => `<div class="${e.lvl}"><time>${new Date(e.t).toLocaleTimeString('fr-FR')}</time> ${esc(e.cause)}</div>`).join('') : '<div class="ok">Rien à signaler depuis l\'ouverture de la régie.</div>'}</div>
    <p class="note">Orange ou rouge : vidéo trop lourde (convertis-la en MP4 H.264 1080p), ordinateur trop chaud ou sur batterie, trop de sorties ouvertes. La vignette Outputs et chaque sortie secondaire décodent aussi les vidéos.</p>`;
}
/* ---------- raccourcis clavier personnalisés (show.keys) ---------- */
const KEY_ACTIONS = [
  ['clip', 'Lancer un clip'], ['col', 'Afficher une colonne'], ['take', 'Envoyer la préparation à la sortie'], ['next', 'Séquence suivante'],
  ['prev', 'Séquence précédente'], ['cue', 'Aller à une séquence'], ['scene', 'Ouvrir une scène'], ['black', 'Écran noir (bascule)'],
  ['stop', 'Tout arrêter'], ['eject', 'Arrêter un calque'], ['mute', 'Masquer / afficher un calque'], ['tap', 'Taper le tempo'],
  ['pause', 'Pause / reprise du clip sélectionné'], ['restart', 'Recommencer le clip sélectionné'],
  ['clipdirect', 'Lancer un clip directement à la sortie'], ['coldirect', 'Afficher une colonne directement à la sortie'], ['cuedirect', 'Envoyer une séquence directement à la sortie'],
  ['cond', 'Ouvrir un conducteur'], ['audiomute', 'Couper / rétablir le son de sortie'], ['panels', 'Masquer / afficher les panneaux latéraux'],
];
const KEY_NAMES = { Space: 'Espace', Enter: 'Entrée', Escape: 'Échap', Backspace: '⌫', Delete: 'Suppr', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Backslash: '\\', Home: 'Début', End: 'Fin', PageUp: 'Page ↑', PageDown: 'Page ↓' };
/* Lettres telles qu'elles sont imprimées sur le clavier : disposition réelle si Chrome la donne, sinon AZERTY français. */
let kbdMap = null;
try { navigator.keyboard?.getLayoutMap?.().then(m => { kbdMap = m; }).catch(() => {}); } catch { /* non disponible */ }
const AZERTY = { KeyQ: 'A', KeyW: 'Z', KeyA: 'Q', KeyZ: 'W', Semicolon: 'M', KeyM: ',', Comma: ';', Period: ':', Slash: '=', BracketLeft: '^', BracketRight: '$', Quote: 'ù', Backslash: '`', Backquote: '@', Minus: ')', Equal: '-', IntlBackslash: '<' };
function keyCap(code) {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (KEY_NAMES[code] && !/^(Minus|Equal|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backquote|Backslash)$/.test(code)) return KEY_NAMES[code];
  const m = kbdMap?.get(code);
  if (m && m.trim()) return m.length === 1 ? m.toUpperCase() : m;
  return AZERTY[code] || KEY_NAMES[code] || code.replace(/^Key/, '').replace(/^Numpad/, 'Pavé ');
}
function keyLabel(k) {
  let n = keyCap(k.code);
  return (k.meta ? '⌘' : '') + (k.alt ? '⌥' : '') + (k.shift ? '⇧' : '') + n;
}
const keyMatch = (k, e) => k.code === e.code && !!k.shift === e.shiftKey && !!k.alt === e.altKey && !!k.meta === (e.metaKey || e.ctrlKey);
/** Raccourci à exécuter pour une touche. Un raccourci vaut depuis n'importe quelle scène : s'il vise une colonne ou un calque
 *  d'une autre scène, la régie ouvre d'abord cette scène. */
const keyFor = e => show.keys.find(k => keyMatch(k, e));
const SCENE_ACTIONS = ['col', 'coldirect', 'eject', 'mute'];          // actions dont la cible appartient à une scène précise (k.scene ; '' = la scène ouverte)
const keyScopeLabel = k => (SCENE_ACTIONS.includes(k.action) ? (k.scene ? 'scène « ' + (M.sceneById(show, k.scene)?.name || '?') + ' »' : 'scène ouverte') : '');
/** Cibles possibles d'une action : [valeur, libellé]. `sceneId` : scène visée pour les colonnes et calques. */
function keyTargets(action, sceneId = show.sceneId) {
  if (action === 'clip' || action === 'clipdirect') {
    const out = [];
    for (const sc of show.scenes) for (const l of sc.layers) for (const id of sc.cells[l.id]) if (id && show.clips[id]) out.push([id, (show.scenes.length > 1 ? sc.name + ' · ' : '') + l.name + ' · ' + clipLabel(show.clips[id])]);
    return out;
  }
  if (action === 'col' || action === 'coldirect') return Array.from({ length: 32 }, (_, i) => [String(i + 1), 'Colonne ' + (i + 1)]);
  if (action === 'cue' || action === 'cuedirect') return show.conductors.flatMap(cd => cd.cues.map((c, i) => [c.id, (show.conductors.length > 1 ? cd.name + ' · ' : '') + (i + 1) + ' · ' + c.name]));
  if (action === 'cond') return show.conductors.map(c => [c.id, c.name]);
  if (action === 'scene') return show.scenes.map(s => [s.id, s.name]);
  if (action === 'eject' || action === 'mute') { const sc = M.sceneById(show, sceneId) || M.sceneById(show, show.sceneId); return sc.layers.map(l => [l.id, l.name]); }
  return [];
}
function keyTargetLabel(k) { return keyTargets(k.action, k.scene || show.sceneId).find(t => t[0] === k.target)?.[1] || (k.target ? '(introuvable)' : ''); }
/** Exécute un raccourci. Renvoie true s'il a été pris en charge. */
function runKey(k, e) {
  const a = k.action, t = k.target;
  if (SCENE_ACTIONS.includes(a) && k.scene && k.scene !== show.sceneId) {       // colonne / calque d'une autre scène : on l'ouvre d'abord
    if (!M.sceneById(show, k.scene)) return toast('Ce raccourci vise une scène qui n\'existe plus.', 'err');
    switchScene(k.scene);
  }
  if (a === 'clip' || a === 'clipdirect') {
    const sc = show.scenes.find(s => Object.values(s.cells).some(row => row.includes(t)));
    if (!sc || !show.clips[t]) return toast('Ce raccourci vise un clip qui n\'existe plus.', 'err');
    if (sc.id !== show.sceneId) switchScene(sc.id);
    const lid = Object.keys(show.cells).find(id => show.cells[id].includes(t));
    sel = { kind: 'clip', id: t }; (a === 'clipdirect' ? launchDirect : launch)(lid, t); renderGrid(); renderInspector();
  } else if (a === 'col') launchColumn(+t - 1, e?.shiftKey);
  else if (a === 'coldirect') launchColumn(+t - 1, true);
  else if (a === 'take') take();
  else if (a === 'next') nextCue();
  else if (a === 'prev') prevCue();
  else if (a === 'cue' || a === 'cuedirect') {             // la séquence peut être dans un autre conducteur : on l'ouvre d'abord
    const cd = show.conductors.find(x => x.cues.some(c => c.id === t));
    if (!cd) return toast('Ce raccourci vise une séquence qui n\'existe plus.', 'err');
    if (cd.id !== show.condId) switchConductor(cd.id);
    const i = show.cues.findIndex(c => c.id === t); if (i >= 0) ((prepOn && a === 'cue') ? prepareCue : goCue)(i);
  }
  else if (a === 'cond') { if (!show.conductors.some(c => c.id === t)) return toast('Ce raccourci vise un conducteur qui n\'existe plus.', 'err'); switchConductor(t); }
  else if (a === 'audiomute') toggleAudioMute();
  else if (a === 'panels') { const hide = !(panelsHidden.lib && panelsHidden.right); togglePanel('lib', hide); togglePanel('right', hide); }
  else if (a === 'scene') switchScene(t);
  else if (a === 'black') toggleBlackout();
  else if (a === 'stop') stopAll();
  else if (a === 'eject') eject(t);
  else if (a === 'mute') { const l = layerById(t); if (l) { l.mute = !l.mute; commit(); renderGrid(); } }
  else if (a === 'tap') tap();
  else if (a === 'pause' || a === 'restart') { const c = sel?.kind === 'clip' && show.clips[sel.id]; if (!c) return toast('Sélectionne d\'abord un clip (clic sur sa case).', 'err'); (a === 'pause' ? pauseToggle : restartClip)(c); }
  else return false;
  // Retour visible : on sait que c'est bien le raccourci qui a agi, et où (préparation ou sortie).
  const what = KEY_ACTIONS.find(x => x[0] === a)?.[1] || a, where = /direct$/.test(a) ? '' : (a === 'clip' || a === 'col' || a === 'cue') ? (prepOn && !(a === 'col' && e?.shiftKey) ? ' → préparation (Entrée pour envoyer)' : ' → sortie') : '';
  const sc = SCENE_ACTIONS.includes(a) && show.scenes.length > 1 ? ' (' + M.sceneById(show, show.sceneId).name + ')' : '';
  toast(`${keyLabel(k)} : ${what}${k.target ? ' — ' + keyTargetLabel(k) : ''}${sc}${where}`);
  return true;
}
let keyCapture = null;       // fonction appelée avec la prochaine touche pressée (assignation d'un raccourci)
function captureKey(btn, cb) {
  if (keyCapture) { keyCapture = null; btn?.classList.remove('on'); return; }
  btn?.classList.add('on');
  toast('Appuie sur la touche (ou combinaison) à utiliser… Échap pour annuler.');
  keyCapture = e => {
    btn?.classList.remove('on');
    if (e.code === 'Escape') return;
    if (['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight'].includes(e.code)) { btn?.classList.add('on'); return 'again'; }   // modificateur seul : on attend la touche
    cb({ code: e.code, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey });
  };
}
function setKey(k) {
  k.scene = SCENE_ACTIONS.includes(k.action) ? (k.scene || '') : '';
  // Une touche = un seul raccourci.
  show.keys = show.keys.filter(x => !(x.code === k.code && !!x.shift === !!k.shift && !!x.alt === !!k.alt && !!x.meta === !!k.meta));
  show.keys.push(k); commit();
}
/** Raccourcis d'origine de la régie : [codes, ce qu'ils font]. */
const BUILTIN_KEYS = [
  [['Space'], 'Séquence suivante (conducteur)'], [['Enter', 'NumpadEnter'], 'Envoyer la préparation à la sortie (et fermer une forme dessinée)'],
  [['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'], 'Afficher la colonne de ce numéro (Maj : directement à la sortie)'],
  [['KeyB'], 'Écran noir'], [['KeyT'], 'Taper le tempo'], [['Escape'], 'Tout désélectionner (et annuler un dessin)'],
  [['Delete', 'Backspace'], 'Retirer les fichiers sélectionnés de la médiathèque ; pendant un dessin, enlever le dernier point'],
  [['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'], 'Document ou PowerPoint : page précédente / suivante ; Mapping : déplacer la zone de 1 px (Maj : 10 px)'],
  [['ArrowUp', 'ArrowDown'], 'Mapping : déplacer la zone de 1 px (Maj : 10 px)'], [['KeyF'], 'Plein écran (dans la fenêtre de sortie)'],
];
const KB_ROWS = [
  [['Escape', 1.2], null, ['F1'], ['F2'], ['F3'], ['F4'], null, ['F5'], ['F6'], ['F7'], ['F8'], null, ['F9'], ['F10'], ['F11'], ['F12'], null, ['Home'], ['End'], ['PageUp'], ['PageDown']],
  [['Backquote'], ['Digit1'], ['Digit2'], ['Digit3'], ['Digit4'], ['Digit5'], ['Digit6'], ['Digit7'], ['Digit8'], ['Digit9'], ['Digit0'], ['Minus'], ['Equal'], ['Backspace', 2], null, ['Delete']],
  [['Tab', 1.5], ['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR'], ['KeyT'], ['KeyY'], ['KeyU'], ['KeyI'], ['KeyO'], ['KeyP'], ['BracketLeft'], ['BracketRight'], ['Enter', 1.5]],
  [['CapsLock', 1.8], ['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyH'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon'], ['Quote'], ['Backslash'], ['NumpadEnter', 1.2]],
  [['ShiftLeft', 1.3], ['IntlBackslash'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyB'], ['KeyN'], ['KeyM'], ['Comma'], ['Period'], ['Slash'], ['ShiftRight', 2.3], null, ['ArrowUp']],
  [['ControlLeft', 1.3], ['AltLeft', 1.3], ['MetaLeft', 1.5], ['Space', 6.2], ['MetaRight', 1.5], ['AltRight', 1.3], null, ['ArrowLeft'], ['ArrowDown'], ['ArrowRight']],
];
const KB_NAMES = { Escape: 'Échap', Tab: 'Tab ⇥', CapsLock: 'Verr. maj', ShiftLeft: '⇧ Maj', ShiftRight: '⇧ Maj', ControlLeft: 'Ctrl', AltLeft: '⌥ Alt', AltRight: '⌥ Alt', MetaLeft: '⌘', MetaRight: '⌘', Space: 'Espace', Enter: 'Entrée ↵', NumpadEnter: 'Entrée pavé', Backspace: '⌫', Delete: 'Suppr', Home: 'Début', End: 'Fin', PageUp: 'Pg ↑', PageDown: 'Pg ↓' };
/** Clavier complet : touches utilisées en vert (vif = tes raccourcis, foncé = ceux de la régie), libres en gris ; survol = ce qu'elle fait. */
function openKeyboard() {
  const uses = {};                                           // code → [{txt, mine}]
  for (const [codes, txt] of BUILTIN_KEYS) for (const c of codes) (uses[c] ||= []).push({ txt, mine: false });
  for (const k of show.keys) (uses[k.code] ||= []).push({ txt: `${keyLabel(k)} : ${KEY_ACTIONS.find(a => a[0] === k.action)?.[1] || k.action}${k.target ? ' — ' + keyTargetLabel(k) : ''}${keyScopeLabel(k) ? ' (' + keyScopeLabel(k) + ')' : ''}`, mine: true });
  const keyHtml = ([code, w = 1]) => {
    const u = uses[code] || [], mine = u.some(x => x.mine), lab = KB_NAMES[code] || keyCap(code);
    const tip = u.length ? u.map(x => (x.mine ? '★ ' : '') + x.txt).join('\n') : 'Libre';
    return `<span class="kb-k${mine ? ' mine' : u.length ? ' used' : ''}" style="flex:${w}" data-code="${esc(code)}" title="${esc(tip)}">${esc(lab)}</span>`;
  };
  const rows = KB_ROWS.map(r => `<div class="kb-row">${r.map(k => (k ? keyHtml(k) : '<span class="kb-gap"></span>')).join('')}</div>`).join('');
  const d = openBox(`<h3>Clavier — touches utilisées</h3>
    <p><span class="kb-legend mine"></span> Tes raccourcis &nbsp; <span class="kb-legend used"></span> Raccourcis de la régie &nbsp; <span class="kb-legend"></span> Libre. Survole une touche pour voir ce qu'elle fait (une touche peut servir avec Maj, ⌥ ou ⌘).</p>
    <div class="kb">${rows}</div>
    <div class="kb-info" id="kb-info">Survole une touche…</div>
    <div class="row"><button class="btn" data-cancel>Fermer</button></div>`, 'kbd');
  const info = d.querySelector('#kb-info');
  d.addEventListener('mouseover', e => {
    const k = e.target.closest('.kb-k'); if (!k) return;
    const u = uses[k.dataset.code] || [];
    info.innerHTML = `<b>${esc(KB_NAMES[k.dataset.code] || keyCap(k.dataset.code))}</b> — ` + (u.length ? u.map(x => `<span class="${x.mine ? 'mine' : ''}">${esc(x.txt)}</span>`).join('<br>') : 'libre : tu peux l\'utiliser pour un raccourci.');
  });
  d.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) d.remove(); });
}
function keysPanel() {
  const rows = show.keys.map((k, i) => `<div class="key-row"><kbd>${esc(keyLabel(k))}</kbd><span>${esc(KEY_ACTIONS.find(a => a[0] === k.action)?.[1] || k.action)}${k.target ? ' — ' + esc(keyTargetLabel(k)) : ''}</span><small>${esc(keyScopeLabel(k))}</small><button class="x" data-key-del="${i}" title="Supprimer ce raccourci">✕</button></div>`).join('');
  const action = $('#key-action')?.value || 'clip', withScene = SCENE_ACTIONS.includes(action);
  const scene = withScene ? ($('#key-scene')?.value || show.sceneId) : '', targets = keyTargets(action, scene || show.sceneId);
  return `<h4>Mes raccourcis</h4><div class="keys-list">${rows || '<p class="note">Aucun raccourci personnalisé pour l\'instant.</p>'}</div>
    <div class="key-form"><select id="key-action">${KEY_ACTIONS.map(([v, t]) => `<option value="${v}"${v === action ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      ${withScene && show.scenes.length > 1 ? `<select id="key-scene" title="Scène visée : le raccourci l'ouvre d'abord si une autre scène est ouverte">${show.scenes.map(s => `<option value="${s.id}"${scene === s.id ? ' selected' : ''}>de la scène « ${esc(s.name)} »</option>`).join('')}</select>` : ''}
      ${targets.length ? `<select id="key-target">${targets.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>` : ''}
      <button class="btn sm capture" data-act="key-capture" title="Puis appuie sur la touche voulue">⌨ Touche…</button></div>
    <p class="note">Un raccourci marche depuis n'importe quelle scène. Pour une colonne ou un calque, il vise une scène précise : si une autre scène est ouverte, la régie ouvre d'abord la bonne puis agit (par ex. <kbd>1</kbd> = colonne 1 de « Scène 1 », même depuis « Scène 2 »). Un raccourci personnalisé passe avant les raccourcis d'origine ; une touche ne porte qu'un raccourci. Les touches sont ignorées quand tu écris dans un champ. Chaque clip a aussi « Raccourci » dans ses réglages.</p>`;
}
/* ---------- largeur des panneaux : poignées à tirer, mémorisées ---------- */
/* ---------- panneaux latéraux masquables : plus de place pour la grille ---------- */
let panelsHidden = { lib: false, right: false };
try { panelsHidden = { ...panelsHidden, ...JSON.parse(localStorage.getItem('regieLed.panels') || '{}') }; } catch { /* réglage par défaut */ }
function applyPanels() {
  const v = $('#view-regie');
  v.classList.toggle('nolib', !!panelsHidden.lib); v.classList.toggle('noright', !!panelsHidden.right);
  $('#lib-strip').hidden = !panelsHidden.lib; $('#right-strip').hidden = !panelsHidden.right;
  renderShapes();
}
function togglePanel(k, hide = !panelsHidden[k]) {
  panelsHidden[k] = hide;
  try { localStorage.setItem('regieLed.panels', JSON.stringify(panelsHidden)); } catch { /* sans gravité */ }
  applyPanels();
}
function bindResizers() {
  applyPanels();
  $('#lib-strip').addEventListener('click', () => togglePanel('lib', false));
  $('#right-strip').addEventListener('click', () => togglePanel('right', false));
  const view = $('#view-regie');
  // Hauteur des écrans Préparation / Sortie : poignée sous les écrans, mémorisée.
  // Chaque écran (Préparation, Sortie) a sa propre hauteur, réglée par la poignée de son coin bas-droit ; la largeur suit (16:9).
  // La poignée sous les écrans agrandit ou réduit les deux ensemble. Tout est mémorisé ; double-clic = taille d'origine.
  const center = $('.center'), mh = $('#mon-resizer');
  let sizes = {};
  try { sizes = JSON.parse(localStorage.getItem('regieLed.monSizes')) || {}; } catch { sizes = {}; }
  { const old = +localStorage.getItem('regieLed.monH'); if (old && !sizes.out) { sizes.out = old; sizes.prep = Math.round(old * 1.3); } }   // ancien réglage unique
  const VAR = { prep: '--preph', out: '--outh' };
  const applySizes = () => { for (const k of ['prep', 'out']) { if (sizes[k]) center.style.setProperty(VAR[k], sizes[k] + 'px'); else center.style.removeProperty(VAR[k]); } renderShapes(); };
  const saveSizes = () => { try { localStorage.setItem('regieLed.monSizes', JSON.stringify(sizes)); localStorage.removeItem('regieLed.monH'); } catch { /* sans gravité */ } };
  const clampH = h => Math.round(Math.max(50, Math.min(innerHeight * 0.8, h)));
  applySizes();
  const dragOn = (el, onMove, cursor) => el?.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); el.classList.add('on'); document.body.classList.add('resizing'); document.body.style.cursor = cursor;
    const st = onMove(null, e);
    const move = ev => onMove(st, ev);
    const up = () => { el.classList.remove('on'); document.body.classList.remove('resizing'); document.body.style.cursor = ''; saveSizes(); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  const hOf = id => $(id).getBoundingClientRect().height;
  dragOn(mh, (st, e) => {
    if (!st) return { y0: e.clientY, out: hOf('#mon-out'), prep: prepOn ? hOf('#mon-prep') : (sizes.prep || 0) };
    const out = clampH(st.out + e.clientY - st.y0);
    sizes.out = out; if (st.prep) sizes.prep = clampH(st.prep * out / st.out);
    applySizes();
  }, 'row-resize');
  mh?.addEventListener('dblclick', () => { sizes = {}; applySizes(); saveSizes(); });
  for (const g of $$('.mon-grip')) {
    const k = g.dataset.grip, box = k === 'prep' ? '#mon-prep' : '#mon-out';
    dragOn(g, (st, e) => {
      if (!st) return { x0: e.clientX, y0: e.clientY, h: hOf(box) };
      const dx = (e.clientX - st.x0) * 9 / 16, dy = e.clientY - st.y0;
      sizes[k] = clampH(st.h + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
      applySizes();
    }, 'nwse-resize');
    g.addEventListener('dblclick', e => { e.stopPropagation(); delete sizes[k]; applySizes(); saveSizes(); });
  }
  const apply = (key, px) => { if (px) view.style.setProperty(key === 'lib' ? '--libw' : '--rightw', px + 'px'); else view.style.removeProperty(key === 'lib' ? '--libw' : '--rightw'); };
  for (const key of ['lib', 'right']) { const v = +localStorage.getItem('regieLed.w.' + key); if (v) apply(key, v); }
  for (const [id, key] of [['#lib-resizer', 'lib'], ['#right-resizer', 'right']]) {
    const h = $(id); if (!h) continue;
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('on'); document.body.classList.add('resizing');
      const rect = view.getBoundingClientRect(), x0 = e.clientX;
      const start = key === 'lib' ? $('#lib').getBoundingClientRect().width : $('.right').getBoundingClientRect().width;
      const move = ev => {
        const d = key === 'lib' ? ev.clientX - x0 : x0 - ev.clientX;
        const w = Math.round(Math.max(150, Math.min(rect.width * 0.5, start + d)));
        apply(key, w); localStorage.setItem('regieLed.w.' + key, String(w)); renderShapes();
      };
      const up = () => { h.classList.remove('on'); document.body.classList.remove('resizing'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', () => { apply(key, 0); localStorage.removeItem('regieLed.w.' + key); renderShapes(); });   // largeur d'origine
  }
}
function bindTop() {
  bindResizers();
  $('#tabs').addEventListener('click', e => { const t = e.target.closest('[data-tab]')?.dataset.tab; if (t) setTab(t); });
  $('#tap').addEventListener('click', tap);
  $('#bpm').addEventListener('change', e => { show.bpm = M.clamp(+e.target.value || 120, 20, 300); e.target.value = show.bpm; commit(); });
  $('#mic').addEventListener('click', toggleMic);
  $('#master').addEventListener('input', e => { show.master.opacity = +e.target.value; commit(); });
  $('#blackout').addEventListener('click', toggleBlackout);
  $('#audio-mute').addEventListener('click', toggleAudioMute);
  $('#health').addEventListener('click', () => { const p = $('#health-panel'); p.hidden = !p.hidden; if (!p.hidden) renderHealthPanel(); });
  $('#health-panel').addEventListener('click', e => { if (e.target.closest('[data-act="health-close"]')) $('#health-panel').hidden = true; });
  $('#open-out').addEventListener('click', openOutput);
  $('#out-fix').addEventListener('click', async () => {
    if (!refreshOutput()) await openOutput();          // la recharger sur place, sinon en ouvrir une neuve
    setTimeout(() => {
      if (Date.now() - staleSeen < 2500) toast('Une ancienne fenêtre de sortie est encore ouverte (celle qui reste noire) : clique dessus puis ferme-la avec ⌘W. Si la nouvelle n\'est pas sur le bon écran, glisse-la dessus.', 'err');
    }, 5000);
  });
  document.addEventListener('click', e => e.target.closest('button')?.blur());       // la barre d'espace reste au conducteur
  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (keyCapture) {                                        // assignation d'un raccourci : on prend cette touche
      e.preventDefault();
      const cb = keyCapture; const r = cb(e); if (r !== 'again') keyCapture = null;
      return;
    }
    if (Date.now() < pickingUntil) return;                 // le sélecteur de fenêtre est ouvert : les touches lui appartiennent
    if (drawing) {                                           // dessin d'une forme : Entrée ferme, Échap annule, Retour arrière enlève le dernier point
      if (e.key === 'Enter') { e.preventDefault(); return finishDraw(); }
      if (e.key === 'Escape') { e.preventDefault(); return cancelDraw(); }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); drawing.pts.pop(); renderDraw(); return renderShapeBar(); }
      return;
    }
    const custom = keyFor(e);
    if (custom) { e.preventDefault(); runKey(custom, e); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (tab === 'mapping' && mapping.key(e)) return;
    if (e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); nextCue(); }
    else if (e.key === 'Enter' && prepOn && tab === 'regie') { e.preventDefault(); take(); }
    else if (e.key === 'b' || e.key === 'B') toggleBlackout();
    else if (e.key === 't' || e.key === 'T') tap();
    else if (e.key === 'Escape') { sel = null; zoneSel = null; libSel.clear(); refreshLibSel(); renderGrid(); renderCues(); renderInspector(); renderShapeBar(); renderShapes(); }
    else if (tab === 'regie' && libSel.size && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelection(); }
    else if (tab === 'regie' && /^Digit[1-9]$/.test(e.code)) launchColumn(+e.code.slice(5) - 1, e.shiftKey);
    else if (tab === 'regie' && ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(e.key)) {
      const c = activePaged(), dir = e.key === 'ArrowRight' || e.key === 'PageDown' ? 'next' : 'prev';
      if (c) { e.preventDefault(); if (c.type === 'doc') docTurn(c, dir); else pptCmd(c, dir); }
    }
  });
}

/* ---------- formes : zones créées et déplacées directement sur l'écran de préparation ---------- */
// Une « forme » = une zone (show.slices) + son calque dédié. Tout se fait dans la composition : la sortie n'est pas touchée.
let shapesOn = localStorage.getItem('regieLed.shapes') !== '0', snapOn = localStorage.getItem('regieLed.snap') !== '0', zoneSel = null, zDrag = null, ovBox = '';
let drawing = null;                       // dessin d'une forme à la main : {pts:[[x,y]…] (px composition), down:[x,y]|null, moved, hover, guides}
let zoneMulti = new Set();                // sélection multiple de formes (Maj+clic) : pour les fusionner en une seule zone
/** Aimantation : rapproche une valeur (bord ou centre d'une forme) des bords / centres de l'image et des autres formes. */
function snapTo(v, cands, tol) { let best = v, d = tol; for (const c of cands) { const dd = Math.abs(c - v); if (dd < d) { d = dd; best = c; } } return best; }
function snapCands(axis, except) {
  const { comp } = show, out = axis === 'x' ? [0, comp.w / 2, comp.w] : [0, comp.h / 2, comp.h];
  for (const z of show.slices) if (z !== except && !zoneIsFull(z)) { const s = z.src; if (axis === 'x') out.push(s.x, s.x + s.w / 2, s.x + s.w); else out.push(s.y, s.y + s.h / 2, s.y + s.h); }
  return out;
}
/** Aimant pour un déplacement : le bord gauche, le centre ou le bord droit (idem en hauteur) se cale sur l'image et les autres formes. */
function snapMove(z, w, h, x, y) {
  if (!snapOn) return [x, y];
  const tol = Math.round(show.comp.w / 110), cx = snapCands('x', z), cy = snapCands('y', z);
  const best = (v0, size, c) => { let d = 0, bd = tol + 1; for (const v of [v0, v0 + size / 2, v0 + size]) { const t = snapTo(v, c, tol); if (t !== v && Math.abs(t - v) < bd) { bd = Math.abs(t - v); d = t - v; } } return d; };
  return [Math.round(x + best(x, w, cx)), Math.round(y + best(y, h, cy))];
}
/** Aimant pour un redimensionnement par la poignée `h` (0 HG, 1 HD, 2 BD, 3 BG) : les bords tirés se calent. */
function snapEdges(z, h, x0, y0, x1, y1) {
  if (!snapOn || z.src.rot) return [x0, y0, x1, y1];
  const tol = Math.round(show.comp.w / 110), cx = snapCands('x', z), cy = snapCands('y', z);
  if (h === 0 || h === 3) x0 = Math.min(snapTo(x0, cx, tol), x1 - 1); else x1 = Math.max(snapTo(x1, cx, tol), x0 + 1);
  if (h === 0 || h === 1) y0 = Math.min(snapTo(y0, cy, tol), y1 - 1); else y1 = Math.max(snapTo(y1, cy, tol), y0 + 1);
  return [x0, y0, x1, y1];
}
const ZCOLORS = ['#ffb300', '#00c2ff', '#ff4d6d', '#5ad65a', '#c77dff', '#ff8c42', '#f5f5f5'];
const SHAPE_NAME = { rect: 'Rectangle', carre: 'Carré', losange: 'Losange', cercle: 'Cercle', triangle: 'Triangle', triangle2: 'Triangle', hexagone: 'Hexagone', libre: 'Forme' };
const SHAPE_ICON = { rect: '▭', carre: '◻', losange: '◇', cercle: '◯', triangle: '△', triangle2: '▽', hexagone: '⬡' };
const zoneById = id => show.slices.find(z => z.id === id);
const zoneIsFull = z => !z.quad && ['rect', 'carre'].includes(z.shape || 'rect') && !z.src.rot && z.src.x <= 0 && z.src.y <= 0 && z.src.w >= show.comp.w && z.src.h >= show.comp.h;
const zoneLayers = id => show.layers.filter(l => l.zone === id);
const shapeHost = () => (prepOn ? $('#mon-prep') : $('#mon-out'));
/** Tant qu'une zone n'a pas été placée à la main sur la sortie, elle y reste au même endroit que dans la composition. */
function alignDst(z) {
  const kx = show.output.w / show.comp.w, ky = show.output.h / show.comp.h;
  if (M.zoneQuad(z)) { z.dst = z.quad.map(([x, y]) => [Math.round(x * kx), Math.round(y * ky)]); return; }
  const x0 = Math.round(z.src.x * kx), y0 = Math.round(z.src.y * ky), x1 = Math.round((z.src.x + z.src.w) * kx), y1 = Math.round((z.src.y + z.src.h) * ky);
  z.dst = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
function clampZone(z) {
  const { comp } = show;
  z.src.w = M.clamp(Math.round(z.src.w), 1, comp.w); z.src.h = M.clamp(Math.round(z.src.h), 1, comp.h);
  z.src.x = M.clamp(Math.round(z.src.x), 0, comp.w - z.src.w); z.src.y = M.clamp(Math.round(z.src.y), 0, comp.h - z.src.h);
  if (!z.custom) alignDst(z);
}
function selectZone(id) {
  zoneSel = id; zoneMulti.clear();
  const l = id && zoneLayers(id)[0];
  if (l && !(sel?.kind === 'layer' && sel.id === l.id)) { sel = { kind: 'layer', id: l.id }; renderGrid(); renderInspector(); }
  renderShapeBar(); renderShapes(); mapping?.select(id);
}
/* ---- formes libres : polygones (dessiné + collés), sommets déplaçables, fusion ---- */
/** Point du repère local de la zone (px, non tourné) → composition (rotation autour du centre du cadre). */
function zoneToWorld(z, lx, ly) {
  const s = z.src, cx = s.x + s.w / 2, cy = s.y + s.h / 2, r = (s.rot || 0) * Math.PI / 180, c = Math.cos(r), si = Math.sin(r), dx = lx - cx, dy = ly - cy;
  return [cx + c * dx - si * dy, cy + si * dx + c * dy];
}
function worldToZone(z, wx, wy) {
  const s = z.src, cx = s.x + s.w / 2, cy = s.y + s.h / 2, r = -(s.rot || 0) * Math.PI / 180, c = Math.cos(r), si = Math.sin(r), dx = wx - cx, dy = wy - cy;
  return [cx + c * dx - si * dy, cy + si * dx + c * dy];
}
/** Contours de la zone en px du repère local (cadre non tourné). */
const localGroups = z => { const s = z.src; return M.shapeGroups(z).map(g => g.map(([u, v]) => [s.x + u * s.w, s.y + v * s.h])); };
/** Contours de la zone en px de la composition, rotation comprise. */
const zoneWorldPolys = z => (M.zoneQuad(z) ? M.shapeGroups(z).map(g => g.map(([u, v]) => M.zonePoint(z, u, v))) : localGroups(z).map(g => g.map(([x, y]) => zoneToWorld(z, x, y))));
/* ---- coins libres dans la composition : z.quad (4 points), z.src = boîte englobante ---- */
function syncQuad(z) {
  const { comp } = show;
  z.quad = z.quad.map(([x, y]) => [Math.round(M.clamp(x, 0, comp.w)), Math.round(M.clamp(y, 0, comp.h))]);
  const b = M.quadBounds(z.quad);
  z.src = { x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), rot: 0 };
  if (!z.custom) alignDst(z);
}
/** Active ou retire les coins libres d'une forme. Activer part de ses 4 coins actuels (rotation comprise). */
function toggleQuad(z) {
  if (!z) return;
  if (M.zoneQuad(z)) { delete z.quad; syncSrcFromQuadOff(z); toast(`« ${z.name} » redevient un rectangle (sa boîte englobante).`); }
  else {
    z.quad = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => M.zonePoint(z, u, v));
    syncQuad(z);
    toast(`Coins libres sur « ${z.name} » : tire chaque coin (rond doré) pour épouser l'écran ; l'image se déforme avec.`);
  }
  commit(); renderShapeBar(); renderShapes(); renderInspector(); mapping?.refresh(true);
}
function syncSrcFromQuadOff(z) { z.src.rot = 0; clampZone(z); }
/** Déplace une forme à coins libres (oq = coins au départ, o = boîte au départ), avec l'aimant. */
function quadMove(z, oq, o, dx, dy, magnet = true) {
  const [x, y] = magnet ? snapMove(z, o.w, o.h, o.x + dx, o.y + dy) : [o.x + dx, o.y + dy];
  const { comp } = show, X = M.clamp(x, 0, comp.w - o.w), Y = M.clamp(y, 0, comp.h - o.h);
  z.quad = oq.map(([px, py]) => [px + X - o.x, py + Y - o.y]);
  syncQuad(z);
}
/** Déplace un seul coin (k) d'une forme à coins libres ; l'aimant le cale sur l'image, les autres formes et ses propres coins. */
function quadCorner(z, oq, k, px, py) {
  if (snapOn) {
    const tol = Math.round(show.comp.w / 110), cx = snapCands('x', z), cy = snapCands('y', z);
    oq.forEach((p, i) => { if (i !== k) { cx.push(p[0]); cy.push(p[1]); } });
    px = snapTo(px, cx, tol); py = snapTo(py, cy, tol);
  }
  z.quad = oq.map(p => [...p]); z.quad[k] = [px, py];
  syncQuad(z);
}
/** Après modification des sommets (px locaux) : nouveau cadre, points renormalisés, rotation et centre conservés. */
function refitPoly(z, groups) {
  const xs = groups.flat().map(p => p[0]), ys = groups.flat().map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(8, Math.max(...xs) - x0), h = Math.max(8, Math.max(...ys) - y0);
  const [cx, cy] = zoneToWorld(z, x0 + w / 2, y0 + h / 2);                 // centre du nouveau cadre, dans la composition
  const norm = g => g.map(([x, y]) => [+(((x - x0) / w).toFixed(4)), +(((y - y0) / h).toFixed(4))]);
  z.shape = 'libre'; z.poly = norm(groups[0]); z.extra = groups.slice(1).map(norm); if (!z.extra.length) delete z.extra;
  z.src = { ...z.src, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
  if (!z.src.rot) clampZone(z); else if (!z.custom) alignDst(z);
}
/** Déplace un sommet (pg = polygone, v = index) vers un point de la composition, avec l'aimant (cadre non tourné seulement). */
function setVertex(z, pg, v, world) {
  const gs = localGroups(z); if (!gs[pg]?.[v]) return;
  let [lx, ly] = worldToZone(z, world[0], world[1]);
  if (snapOn && !z.src.rot) {
    const tol = Math.round(show.comp.w / 110), cx = snapCands('x', z), cy = snapCands('y', z);
    gs.forEach((g, i) => g.forEach((q, j) => { if (i !== pg || j !== v) { cx.push(q[0]); cy.push(q[1]); } }));
    lx = snapTo(lx, cx, tol); ly = snapTo(ly, cy, tol);
  }
  gs[pg][v] = [Math.round(lx), Math.round(ly)];
  refitPoly(z, gs);
}
/** Insère un sommet au milieu du côté v → v+1 ; renvoie son index. */
function insertVertex(z, pg, v) {
  const gs = localGroups(z), g = gs[pg]; if (!g) return null;
  const a = g[v], b = g[(v + 1) % g.length];
  g.splice(v + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  refitPoly(z, gs); return v + 1;
}
function deleteVertex(z, pg, v) {
  const gs = localGroups(z); if (!gs[pg] || gs[pg].length <= 3) return false;
  gs[pg].splice(v, 1); refitPoly(z, gs); return true;
}
/** Sélection multiple (Maj+clic) : ajoute ou retire une forme. */
function toggleMulti(id) {
  if (!zoneById(id)) return;
  if (!zoneMulti.size && zoneSel && zoneSel !== id) zoneMulti.add(zoneSel);
  if (zoneMulti.has(id)) zoneMulti.delete(id); else zoneMulti.add(id);
  if (zoneMulti.size === 1) zoneMulti.clear();
  zoneSel = id;
  renderShapeBar(); renderShapes(); mapping?.select(id);
}
/** Fusionne les formes sélectionnées en une seule zone libre (union des contours) ; leurs calques pointent sur la nouvelle zone. */
function mergeShapes() {
  const zs = [...zoneMulti].map(zoneById).filter(Boolean);
  if (zs.length < 2) return toast('Sélectionne au moins deux formes (Maj+clic) pour les fusionner.', 'err');
  const groups = zs.flatMap(zoneWorldPolys), xs = groups.flat().map(p => p[0]), ys = groups.flat().map(p => p[1]);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys)), w = Math.max(8, Math.ceil(Math.max(...xs)) - x0), h = Math.max(8, Math.ceil(Math.max(...ys)) - y0);
  const norm = g => g.map(([x, y]) => [+(((x - x0) / w).toFixed(4)), +(((y - y0) / h).toFixed(4))]);
  const z = M.newSlice(show, zs[0].name);
  z.shape = 'libre'; z.poly = norm(groups[0]); z.extra = groups.slice(1).map(norm);
  z.src = { x: x0, y: y0, w, h, rot: 0 }; clampZone(z);
  const at = Math.min(...zs.map(o => show.slices.indexOf(o)));
  for (const o of zs) { for (const l of zoneLayers(o.id)) l.zone = z.id; show.slices.splice(show.slices.indexOf(o), 1); }   // rien n'est perdu : les calques suivent
  show.slices.splice(at, 0, z);
  if (!zoneLayers(z.id).length && show.layers.length < MAX_LAYERS) { const l = M.newLayer(z.name); l.zone = z.id; show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null); }
  zoneMulti.clear(); zoneSel = z.id; const l0 = zoneLayers(z.id)[0]; if (l0) sel = { kind: 'layer', id: l0.id };
  cleanup(); commit(); renderAll(); mapping?.select(z.id);
  toast(`${zs.length} formes fusionnées en « ${z.name} » : une seule zone, ses sommets restent modifiables.`);
}
/** Défusionne : chaque contour de la zone redevient une forme à part (la première garde les calques ; les autres reçoivent un calque neuf). */
function splitShape() {
  const z = zoneById(zoneSel);
  if (!z || z.shape !== 'libre' || !z.extra?.length) return toast('Cette forme n\'est pas une fusion.', 'err');
  const groups = zoneWorldPolys(z), at = show.slices.indexOf(z), made = [];
  groups.forEach((g, i) => {
    const xs = g.map(q => q[0]), ys = g.map(q => q[1]);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys)), w = Math.max(8, Math.ceil(Math.max(...xs)) - x0), h = Math.max(8, Math.ceil(Math.max(...ys)) - y0);
    const poly = g.map(([x, y]) => [+(((x - x0) / w).toFixed(4)), +(((y - y0) / h).toFixed(4))]);
    const n = M.newSlice(show, i ? shapeAutoName('libre') : z.name);
    // un contour qui est exactement le cadre redevient un rectangle (ou un carré)
    const near = t => Math.abs(t) < 0.02 || Math.abs(t - 1) < 0.02;          // tolérance : les arrondis de la fusion
    const isBox = poly.length === 4 && poly.every(([u, v]) => near(u) && near(v)) && new Set(poly.map(([u, v]) => Math.round(u) + ',' + Math.round(v))).size === 4;
    if (isBox) { n.shape = w === h ? 'carre' : 'rect'; n.name = i ? shapeAutoName(n.shape) : z.name; } else { n.shape = 'libre'; n.poly = poly; }
    n.src = { x: x0, y: y0, w, h, rot: 0 }; clampZone(n);
    show.slices.splice(at + i, 0, n); made.push(n);
  });
  show.slices.splice(show.slices.indexOf(z), 1);
  for (const l of zoneLayers(z.id)) l.zone = made[0].id;                       // les calques restent sur le premier morceau
  for (const n of made.slice(1)) if (show.layers.length < MAX_LAYERS) { const l = M.newLayer(n.name); l.zone = n.id; show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null); }
  zoneMulti.clear(); zoneSel = made[0].id; const l0 = zoneLayers(made[0].id)[0]; if (l0) sel = { kind: 'layer', id: l0.id };
  cleanup(); commit(); renderAll(); mapping?.select(made[0].id);
  toast(`Fusion défaite : ${made.length} formes séparées (« ${made[0].name} » garde les calques).`);
}
/** Un carré reste carré : côté = le plus petit des deux, autour du même centre. */
function squarify(z) {
  const side = Math.max(8, Math.min(z.src.w, z.src.h)), cx = z.src.x + z.src.w / 2, cy = z.src.y + z.src.h / 2;
  z.src = { ...z.src, x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), w: side, h: side };
  clampZone(z);
}
/** Nom libre pour une nouvelle forme : « Carré 2 », « Forme 3 »… */
function shapeAutoName(shape) {
  const others = show.slices.filter(z => !zoneIsFull(z));
  return SHAPE_NAME[shape] + ' ' + (others.filter(o => SHAPE_NAME[o.shape || 'rect'] === SHAPE_NAME[shape]).length + 1);
}
/** Crée une forme (zone + calque dédié) et la sélectionne. `src` : cadre en px composition ; `poly` : points d'une forme libre. */
function createZone(shape, src, poly) {
  if (show.layers.length >= MAX_LAYERS) { toast(MAX_LAYERS + ' calques maximum : supprime un calque ou une forme avant d\'en ajouter une.', 'err'); return null; }
  const z = M.newSlice(show, shapeAutoName(shape));
  z.shape = shape; if (poly) z.poly = poly;
  z.src = { ...src, rot: +src.rot || 0 };
  clampZone(z);
  show.slices.push(z);
  const l = M.newLayer(z.name); l.zone = z.id;
  show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null);
  zoneSel = z.id; sel = { kind: 'layer', id: l.id };
  if (!shapesOn) { shapesOn = true; try { localStorage.setItem('regieLed.shapes', '1'); } catch { /* sans gravité */ } }
  commit(); renderGrid(); renderInspector(); renderShapeBar(); renderShapes(); mapping?.select(z.id);
  return z;
}
function addShape(shape) {
  const { comp } = show, h = Math.round(comp.h * 0.45), w = Math.min(comp.w, shape === 'rect' ? Math.round(h * 1.5) : h);
  const others = show.slices.filter(z => !zoneIsFull(z)), off = ((others.length + 2) % 5 - 2) * Math.round(comp.h * 0.12);   // décalées pour ne pas se recouvrir
  const z = createZone(shape, { x: Math.round((comp.w - w) / 2) + off * 2, y: Math.round((comp.h - h) / 2) + off, w, h });
  if (z) toast(`« ${z.name} » créé : glisse une vidéo ou une image dessus, ou dans sa ligne de la grille.`);
}
/* ---- dessin d'une forme à la main : clic point par point, ou tracé continu (bouton enfoncé) ; fermeture sur le 1er point, double-clic ou Entrée ---- */
/** Le SVG sur lequel on dessine : l'écran de préparation / sortie (Régie) ou la composition (Mapping). */
function drawSvg() {
  if (tab === 'mapping') return $('#view-mapping #st-in svg');
  if (tab === 'regie') return shapeHost()?.querySelector('.mon-ov') || null;
  return null;
}
function startDraw() {
  if (tab !== 'regie' && tab !== 'mapping') return;
  if (show.layers.length >= MAX_LAYERS) return toast(MAX_LAYERS + ' calques maximum : supprime un calque ou une forme avant d\'en dessiner une.', 'err');
  if (tab === 'regie' && !shapesOn) { shapesOn = true; try { localStorage.setItem('regieLed.shapes', '1'); } catch { /* sans gravité */ } renderShapes(); }
  drawing = { pts: [], down: null, moved: false };
  renderShapeBar(); renderDraw();
  toast('Dessine la forme sur ' + (tab === 'mapping' ? 'la composition' : 'l\'écran') + ' : clique point par point (ou trace en gardant le bouton enfoncé). Pour fermer : reviens sur le premier point, double-clic ou Entrée. Échap annule.');
}
function cancelDraw() { if (!drawing) return; drawing = null; renderDraw(); renderShapeBar(); }
/** Aimant pendant le dessin : le point se cale sur les bords/centres de l'image, les sommets des autres formes, les points déjà posés,
 *  et sur un angle par pas de 45° depuis le dernier point. Renvoie le point calé et les guides à dessiner. */
function drawSnap(p) {
  const { comp } = show, tol = Math.round(comp.w / 110), pts = drawing.pts, guides = [];
  if (!snapOn) return { p, guides };
  const cx = snapCands('x', null), cy = snapCands('y', null);
  for (const q of pts) { cx.push(q[0]); cy.push(q[1]); }
  for (const z of show.slices) if (!zoneIsFull(z)) for (const g of zoneWorldPolys(z)) for (const q of g) { cx.push(q[0]); cy.push(q[1]); }
  let x = snapTo(p[0], cx, tol), y = snapTo(p[1], cy, tol);
  const sx = x !== p[0], sy = y !== p[1], last = pts[pts.length - 1];
  if (last && !(sx && sy)) {
    const dx = x - last[0], dy = y - last[1], d = Math.hypot(dx, dy);
    if (d > tol) {
      const a = Math.atan2(dy, dx), k = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(a - k) < 0.14) {                                          // à moins de 8° d'un angle « rond »
        const c = Math.cos(k), s = Math.sin(k);
        if (sx && Math.abs(c) > 0.5) y = last[1] + (x - last[0]) * s / c;
        else if (sy && Math.abs(s) > 0.5) x = last[0] + (y - last[1]) * c / s;
        else if (!sx && !sy) { x = last[0] + d * c; y = last[1] + d * s; }
        guides.push({ line: [last, [x, y]] });
      }
    }
  }
  if (sx) guides.push({ x }); if (sy) guides.push({ y });
  return { p: [M.clamp(Math.round(x), 0, comp.w), M.clamp(Math.round(y), 0, comp.h)], guides };
}
/** Simplification d'un tracé (Douglas-Peucker) : garde les points qui comptent, même après un tracé continu à la souris. */
function simplifyPath(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const d2 = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1]; return x * x + y * y; };
  const rdp = (a, b) => {
    let im = -1, dm = eps * eps;
    for (let i = a + 1; i < b; i++) { const d = d2(pts[i], pts[a], pts[b]); if (d > dm) { dm = d; im = i; } }
    return im < 0 ? [pts[a]] : [...rdp(a, im), ...rdp(im, b)];
  };
  const out = [...rdp(0, pts.length - 1), pts[pts.length - 1]];
  return out.filter((p, i) => !i || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > eps);   // pas de doublons
}
function finishDraw() {
  if (!drawing) return;
  const { comp } = show, pts = simplifyPath(drawing.pts.filter(q => isFinite(q[0]) && isFinite(q[1])), comp.w / 400);   // jamais de point invalide (écran réduit à 0)
  if (pts.length < 3) return toast('Il faut au moins 3 points pour fermer une forme (clique encore sur l\'écran).', 'err');
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys))), x1 = Math.min(comp.w, Math.ceil(Math.max(...xs))), y1 = Math.min(comp.h, Math.ceil(Math.max(...ys)));
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return toast('Forme trop petite : trace-la plus grande.', 'err');
  const poly = pts.map(([x, y]) => [+(((x - x0) / w).toFixed(4)), +(((y - y0) / h).toFixed(4))]);
  drawing = null; renderDraw();
  const z = createZone('libre', { x: x0, y: y0, w, h }, poly);
  if (z) toast(`« ${z.name} » dessinée (${poly.length} points) : glisse un média dessus. Les poignées la redimensionnent, la forme suit.`);
}
/** Dessine le tracé en cours par-dessus l'aperçu (et met le SVG en mode dessin : curseur en croix, clics captés). */
function renderDraw() {
  for (const sv of $$('.mon-ov, #st-in svg')) { sv.querySelector('.draw-g')?.remove(); sv.classList.toggle('drawing', !!drawing && sv === drawSvg()); }
  const sv = drawing && drawSvg();
  if (!sv) return;
  const { comp } = show, u = comp.w / Math.max(1, sv.getBoundingClientRect().width), pts = drawing.pts;
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('class', 'draw-g');
  const hv = drawing.hover, last = pts[pts.length - 1];
  g.innerHTML = (drawing.guides || []).map(gd => gd.x != null ? `<line class="dr-g" x1="${gd.x}" y1="0" x2="${gd.x}" y2="${comp.h}"/>` : gd.y != null ? `<line class="dr-g" x1="0" y1="${gd.y}" x2="${comp.w}" y2="${gd.y}"/>` : `<line class="dr-g" x1="${gd.line[0][0]}" y1="${gd.line[0][1]}" x2="${gd.line[1][0]}" y2="${gd.line[1][1]}"/>`).join('')
    + (pts.length > 1 ? `<polyline class="dr-l" points="${pts.map(p => p.join(',')).join(' ')}"/>` : '')
    + (pts.length > 2 ? `<line class="dr-c" x1="${last[0]}" y1="${last[1]}" x2="${pts[0][0]}" y2="${pts[0][1]}"/>` : '')
    + (hv && last && !drawing.down ? `<line class="dr-h" x1="${last[0]}" y1="${last[1]}" x2="${hv[0]}" y2="${hv[1]}"/>` : '')
    + pts.map((p, i) => `<circle class="dr-p${i ? '' : ' first'}" cx="${p[0]}" cy="${p[1]}" r="${(i ? 4 : 7) * u}"/>`).join('')
    + (hv && !drawing.down ? `<circle class="dr-hv" cx="${hv[0]}" cy="${hv[1]}" r="${4 * u}"/>` : '');
  sv.append(g);
}
function bindDraw() {
  const pt = (e, sv) => { const r = sv.getBoundingClientRect(); return [M.clamp((e.clientX - r.left) / Math.max(1, r.width) * show.comp.w, 0, show.comp.w), M.clamp((e.clientY - r.top) / Math.max(1, r.height) * show.comp.h, 0, show.comp.h)]; };
  const onSvg = e => { const sv = drawing && drawSvg(); return sv && (e.target === sv || sv.contains(e.target)) ? sv : null; };
  document.addEventListener('pointerdown', e => {
    const sv = onSvg(e); if (!sv || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    drawing.down = pt(e, sv); drawing.moved = false;
  }, true);
  document.addEventListener('pointermove', e => {
    if (drawing && !drawing.down) {                                           // survol : point calé par l'aimant + guides, avant de cliquer
      const sv = drawSvg(); if (!sv) return;
      const r = sv.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { if (drawing.hover) { drawing.hover = null; drawing.guides = []; renderDraw(); } return; }
      const sn = drawSnap(pt(e, sv)); drawing.hover = sn.p; drawing.guides = sn.guides; renderDraw(); return;
    }
    if (!drawing?.down) return;
    const sv = drawSvg(); if (!sv) return;
    const p = pt(e, sv), last = drawing.pts[drawing.pts.length - 1] || drawing.down, step = show.comp.w / 150;
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < step) return;
    if (!drawing.moved) { drawing.moved = true; if (!drawing.pts.length || Math.hypot(drawing.down[0] - last[0], drawing.down[1] - last[1]) > step) drawing.pts.push(drawing.down); }   // tracé continu : on part du point d'appui
    drawing.pts.push(p); renderDraw();
  });
  document.addEventListener('pointerup', e => {
    if (!drawing?.down) return;
    const sv = drawSvg(), down = drawing.down; drawing.down = null;
    if (!sv) return;
    if (drawing.moved) return renderDraw();                                   // fin d'un tracé continu : les points sont déjà là
    const p = pt(e, sv), first = drawing.pts[0], tol = show.comp.w / Math.max(1, sv.getBoundingClientRect().width) * 12;   // ~12 px écran
    if (first && drawing.pts.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) <= tol) return finishDraw();   // clic sur le 1er point : on ferme
    drawing.pts.push(drawSnap(down).p); drawing.guides = []; renderDraw(); renderShapeBar();
  });
  document.addEventListener('dblclick', e => { if (onSvg(e)) { e.preventDefault(); if (drawing.pts.length >= 3) finishDraw(); } }, true);
}
function delShape() {
  const z = zoneById(zoneSel);
  if (!z) return;
  const ls = zoneLayers(z.id);
  if (!confirm(`Supprimer la forme « ${z.name} »` + (ls.length ? ' et son calque (avec ses clips) ?' : ' ?'))) return;
  show.slices.splice(show.slices.indexOf(z), 1);
  if (!show.slices.length) show.slices.push(M.newSlice(show, 'Écran principal'));
  for (const l of ls) {
    if (show.layers.length <= 1) { l.zone = ''; continue; }
    show.layers.splice(show.layers.indexOf(l), 1);
    delete show.cells[l.id]; delete live.layers[l.id]; delete prep.layers[l.id];
    for (const q of M.allCues(show)) delete q.layers[l.id];
  }
  zoneSel = null;
  if (sel?.kind === 'layer' && !layerById(sel.id)) sel = null;
  cleanup(); commit(); renderAll(); mapping?.select(null);
}
/** Dépose un média sur une forme : il va dans le calque de cette forme et se lance (dans l'aperçu en mode Préparation). */
function dropOnZone(z, clip) {
  let l = zoneLayers(z.id)[0];
  if (!l) {
    if (show.layers.length >= MAX_LAYERS) return toast(MAX_LAYERS + ' calques maximum.', 'err');
    l = M.newLayer(z.name); l.zone = z.id; show.layers.push(l); show.cells[l.id] = Array(show.cols).fill(null);
  }
  sel = { kind: 'layer', id: l.id };
  addClipToGrid(clip, 0);
  if (show.clips[clip.id]) launch(l.id, clip.id);
  zoneSel = z.id; renderShapeBar(); renderShapes();
}
function renderShapeBar() {
  const z = zoneById(zoneSel);
  const add = Object.keys(SHAPE_ICON).map(k => `<button class="btn sm ico" data-shape-add="${k}" title="Ajouter une forme : ${esc(M.SHAPES.find(s => s[0] === k)[1])}">${SHAPE_ICON[k]}</button>`).join('')
    + `<button class="btn sm ico${drawing ? ' on' : ''}" data-act="shape-draw" title="Dessiner une forme à la main : clique point par point sur l'écran (ou trace en gardant le bouton enfoncé), puis reviens sur le premier point, double-clic ou Entrée pour fermer. Échap annule.">✎</button>`;
  let edit = `<span class="sb-hint">Ajoute une forme, puis déplace-la et étire-la directement sur ${tab === 'mapping' ? 'la composition' : 'l\'écran de préparation'}. La sortie suit toute seule.</span>`;
  if (drawing) {
    const n = drawing.pts.length;
    edit = `<span class="sb-draw">✎ Dessin : ${n} point${n > 1 ? 's' : ''} — ${n >= 3 ? 'clique sur le premier point, double-clic ou Entrée pour fermer' : 'clique sur l\'écran pour poser les points (ou trace en continu)'}</span>
      <button class="btn sm gold" data-act="draw-done"${n < 3 ? ' disabled' : ''}>Fermer la forme</button><button class="btn sm" data-act="draw-cancel">Annuler</button>`;
  } else if (zoneMulti.size >= 2) {
    edit = `<span class="sb-draw">${zoneMulti.size} formes sélectionnées</span>
      <button class="btn sm gold" data-act="shapes-merge" title="Une seule zone (et un seul contenu) faite de ces formes collées : leurs calques suivent">⧉ Fusionner en une forme</button><button class="btn sm" data-act="shapes-unsel">Désélectionner</button>`;
  } else if (z) {
    edit = `<input type="text" class="sb-name" data-zf="name" value="${esc(z.name)}" title="Nom de la forme">
      <select data-zf="shape" title="Forme">${M.shapeOptions(z).map(([v, t]) => `<option value="${v}"${(z.shape || 'rect') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      ${z.quad ? '' : `<label>Rotation <input type="number" data-zf="rot" step="5" min="-180" max="180" value="${Math.round(z.src.rot || 0)}" title="Ou tire la poignée ronde au-dessus de la forme"> °</label>`}
      <button class="btn sm${z.quad ? ' on' : ''}" data-act="shape-quad" title="${z.quad ? 'Revenir à un rectangle (sa boîte englobante)' : 'Chaque coin se déplace seul : écran en biais, trapèze, perspective. L\'image se déforme avec.'}">⬚ Coins libres</button>
      <label class="chk" title="La forme cache ce qui est derrière elle (fond, autres calques)"><input type="checkbox" data-zf="opaque"${zoneLayers(z.id).some(l => l.opaque) ? ' checked' : ''}> Fond noir</label>
      ${z.shape === 'libre' && z.extra?.length ? `<button class="btn sm" data-act="shape-split" title="Défait la fusion : chaque morceau redevient une forme à part">⤮ Séparer (${z.extra.length + 1})</button>` : ''}
      <button class="btn sm danger" data-act="shape-del">Supprimer la forme</button>
      <span class="sb-hint sb-tip" title="Maj+clic sur une autre forme = sélection multiple, pour les fusionner en une seule zone. Forme dessinée : tire ses points (ronds dorés), le petit rond au milieu d'un côté ajoute un point, Alt+clic sur un point l'enlève.">ⓘ</span>`;
  }
  for (const bar of $$('[data-shapebar]')) {
    const map = bar.dataset.shapebar === 'map';
    bar.innerHTML = `<b class="sb-t">Formes</b>${add}
    ${map ? '' : `<label class="chk" title="Affiche ou masque les contours des formes sur l'écran de la régie (ils ne partent jamais vers le mur)"><input type="checkbox" id="shapes-on"${shapesOn ? ' checked' : ''}> Contours</label>`}
    <label class="chk" title="Aimant : en déplaçant ou en étirant une forme, ses bords se collent aux bords de l'image et des autres formes ; la rotation se cale par 15°"><input type="checkbox" class="shapes-snap"${snapOn ? ' checked' : ''}> Aimant</label>
    <span class="sb-sep"></span>${edit}`;
  }
}
function placeShapes() {
  const host = shapeHost();
  if (!host || !shapesOn || tab !== 'regie') return false;
  const sv = host.querySelector('.mon-ov'), hr = host.getBoundingClientRect(), cr = host.querySelector('canvas').getBoundingClientRect();
  const box = [cr.left - hr.left - host.clientLeft, cr.top - hr.top - host.clientTop, cr.width, cr.height].map(Math.round).join(',');
  if (box === ovBox) return false;
  ovBox = box;
  const [l, t, w, h] = box.split(',');
  Object.assign(sv.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
  return true;
}
function renderShapes() {
  for (const sv of $$('.mon-ov')) { sv.innerHTML = ''; sv.style.display = 'none'; }
  const host = shapeHost();
  if (!host || !shapesOn || tab !== 'regie') return;
  const sv = host.querySelector('.mon-ov'), { comp } = show;
  sv.style.display = ''; ovBox = ''; placeShapes();
  sv.setAttribute('viewBox', `0 0 ${comp.w} ${comp.h}`);
  sv.setAttribute('preserveAspectRatio', 'none');
  const u = comp.w / Math.max(1, sv.getBoundingClientRect().width);
  let h = '';
  show.slices.forEach((z, i) => {
    if (zoneIsFull(z)) return;
    const c = ZCOLORS[i % ZCOLORS.length], on = z.id === zoneSel, multi = zoneMulti.has(z.id), s = z.src;
    if (M.zoneQuad(z)) {                                     // coins libres : contour déformé + un rond doré par coin
      const q = z.quad, polys = zoneWorldPolys(z).map(g => `<polygon class="zo${on ? ' sel' : ''}${multi ? ' multi' : ''}" data-zone="${z.id}" points="${g.map(p => p.join(',')).join(' ')}" stroke="${c}"/>`).join('');
      h += `<g>${on ? `<polygon class="zo-box" points="${q.map(p => p.join(',')).join(' ')}"/>` : ''}${polys}
        <text class="zo-l" x="${s.x + s.w / 2}" y="${s.y + s.h + 16 * u}" text-anchor="middle" font-size="${12 * u}" fill="${c}">${esc(z.name)}</text>
        ${on ? q.map((p, k) => `<circle class="zo-v" data-zone="${z.id}" data-q="${k}" cx="${p[0]}" cy="${p[1]}" r="${6 * u}"><title>Tirer ce coin</title></circle>`).join('') : ''}</g>`;
      return;
    }
    const groups = localGroups(z);
    const polys = groups.map(g => `<polygon class="zo${on ? ' sel' : ''}${multi ? ' multi' : ''}" data-zone="${z.id}" points="${g.map(p => p.join(',')).join(' ')}" stroke="${c}"/>`).join('');
    const verts = on && z.shape === 'libre' ? groups.map((g, pg) => g.map((q, v) => { const n = g[(v + 1) % g.length]; return `<circle class="zo-m" data-zone="${z.id}" data-pg="${pg}" data-m="${v}" cx="${(q[0] + n[0]) / 2}" cy="${(q[1] + n[1]) / 2}" r="${3.5 * u}"><title>Ajouter un point ici</title></circle><circle class="zo-v" data-zone="${z.id}" data-pg="${pg}" data-v="${v}" cx="${q[0]}" cy="${q[1]}" r="${4.5 * u}"><title>Déplacer ce point (Alt+clic : l'enlever)</title></circle>`; }).join('')).join('') : '';
    h += `<g${s.rot ? ` transform="rotate(${s.rot} ${s.x + s.w / 2} ${s.y + s.h / 2})"` : ''}>
      ${on ? `<rect class="zo-box" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"/>` : ''}
      ${polys}${verts}
      <text class="zo-l" x="${s.x + s.w / 2}" y="${s.y + s.h + 16 * u}" text-anchor="middle" font-size="${12 * u}" fill="${c}">${esc(z.name)}</text>
      ${on ? [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]].map((p, k) => `<circle class="zo-h" data-zone="${z.id}" data-h="${k}" cx="${p[0]}" cy="${p[1]}" r="${6 * u}"/>`).join('') : ''}
      ${on ? `<line class="zo-rl" x1="${s.x + s.w / 2}" y1="${s.y}" x2="${s.x + s.w / 2}" y2="${s.y - 26 * u}"/><circle class="zo-r" data-zone="${z.id}" data-r="1" cx="${s.x + s.w / 2}" cy="${s.y - 26 * u}" r="${7 * u}"><title>Tourner la forme (Aimant : par 15°)</title></circle>` : ''}</g>`;
  });
  sv.innerHTML = h;
  if (drawing) renderDraw();
}
function bindShapes() {
  const mon = $('#monitor');
  const pt = (e, sv) => { const r = sv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * show.comp.w, (e.clientY - r.top) / r.height * show.comp.h]; };
  mon.addEventListener('pointerdown', e => {
    if (drawing) return;
    const el = e.target.closest?.('[data-zone]'), z = el && zoneById(el.dataset.zone);
    if (!z) return;
    e.preventDefault();
    const sv = el.closest('svg'), h = el.dataset.h != null ? +el.dataset.h : null, start = pt(e, sv);
    if (e.shiftKey && el.classList.contains('zo')) return toggleMulti(z.id);           // Maj+clic : sélection multiple (fusion)
    if (M.zoneQuad(z)) {                                                                // coins libres : un coin, ou toute la forme
      if (zoneSel !== z.id) selectZone(z.id);
      zDrag = { sv, start, src: { ...z.src }, quad: z.quad.map(p => [...p]), qk: el.dataset.q != null ? +el.dataset.q : null };
      return;
    }
    if (el.dataset.v != null || el.dataset.m != null) {                                 // sommet d'une forme dessinée
      if (zoneSel !== z.id) selectZone(z.id);
      const pg = +el.dataset.pg;
      if (el.dataset.v != null && e.altKey) { if (deleteVertex(z, pg, +el.dataset.v)) { commit(); renderShapes(); mapping?.refresh(true); } return; }
      const v = el.dataset.v != null ? +el.dataset.v : insertVertex(z, pg, +el.dataset.m);
      if (v == null) return;
      zDrag = { sv, start, src: { ...z.src }, vert: { pg, v } }; commit(); renderShapes(); return;
    }
    selectZone(z.id);
    zDrag = { sv, h, start, src: { ...z.src }, rot: el.dataset.r != null };
  });
  addEventListener('pointermove', e => {
    const z = zDrag && zoneById(zoneSel);
    if (!z) return;
    const [px, py] = pt(e, zDrag.sv), dx = Math.round(px - zDrag.start[0]), dy = Math.round(py - zDrag.start[1]), o = zDrag.src, { comp } = show;
    const tol = Math.round(comp.w / 110);                                  // aimant : ~1 % de la largeur de l'image
    if (zDrag.quad) {
      if (zDrag.qk != null) quadCorner(z, zDrag.quad, zDrag.qk, zDrag.quad[zDrag.qk][0] + dx, zDrag.quad[zDrag.qk][1] + dy);
      else quadMove(z, zDrag.quad, o, dx, dy);
      commit(); renderShapes(); mapping?.refresh(false); return;
    }
    if (zDrag.vert) { setVertex(z, zDrag.vert.pg, zDrag.vert.v, [px, py]); commit(); renderShapes(); mapping?.refresh(false); return; }
    if (zDrag.rot) {                                                       // poignée de rotation : angle entre le centre et la souris
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      let a = Math.atan2(py - cy, px - cx) * 180 / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      if (snapOn) a = Math.round(a / 15) * 15;
      z.src.rot = Math.round(a);
      const f = $('#shapebar [data-zf="rot"]'); if (f) f.value = z.src.rot;
      commit(); renderShapes(); return;
    }
    if (zDrag.h == null) {
      let x = o.x + dx, y = o.y + dy;
      if (snapOn) {
        const cx = snapCands('x', z), cy = snapCands('y', z);
        const sx = [x, x + o.w / 2, x + o.w].map((v, i) => [snapTo(v, cx, tol) - v, i]).filter(([d]) => d !== 0).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
        const sy = [y, y + o.h / 2, y + o.h].map((v, i) => [snapTo(v, cy, tol) - v, i]).filter(([d]) => d !== 0).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
        if (sx) x += sx[0]; if (sy) y += sy[0];
      }
      z.src = { ...o, x, y };
    } else {
      const r = -(o.rot || 0) * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
      const lx = Math.round(cr * dx - sr * dy), ly = Math.round(sr * dx + cr * dy);        // déplacement vu dans le repère de la forme
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (zDrag.h === 0 || zDrag.h === 3) x0 = M.clamp(x0 + lx, 0, x1 - 8); else x1 = M.clamp(x1 + lx, x0 + 8, comp.w);
      if (zDrag.h === 0 || zDrag.h === 1) y0 = M.clamp(y0 + ly, 0, y1 - 8); else y1 = M.clamp(y1 + ly, y0 + 8, comp.h);
      if (snapOn && !o.rot) {                                              // le bord qu'on tire se colle aux bords voisins
        const cx = snapCands('x', z), cy = snapCands('y', z);
        if (zDrag.h === 0 || zDrag.h === 3) x0 = Math.min(snapTo(x0, cx, tol), x1 - 8); else x1 = Math.max(snapTo(x1, cx, tol), x0 + 8);
        if (zDrag.h === 0 || zDrag.h === 1) y0 = Math.min(snapTo(y0, cy, tol), y1 - 8); else y1 = Math.max(snapTo(y1, cy, tol), y0 + 8);
      }
      if (z.shape === 'carre') {                                           // carré : un seul côté, celui qu'on tire le plus, ancré au coin opposé
        let side = Math.max(8, Math.abs(lx) >= Math.abs(ly) ? x1 - x0 : y1 - y0);
        const ax = zDrag.h === 0 || zDrag.h === 3 ? x1 : x0, ay = zDrag.h === 0 || zDrag.h === 1 ? y1 : y0;   // coin fixe
        side = Math.min(side, zDrag.h === 0 || zDrag.h === 3 ? ax : comp.w - ax, zDrag.h === 0 || zDrag.h === 1 ? ay : comp.h - ay);
        if (zDrag.h === 0 || zDrag.h === 3) x0 = ax - side; else x1 = ax + side;
        if (zDrag.h === 0 || zDrag.h === 1) y0 = ay - side; else y1 = ay + side;
      }
      z.src = { ...o, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    clampZone(z); commit(); renderShapes(); mapping?.refresh(false);
  });
  addEventListener('pointerup', () => { zDrag = null; });
  addEventListener('resize', () => renderShapes());
  const droppable = e => ['application/x-led-media', 'application/x-led-ppt', 'application/x-led-doc', 'application/x-led-cam', 'application/x-led-pool', 'Files'].some(t => e.dataTransfer.types.includes(t));
  mon.addEventListener('dragover', e => {
    const el = e.target.closest?.('polygon[data-zone]');
    if (!el || !droppable(e)) return;
    e.preventDefault(); el.classList.add('over');
  });
  mon.addEventListener('dragleave', e => e.target.closest?.('polygon[data-zone]')?.classList.remove('over'));
  mon.addEventListener('drop', async e => {
    const el = e.target.closest?.('polygon[data-zone]'), z = el && zoneById(el.dataset.zone);
    if (!z) return;
    e.preventDefault();
    const docDrop = docList.find(d => d.id === e.dataTransfer.getData('application/x-led-doc'));
    if (docDrop) return dropOnZone(z, docClip(docDrop));
    const pptName = e.dataTransfer.getData('application/x-led-ppt');
    if (pptName) { const c = pptClip(pptName); dropOnZone(z, c); if (show.clips[c.id]) pptCmd(c, 'open'); return; }
    const camId = e.dataTransfer.getData('application/x-led-cam');
    if (camId) return dropOnZone(z, camClip(camId));
    const poolId = e.dataTransfer.getData('application/x-led-pool');
    if (poolId && show.clips[poolId]) return dropOnZone(z, cloneClip(show.clips[poolId]));
    const name = e.dataTransfer.getData('application/x-led-media'), list = e.dataTransfer.getData('application/x-led-media-list');
    let names = []; try { names = list ? JSON.parse(list) : []; } catch { names = []; }
    if (names.length > 1) return dropOnZone(z, slideshowFromMedia(mediaByNames(names)));      // plusieurs fichiers : un diaporama
    const m = name ? media.find(x => x.name === name) : (await uploadFiles(e.dataTransfer.files))[0];
    if (m) dropOnZone(z, clipFromMedia(m));
  });
  const inBar = e => e.target.closest?.('[data-shapebar]');
  document.addEventListener('click', e => {
    if (!inBar(e)) return;
    const k = e.target.closest('[data-shape-add]')?.dataset.shapeAdd, act = e.target.closest('[data-act]')?.dataset.act;
    if (k) { cancelDraw(); return addShape(k); }
    if (act === 'shape-draw') return drawing ? cancelDraw() : startDraw();
    if (act === 'draw-done') return finishDraw();
    if (act === 'draw-cancel') return cancelDraw();
    if (act === 'shape-quad') return toggleQuad(zoneById(zoneSel));
    if (act === 'shapes-merge') return mergeShapes();
    if (act === 'shape-split') return splitShape();
    if (act === 'shapes-unsel') { zoneMulti.clear(); renderShapeBar(); renderShapes(); mapping?.refresh(false); return; }
    if (act === 'shape-del') delShape();
  });
  document.addEventListener('input', e => {
    const z = zoneById(zoneSel);
    if (!inBar(e) || !z || e.target.dataset.zf !== 'rot' || e.target.value === '') return;
    z.src.rot = M.clamp(Math.round(+e.target.value || 0), -180, 180);
    commit(); renderShapes(); mapping?.refresh(false);
  });
  document.addEventListener('change', e => {
    if (!inBar(e)) return;
    const t = e.target, z = zoneById(zoneSel), f = t.dataset.zf;
    if (t.id === 'shapes-on') {
      shapesOn = t.checked;
      try { localStorage.setItem('regieLed.shapes', shapesOn ? '1' : '0'); } catch { /* sans gravité */ }
      return renderShapes();
    }
    if (t.classList.contains('shapes-snap')) { snapOn = t.checked; try { localStorage.setItem('regieLed.snap', snapOn ? '1' : '0'); } catch { /* sans gravité */ } return renderShapeBar(); }
    if (!z || !f) return;
    if (f === 'name') {
      const old = z.name, nv = t.value.trim() || old;
      for (const l of zoneLayers(z.id)) if (l.name === old) l.name = nv;
      z.name = nv; renderGrid(); renderCues();
    }
    if (f === 'shape') { z.shape = t.value; if (t.value === 'carre') squarify(z); }
    if (f === 'opaque') for (const l of zoneLayers(z.id)) l.opaque = t.checked;
    commit(); renderShapeBar(); renderShapes(); mapping?.refresh(true);
    if (sel?.kind === 'layer') renderInspector();
  });
  bindDraw();
}

/* ---------- onglets, réglages ---------- */
function setTab(t) {
  if (drawing && t !== tab) cancelDraw();
  tab = t;
  for (const b of $$('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === t);
  for (const v of ['regie', 'mapping', 'reglages', 'outputs']) $('#view-' + v).hidden = v !== t;
  if (t === 'outputs') renderOutputsView();
  if (t === 'mapping') mapping.render();
  if (t === 'reglages') { renderSettings(); loadStorage(); }
  if (t === 'regie') { if (zoneSel && !zoneById(zoneSel)) zoneSel = null; renderGrid(); renderShapeBar(); renderShapes(); }
}
function renderSettings() {
  const scr = screens ? screens.screens.map(s => `<option value="${esc(s.label)}"${localStorage.getItem('regieLed.screen') === s.label ? ' selected' : ''}>${esc(s.label || 'Écran')} — ${s.width}×${s.height}${s === screens.currentScreen ? ' (celui-ci)' : ''}</option>`).join('') : '';
  $('#view-reglages').innerHTML = `<div class="settings">
    <div class="panel"><div class="panel-h"><h3>Show</h3></div><div class="fields">
      <label class="f"><span>Nom du show</span><input type="text" id="set-name" value="${esc(show.name)}"></label>
      <label class="f"><span>Colonnes de la grille</span><input type="number" id="set-cols" min="1" max="32" value="${show.cols}"></label>
      <label class="chk" title="Activé : un clic prépare le clip dans l'écran Préparation, « Envoyer à la sortie » (Entrée) le met sur le mur. Désactivé : un clic part directement à la sortie."><input type="checkbox" id="set-prep"${prepOn ? ' checked' : ''}> Mode Préparation (deux écrans : Préparation puis Sortie)</label>
      <label class="chk" title="Affiche sur le mur une mire avec le nom de chaque zone, pour régler le mapping (aussi dans l'onglet Mapping)"><input type="checkbox" id="set-mire"${live.test ? ' checked' : ''}> Mire de réglage sur la sortie</label>
      <div class="row"><button class="btn gold" data-act="saveas" title="Enregistre une copie du show dans un fichier, là où tu veux (dossier, clé USB…)">💾 Enregistrer sous…</button><button class="btn" data-act="import" title="Ouvre un show enregistré (.json) : il remplace celui-ci">📂 Ouvrir un show…</button><button class="btn danger" data-act="new">Nouveau show vide</button></div>
      <p class="note">Le show en cours est enregistré automatiquement sur cet ordinateur (dossier <code>data</code>, avec un historique dans <code>data/backups</code>). « Enregistrer sous… » en fait une copie nommée que tu ranges où tu veux ; « Ouvrir » la recharge. Les médias restent dans le dossier <code>media</code> : pour changer d'ordinateur, copie le fichier du show et ce dossier.</p></div></div>
    <div class="panel"><div class="panel-h"><h3>Son</h3></div><div class="fields">
      <label class="f"><span>Sortie du son</span><select id="set-audio-out"><option value="">Sortie son du Mac (réglage système)</option>${audioOutDevs.map(d => `<option value="${esc(d.deviceId)}"${show.audioOut === d.deviceId ? ' selected' : ''}>${esc(d.label || 'Sortie audio')}</option>`).join('')}${show.audioOut && !audioOutDevs.some(d => d.deviceId === show.audioOut) ? `<option value="${esc(show.audioOut)}" selected>${esc(show.audioOutLabel || 'Sortie enregistrée')}</option>` : ''}</select></label>
      <div class="row"><button class="btn" data-act="audio-devs">Détecter les sorties son</button></div>
      <p class="note">Le son des vidéos et des sources en direct sort par la <b>fenêtre de sortie</b>, vers le périphérique choisi ici : prise casque / interface audio reliée à la console, ou la TV par HDMI. Le volume se règle clip par clip. Si le son reste bloqué, clique une fois dans la fenêtre de sortie.</p></div></div>
    <div class="panel"><div class="panel-h"><h3>Sorties (écrans)</h3><button class="btn sm gold" data-act="out-add" title="Un écran de plus : retour conférenciers, autre salle…">＋ Sortie</button></div><div class="fields">
      ${screens ? `<label class="f"><span>Ouvrir la LED sur</span><select id="set-screen"><option value="">Automatique (2e écran)</option>${scr}</select></label>` : '<p class="note">Autorise la détection des écrans pour que chaque sortie s\'ouvre directement sur le bon écran.</p>'}
      <div class="row"><button class="btn" data-act="screens">Détecter les écrans</button></div>
      ${outputsPanel()}
      <p class="note">Branchement : une sortie HDMI de l'ordinateur par contenu différent (LED, retour conférenciers, autre salle), chacune en « bureau étendu » (pas en recopie). Les écrans qui montrent la même image se branchent sur un splitter HDMI. La sortie principale porte le mapping (onglet Mapping) et le son ; les autres montrent toute la composition ou une zone en plein cadre, sans leurs calques masqués (réglage « Visible sur » de chaque calque).</p></div></div>
    <div class="panel"><div class="panel-h"><h3>Raccourcis clavier</h3><button class="btn sm" data-act="kbd-show" title="Le clavier entier : touches déjà utilisées en vert, survol = ce qu'elles font">⌨ Voir le clavier</button></div><div class="fields keys">
      <div><kbd>Espace</kbd> Séquence suivante</div><div><kbd>Entrée</kbd> Envoyer la préparation à la sortie</div><div><kbd>1</kbd>…<kbd>9</kbd> Afficher une colonne (<kbd>Maj</kbd> : directement à la sortie)</div><div><kbd>B</kbd> Écran noir</div>
      <div><kbd>T</kbd> Taper le tempo</div><div><kbd>←</kbd> <kbd>→</kbd> PowerPoint en direct : précédent / suivant</div><div><kbd>Échap</kbd> Désélectionner</div><div><kbd>F</kbd> Plein écran (dans la fenêtre de sortie)</div>
      <div><kbd>←↑↓→</kbd> Mapping : déplacer la zone de 1 px (<kbd>Maj</kbd> = 10 px)</div>
      <div id="keys-custom">${keysPanel()}</div></div></div>
    <div class="panel"><div class="panel-h"><h3>Espace disque</h3><button class="btn sm" data-act="storage-refresh" title="Recalculer">↻</button></div><div class="fields" id="storage-panel"><p class="note">Calcul en cours…</p></div></div>
    <div class="panel"><div class="panel-h"><h3>Formats conseillés</h3></div><div class="fields">
      <p class="note">Vidéos : <b>MP4 (H.264)</b>, 1080p, 25 ou 30 i/s — c'est le format le plus fluide. MOV et WebM fonctionnent aussi ; ProRes et HAP ne sont pas lus par le navigateur. Documents : <b>PowerPoint, Word, Excel et PDF</b> sont convertis en images fixes, une par diapositive ou par page (sans animations). Images : PNG (la transparence est conservée, idéal pour les logos), JPG, WebP, SVG. Captures (« ⏺ Capturer une source ») : MP4 H.264 quand Chrome sait l'écrire, sinon WebM ; photos en JPG.</p></div></div>
  </div>`;
  if (storageInfo) renderStorage();                      // le panneau Espace disque garde son contenu entre deux affichages
}
/* ---------- onglet Outputs : ce qui sort sur chaque écran, en direct ---------- */
/** Nouvelle sortie (Réglages ou onglet Outputs). */
async function addOutputAsk() {
  if (show.outputs.length >= 6) return toast('6 sorties maximum.', 'err');
  const n = await askText('Nom de la sortie', show.outputs.length === 1 ? 'Retour conférenciers' : 'Sortie ' + (show.outputs.length + 1), { max: 40, ok: 'Créer', hint: 'Par exemple : Retour conférenciers, Salle B, Hall d\'accueil.' });
  if (n === null) return;
  show.outputs.push(M.newOutput(show, n.trim().slice(0, 40) || undefined)); commit(); renderGrid(); renderInspector(); updatePlaying();
  if (tab === 'reglages') renderSettings(); if (tab === 'outputs') renderOutputsView();
  toast('Sortie créée. Choisis ce qu\'elle montre et les calques visibles, puis « Ouvrir » sur le bon écran.');
}
function outputStatus(o) {
  if (!outIsOpen(o.id)) return 'Fenêtre fermée';
  const inf = o.id === 'main' ? outInfo : outInfos[o.id];
  return `${inf.w}×${inf.h} · ${inf.fps} i/s${inf.fs ? ' · plein écran' : ' · fenêtre'}`;
}
/* ---------- écran retour conférenciers (sortie en mode « retour ») ---------- */
/** Ce que peut montrer une sortie secondaire (onglet Outputs et Réglages). */
const modeOptions = (o, zones) => `<option value="comp"${o.mode === 'comp' ? ' selected' : ''}>Toute la composition</option>`
  + `<option value="retour"${o.mode === 'retour' ? ' selected' : ''}>Retour conférenciers : fichiers « R » en entier + chrono</option>`
  + zones.map(z => `<option value="zone:${esc(z.id)}"${o.mode === 'zone' && o.zoneId === z.id ? ' selected' : ''}>Zone « ${esc(z.name)} » en plein cadre</option>`).join('');
function setOutMode(o, v) {
  if (v.startsWith('zone:')) { o.mode = 'zone'; o.zoneId = v.slice(5); } else { o.mode = v === 'retour' ? 'retour' : 'comp'; o.zoneId = ''; }
}
/** Réglages propres à un écran retour : affiche de repos (fichier de la médiathèque) et place du chrono (cadre à glisser sur l'aperçu). */
function retourFields(o) {
  const files = media.filter(m => m.type === 'image' || m.type === 'video'), cur = o.idle?.name || '';
  return `<div class="oc-f"><label class="oc-scr" title="Ce que voit le conférencier quand aucun fichier marqué « R » ne passe">Affiche de repos <select data-out-f="idle" data-out="${esc(o.id)}">
      <option value="">Écran noir</option>${files.map(m => `<option value="${esc(m.name)}"${m.name === cur ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label></div>
    <p class="note oc-note">Coche <b>« Aussi sur l'écran retour »</b> dans les réglages d'un clip (badge <b>R</b> dans la grille) : PowerPoint, affiches,
      chrono… Le dernier lancé s'affiche ici <b>en entier</b>, jamais découpé par les zones ; un compte à rebours ou une horloge « R » se pose
      par-dessus, dans le cadre <b>⏱</b> à glisser sur l'aperçu (coin en bas à droite pour sa taille).</p>`;
}
const timerBox = o => { const t = o.timer || { x: 0.68, y: 0.76, w: 0.3, h: 0.2 }; return `<div class="oc-timer" data-timer="${esc(o.id)}" style="left:${t.x * 100}%;top:${t.y * 100}%;width:${t.w * 100}%;height:${t.h * 100}%" title="Place du chrono sur l'écran retour : glisse pour le déplacer, tire le coin pour le redimensionner"><span>⏱ Chrono</span><i class="oc-timer-rs"></i></div>`; };
function renderOutputsView() {
  const v = $('#view-outputs'); if (!v) return;
  const layers = [...M.layersFor(show, live)].reverse(), zones = show.slices.filter(z => !zoneIsFull(z));
  v.innerHTML = `<div class="oc-top"><h3>Outputs</h3><span class="note">Ce qui sort sur chaque écran, en direct. Les calques décochés n'apparaissent pas sur cette sortie.</span><span class="spacer"></span><button class="btn sm gold" data-act="out-add">＋ Sortie</button></div>
    <div class="oc-grid">${show.outputs.map(o => {
      const main = o.id === 'main', on = outIsOpen(o.id);
      return `<div class="oc${main ? ' main' : ''}${on ? ' on' : ''}" data-out="${esc(o.id)}">
        <div class="oc-h"><span class="out-dot"></span><input type="text" data-out-f="name" data-out="${esc(o.id)}" value="${esc(o.name)}" title="Nom de la sortie">
          <span class="oc-badge">${main ? 'MASTER · spectateurs' : 'Sortie ' + (show.outputs.indexOf(o) + 1)}</span>
          <button class="btn sm${on ? '' : ' gold'}" data-act="out-open" data-out="${esc(o.id)}">${on ? 'Rouvrir' : 'Ouvrir'}</button>${main ? '' : `<button class="btn sm danger oc-del" data-act="out-del" data-out="${esc(o.id)}" title="Supprimer cette sortie (sa fenêtre se ferme)">✕</button>`}</div>
        <div class="oc-screen"><canvas data-outcv="${esc(o.id)}"></canvas>${o.mode === 'retour' ? timerBox(o) : ''}<span class="oc-st" data-outst="${esc(o.id)}">${esc(outputStatus(o))}</span></div>
        <div class="oc-f">${screenSelect(o)}</div>
        <div class="oc-f">${main ? '<span class="note">Toute la composition, avec le mapping (onglet Mapping) et le son.</span>' : `<select data-out-f="mode" data-out="${esc(o.id)}" title="Ce que montre cette sortie">${modeOptions(o, zones)}</select>`}</div>
        ${o.mode === 'retour' ? retourFields(o) : `<div class="oc-layers">${layers.map(l => `<label class="chip${o.hidden.includes(l.id) ? '' : ' on'}" title="${o.hidden.includes(l.id) ? 'Masqué sur cette sortie : clic pour l\'afficher' : 'Visible sur cette sortie : clic pour le masquer'}"><input type="checkbox" data-outlayer="${esc(o.id)}|${esc(l.id)}"${o.hidden.includes(l.id) ? '' : ' checked'}>${esc(l.name)}</label>`).join('')}</div>`}
      </div>`;
    }).join('')}</div>`;
}
function bindOutputsView() {
  const v = $('#view-outputs');
  // Cadre du chrono d'un écran retour : glisser = déplacer, coin = redimensionner. L'écran retour suit en direct.
  v.addEventListener('pointerdown', e => {
    const box = e.target.closest('.oc-timer'); if (!box) return;
    const o = M.outputById(show, box.dataset.timer), scr = box.closest('.oc-screen'); if (!o || !scr) return;
    e.preventDefault(); box.setPointerCapture(e.pointerId);
    const R = scr.getBoundingClientRect(), t0 = { ...(o.timer || { x: 0.68, y: 0.76, w: 0.3, h: 0.2 }) }, x0 = e.clientX, y0 = e.clientY, resize = !!e.target.closest('.oc-timer-rs');
    const cl = (v1, lo, hi) => Math.min(hi, Math.max(lo, v1));
    const move = ev => {
      const dx = (ev.clientX - x0) / R.width, dy = (ev.clientY - y0) / R.height, t = { ...t0 };
      if (resize) { t.w = cl(t0.w + dx, 0.05, 1 - t0.x); t.h = cl(t0.h + dy, 0.05, 1 - t0.y); }
      else { t.x = cl(t0.x + dx, 0, 1 - t0.w); t.y = cl(t0.y + dy, 0, 1 - t0.h); }
      o.timer = t;
      Object.assign(box.style, { left: t.x * 100 + '%', top: t.y * 100 + '%', width: t.w * 100 + '%', height: t.h * 100 + '%' });
      commit(false);
    };
    const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); commit(); };
    box.addEventListener('pointermove', move); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  });
  v.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act, id = e.target.closest('[data-out]')?.dataset.out;
    if (act === 'out-add') return addOutputAsk();
    if (act === 'out-open' && id) return openOutput(id);
    if (act === 'out-del' && id) return deleteOutput(id);
    if (act === 'screens') return loadScreens(true).then(() => { renderOutputsView(); if (!screens) toast('Détection des écrans indisponible ou refusée sur ce navigateur.', 'err'); });
  });
  v.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.outscreen) return setOutputScreen(t.dataset.outscreen, t.value);
    if (t.dataset.outlayer) {
      const [oid, lid] = t.dataset.outlayer.split('|'), o = M.outputById(show, oid);
      o.hidden = o.hidden.filter(x => x !== lid); if (!t.checked) o.hidden.push(lid);
      t.closest('.chip')?.classList.toggle('on', t.checked);
      commit(); renderGrid(); return;
    }
    const f = t.dataset.outF, o = f && M.outputById(show, t.dataset.out);
    if (!o) return;
    if (f === 'name') { o.name = t.value.trim().slice(0, 40) || o.name; t.value = o.name; renderGrid(); updatePlaying(); }
    if (f === 'mode') { setOutMode(o, t.value); commit(); return renderOutputsView(); }
    if (f === 'idle') { const m = mediaAll.find(x => x.name === t.value); o.idle = m ? { src: m.url, type: m.type, name: m.name } : null; }
    commit();
  });
}
/** Dessine chaque sortie dans sa vignette (avec ses calques masqués), à partir du moteur de la régie. */
function drawOutputsView() {
  if (!eng) return;
  for (const o of show.outputs) {
    const cv = $(`#view-outputs canvas[data-outcv="${CSS.escape(o.id)}"]`); if (!cv) continue;
    eng.hideLayers = o.hidden.length && o.mode !== 'retour' ? new Set(o.hidden) : null;
    eng.frame();
    if (o.id === 'main') drawView('output', cv);
    else if (o.mode === 'retour') drawView('retour', cv, eng, null, o);
    else { const zone = o.mode === 'zone' && show.slices.find(z => z.id === o.zoneId); drawView(zone ? 'zone' : 'comp', cv, eng, zone || null); }
  }
  eng.hideLayers = null;
}
/* ---------- écran de chaque sortie : application de bureau (écrans vus par le Mac / PC) ou navigateur (détection des écrans) ---------- */
function screenSelect(o) {
  const main = o.id === 'main', D = window.regieDesktop;
  if (D?.displays) {
    let info = { list: [], choice: {} }; try { info = D.displays(); } catch { /* ancienne version */ }
    const cur = String(info.choice?.[o.id] ?? 'auto');
    return `<label class="oc-scr" title="Écran sur lequel cette sortie s'affiche (une sortie ouverte y est déplacée tout de suite)">Écran <select data-outscreen="${esc(o.id)}">
      <option value="auto"${cur === 'auto' ? ' selected' : ''}>${main ? 'Automatique (premier écran externe)' : 'Choisir à l\'ouverture'}</option>
      ${info.list.map(d => `<option value="${d.id}"${cur === String(d.id) ? ' selected' : ''}>${esc(d.label)}${d.regie ? ' — écran de la régie' : ''}</option>`).join('')}
      <option value="window"${cur === 'window' ? ' selected' : ''}>Fenêtre simple (pas de plein écran)</option></select></label>`;
  }
  if (!screens) return `<label class="oc-scr">Écran <button class="btn sm" data-act="screens" title="Autoriser la détection des écrans pour choisir celui de chaque sortie">Détecter les écrans</button></label>`;
  const cur = main ? (localStorage.getItem('regieLed.screen') || '') : (o.screen || '');
  return `<label class="oc-scr" title="Écran sur lequel cette sortie s'ouvre">Écran <select data-outscreen="${esc(o.id)}"><option value="">${main ? 'Automatique (2e écran)' : 'Choisir à la main'}</option>
    ${screens.screens.map(sc => `<option value="${esc(sc.label)}"${cur === sc.label ? ' selected' : ''}>${esc(sc.label || 'Écran')} — ${sc.width}×${sc.height}${sc === screens.currentScreen ? ' (celui-ci)' : ''}</option>`).join('')}</select></label>`;
}
/** Change l'écran d'une sortie ; si elle est ouverte, elle y est déplacée. */
function setOutputScreen(id, v) {
  const o = M.outputById(show, id), D = window.regieDesktop;
  if (D?.setOutputDisplay) { D.setOutputDisplay(o.id, v); toast(`« ${o.name} » : ${v === 'auto' ? 'écran automatique' : v === 'window' ? 'fenêtre simple' : 'écran choisi'}${outIsOpen(o.id) ? ', déplacée.' : ' (à l\'ouverture).'}`); return; }
  if (o.id === 'main') { if (v) localStorage.setItem('regieLed.screen', v); else localStorage.removeItem('regieLed.screen'); }
  else { o.screen = v; commit(); }
  if (outIsOpen(o.id)) {                                       // navigateur : on déplace la fenêtre déjà ouverte
    const s2 = o.id === 'main' ? extScreen() : screenFor(o);
    try { const w = window.open('', o.id === 'main' ? 'regie-led-sortie' : 'regie-led-sortie-' + o.id); if (w && w !== window && s2) { w.moveTo(s2.availLeft, s2.availTop); w.resizeTo(s2.availWidth, s2.availHeight); } } catch { /* déplacement refusé */ }
    toast(`« ${o.name} » déplacée : clique dedans pour le plein écran.`);
  }
}
window.regieDesktop?.onDisplaysChanged?.(() => { if (tab === 'outputs') renderOutputsView(); if (tab === 'reglages') renderSettings(); });
/** Liste des sorties dans Réglages : nom, ce qu'elle montre, écran, ouvrir, supprimer. */
function outputsPanel() {
  const zones = show.slices.filter(z => !zoneIsFull(z));
  const scrOpts = o => (screens ? `<select data-out-f="screen" data-out="${esc(o.id)}" title="Écran sur lequel cette sortie s'ouvre"><option value="">Choisir à la main</option>${screens.screens.map(s => `<option value="${esc(s.label)}"${o.screen === s.label ? ' selected' : ''}>${esc(s.label || 'Écran')} — ${s.width}×${s.height}${s === screens.currentScreen ? ' (celui-ci)' : ''}</option>`).join('')}</select>` : '');
  return `<div class="out-list">${show.outputs.map((o, i) => {
    const main = o.id === 'main', on = outIsOpen(o.id), inf = main ? outInfo : outInfos[o.id];
    return `<div class="out-row${on ? ' on' : ''}" data-out="${esc(o.id)}">
      <span class="out-dot" title="${on ? 'Ouverte' : 'Fermée'}"></span>
      <input type="text" data-out-f="name" data-out="${esc(o.id)}" value="${esc(o.name)}" title="Nom de la sortie">
      ${main ? '<span class="out-what">LED : mapping (onglet Mapping) + son</span>' : `<select data-out-f="mode" data-out="${esc(o.id)}" title="Ce que montre cette sortie">${modeOptions(o, zones)}</select>`}
      ${screenSelect(o)}
      <span class="out-st">${on ? `${inf.w}×${inf.h}${inf.fs ? '' : ' · fenêtre'}` : (o.hidden.length ? `${o.hidden.length} calque${o.hidden.length > 1 ? 's' : ''} masqué${o.hidden.length > 1 ? 's' : ''}` : '')}</span>
      <button class="btn sm${on ? '' : ' gold'}" data-act="out-open" data-out="${esc(o.id)}">${on ? 'Rouvrir' : 'Ouvrir'}</button>
      ${main ? '' : `<button class="x" data-act="out-del" data-out="${esc(o.id)}" title="Supprimer cette sortie">✕</button>`}</div>`;
  }).join('')}</div>`;
}
/* ---------- espace disque : doublons et fichiers inutilisés ---------- */
const fmtMo = n => (n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' Go' : Math.max(n ? 0.1 : 0, n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace('.', ',') + ' Mo');
/** Durées du panneau Espace disque : libres (1 à 3650 jours), mémorisées ; les valeurs habituelles sont proposées en suggestion. */
const clampDays = (v, d) => { const n = Math.round(+v); return n >= 1 ? Math.min(3650, n) : d; };
let storageInfo = null, cleanDays = clampDays(localStorage.getItem('regieLed.cleanDays'), 30);
let autoCleanDays = clampDays(localStorage.getItem('regieLed.autoCleanDays'), 90);     // durée proposée quand on coche le nettoyage automatique
const daysList = '<datalist id="days-sugg">' + [7, 15, 30, 60, 90, 180, 365].map(d => `<option value="${d}">`).join('') + '</datalist>';
async function loadStorage() {
  const el = $('#storage-panel'); if (!el) return;
  try { storageInfo = await (await fetch('/api/storage')).json(); } catch { el.innerHTML = '<p class="note">Impossible de lire l\'espace disque (serveur local injoignable).</p>'; return; }
  renderStorage();
}
function renderStorage() {
  const el = $('#storage-panel'), st = storageInfo; if (!el || !st) return;
  const all = [...st.media.map(m => ({ ...m, kind: 'Média' })), ...st.docs.map(d => ({ ...d, kind: 'Document' })), ...st.ppt.map(x => ({ ...x, kind: 'PowerPoint' }))];
  const sum = l => l.reduce((a, x) => a + x.size, 0), limit = Date.now() - cleanDays * 86400000;
  const old = all.filter(x => !x.used && x.lastUsed < limit), dupSize = st.dups.reduce((a, g) => a + g.size, 0), dupN = st.dups.reduce((a, g) => a + g.drop.length, 0);
  const day = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  el.innerHTML = `<p><b>${fmtMo(sum(all))}</b> dans le dossier de la régie — médias ${fmtMo(sum(st.media))}, documents ${fmtMo(sum(st.docs))}, PowerPoint ${fmtMo(sum(st.ppt))}.</p>
    <div class="st-row"><span>${dupN ? `<b>${dupN}</b> fichier${dupN > 1 ? 's' : ''} en double (${fmtMo(dupSize)})` : 'Aucun doublon'}</span>${dupN ? '<button class="btn sm gold" data-act="storage-dedupe">Supprimer les doublons</button>' : ''}</div>
    ${daysList}<div class="st-row"><span>Inutilisés depuis plus de <input type="number" class="st-days" id="clean-days" list="days-sugg" min="1" max="3650" step="1" value="${cleanDays}" title="Tape le nombre de jours que tu veux (1 à 3650), puis Entrée"> jours : <b>${old.length}</b> (${fmtMo(sum(old))})</span>${old.length ? '<button class="btn sm danger" data-act="storage-clean">Mettre à la corbeille</button>' : ''}</div>
    <div class="st-row st-auto"><label class="chk" title="À chaque démarrage, la régie met à la corbeille les fichiers inutilisés depuis ce nombre de jours"><input type="checkbox" id="auto-clean-on"${st.autoClean ? ' checked' : ''}> Nettoyage automatique au démarrage : inutilisés depuis</label>
      <span><input type="number" class="st-days" id="auto-clean-days" list="days-sugg" min="1" max="3650" step="1" value="${st.autoClean || autoCleanDays}"${st.autoClean ? '' : ' disabled'} title="Tape le nombre de jours que tu veux (1 à 3650), puis Entrée"> jours</span></div>
    <p class="note">« Utilisé » = dans le show en cours, ou dans un show ouvert pendant cette période (chaque show ouvert met à jour ses fichiers). Les fichiers enlevés vont dans la <b>corbeille de l'ordinateur</b> : récupérables tant qu'elle n'est pas vidée. Un fichier déjà présent n'est plus jamais copié une deuxième fois à l'import.</p>
    <details><summary>Détail (${all.length} fichiers, du plus lourd au plus léger)</summary><div class="st-list">${all.sort((a, b) => b.size - a.size).map(x => `<div class="st-item${x.used ? ' used' : ''}"><span>${esc(x.name)}</span><small>${x.kind} · ${fmtMo(x.size)} · ${x.used ? 'dans ce show' : 'utilisé le ' + day(x.lastUsed)}</small></div>`).join('')}</div></details>`;
}
async function storageAction(act) {
  if (act === 'storage-refresh') return loadStorage();
  if (act === 'storage-dedupe') {
    const r = await (await fetch('/api/storage/dedupe', { method: 'POST' })).json();
    // le show en cours pointe sur le fichier gardé (les autres shows restent valables : l'ancien nom renvoie au fichier gardé)
    const url = n => '/media/' + encodeURIComponent(n); let n = 0;
    for (const [drop, keep] of Object.entries(r.map || {})) {
      for (const c of Object.values(show.clips)) { if (c.src === url(drop)) { c.src = url(keep); n++; } for (const it of c.items || []) if (it.src === url(drop)) { it.src = url(keep); n++; } }
      if (Array.isArray(show.files)) { show.files = show.files.map(f => (f === drop ? keep : f)).filter((f, i, a) => a.indexOf(f) === i); }
    }
    if (n || Object.keys(r.map || {}).length) commit();
    await loadMedia(); renderLib(); renderGrid(); await loadStorage();
    return toast(`${Object.keys(r.map || {}).length} doublon(s) supprimé(s), ${fmtMo(r.freed || 0)} libérés.`);
  }
  if (act === 'storage-clean') {
    const dry = await (await fetch(`/api/storage/clean?days=${cleanDays}&dry=1`, { method: 'POST' })).json();
    if (!dry.files?.length) return toast('Rien à nettoyer.');
    if (!confirm(`Mettre à la corbeille ${dry.files.length} fichier(s) inutilisé(s) depuis plus de ${cleanDays} jours (${fmtMo(dry.freed)}) ?\n\n${dry.files.slice(0, 12).map(f => '• ' + f.name).join('\n')}${dry.files.length > 12 ? '\n…' : ''}\n\nIls restent récupérables dans la corbeille de l'ordinateur.`)) return;
    const r = await (await fetch(`/api/storage/clean?days=${cleanDays}`, { method: 'POST' })).json();
    await loadMedia(); renderLib(); await loadStorage();
    return toast(`${r.files?.length || 0} fichier(s) mis à la corbeille, ${fmtMo(r.freed || 0)} libérés.`);
  }
}
function bindSettings() {
  const v = $('#view-reglages');
  v.addEventListener('click', e => { const act = e.target.closest('[data-act]')?.dataset.act; if (act?.startsWith('storage-')) storageAction(act); });
  v.addEventListener('change', async e => {
    if (e.target.id === 'clean-days') {
      cleanDays = clampDays(e.target.value, cleanDays);
      try { localStorage.setItem('regieLed.cleanDays', String(cleanDays)); } catch { /* sans gravité */ }
      renderStorage(); $('#clean-days')?.focus();
    }
    if (e.target.id === 'auto-clean-on' || e.target.id === 'auto-clean-days') {
      const on = $('#auto-clean-on').checked, inp = $('#auto-clean-days');
      autoCleanDays = clampDays(inp.value, autoCleanDays); inp.value = autoCleanDays; inp.disabled = !on;
      try { localStorage.setItem('regieLed.autoCleanDays', String(autoCleanDays)); } catch { /* sans gravité */ }
      const r = await (await fetch('/api/storage/auto?days=' + (on ? autoCleanDays : 0), { method: 'POST' })).json().catch(() => ({}));
      if (storageInfo) storageInfo.autoClean = r.autoClean || 0;
      toast(r.autoClean ? `Au démarrage, la régie mettra à la corbeille les fichiers inutilisés depuis ${r.autoClean} jours.` : 'Nettoyage automatique désactivé.');
    }
  });
  v.addEventListener('change', e => {
    if (e.target.id === 'set-name') { show.name = e.target.value.trim() || 'Show'; commit(); updateTop(); }
    if (e.target.id === 'set-prep') setPrep(e.target.checked);
    if (e.target.id === 'set-mire') { live.test = e.target.checked; commit(false); updatePlaying(); }
    if (e.target.id === 'set-screen') localStorage.setItem('regieLed.screen', e.target.value);
    if (e.target.id === 'set-cols') {
      const n = M.clamp(Math.round(+e.target.value || show.cols), 1, 32);
      const lost = show.layers.reduce((a, l) => a + show.cells[l.id].slice(n).filter(Boolean).length, 0);
      if (lost && !confirm(`${lost} clip(s) se trouvent dans les colonnes supprimées. Continuer ?`)) { e.target.value = show.cols; return; }
      show.cols = n;
      for (const l of show.layers) { const r = show.cells[l.id]; r.length = Math.min(r.length, n); while (r.length < n) r.push(null); }
      cleanup(); commit(); renderGrid(); renderCues(); renderInspector();
    }
  });
  v.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'export' || act === 'saveas') return saveShowAs();
    if (act === 'import') $('#import-input').click();
    if (act === 'new') {
      if (!confirm('Créer un nouveau show vide ? Le show actuel sera remplacé — enregistre-le d\'abord (« Enregistrer sous… ») si tu veux le garder.')) return;
      const n = await askText('Nom du nouveau show', 'Nouveau show', { max: 60, ok: 'Créer' });
      if (n === null) return;
      replaceShow(M.emptyShow((n || 'Nouveau show').trim().slice(0, 60) || 'Nouveau show'));
      toast('Show vide créé : un calque, aucune source, médiathèque vide. « ＋ Importer » pour tes fichiers (ou « Fichiers déjà importés… »).');
    }
    if (act === 'screens') { await loadScreens(true); renderSettings(); if (!screens) toast('Détection des écrans indisponible ou refusée sur ce navigateur.', 'err'); }
    const outId = e.target.closest('[data-out]')?.dataset.out;
    if (act === 'kbd-show') return openKeyboard();
    if (act === 'out-add') return addOutputAsk();
    if (act === 'out-open' && outId) return openOutput(outId);
    if (act === 'out-del' && outId) return deleteOutput(outId);
    if (act === 'key-capture') {
      const action = $('#key-action').value, target = $('#key-target')?.value || '', scene = SCENE_ACTIONS.includes(action) ? ($('#key-scene')?.value || show.sceneId) : '';
      return captureKey(e.target.closest('.btn'), k => { const nk = { ...k, action, target, scene }; setKey(nk); $('#keys-custom').innerHTML = keysPanel(); toast(`Raccourci ${keyLabel(k)} enregistré (${keyScopeLabel(nk)}).`); });
    }
    const kd = e.target.closest('[data-key-del]')?.dataset.keyDel;
    if (kd != null) { show.keys.splice(+kd, 1); commit(); $('#keys-custom').innerHTML = keysPanel(); return; }
    if (act === 'audio-devs') {
      await listAudio(true); renderSettings();
      toast(audioOutDevs.length ? `${audioOutDevs.length} sortie(s) son : ${audioOutDevs.map(d => d.label).join(', ')}` : 'Aucune sortie son listée : autorise le micro dans Chrome (il sert seulement à lire les noms des périphériques).', audioOutDevs.length ? '' : 'err');
    }
  });
  v.addEventListener('change', e => {
    if (e.target.dataset.outscreen) return setOutputScreen(e.target.dataset.outscreen, e.target.value);
    const f = e.target.dataset.outF, o = f && M.outputById(show, e.target.dataset.out);
    if (f && o) {
      if (f === 'name') { o.name = e.target.value.trim().slice(0, 40) || o.name; e.target.value = o.name; renderGrid(); renderInspector(); updatePlaying(); }
      if (f === 'screen') o.screen = e.target.value;
      if (f === 'mode') setOutMode(o, e.target.value);
      commit(); return;
    }
    if (e.target.id === 'key-action' || e.target.id === 'key-scene') { $('#keys-custom').innerHTML = keysPanel(); return; }
    if (e.target.id !== 'set-audio-out') return;
    show.audioOut = e.target.value; show.audioOutLabel = e.target.value ? (e.target.selectedOptions[0]?.textContent || '') : '';
    commit(); toast(show.audioOut ? `Le son sortira vers « ${show.audioOutLabel} ».` : 'Le son sortira par la sortie son du Mac.');
  });
  $('#import-input').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data?.layers)) throw new Error('format');
      replaceShow(M.normalizeShow(data)); toast('Show importé');
    } catch { toast('Ce fichier n\'est pas un show Régie LED valide.', 'err'); }
  });
}
/** « Enregistrer sous… » : copie du show dans un fichier, nom et emplacement au choix (Chrome : vraie fenêtre d'enregistrement ; sinon téléchargement). */
async function saveShowAs() {
  const n = await askText('Nom du show', show.name || 'Show', { max: 60, ok: 'Enregistrer' });
  if (n === null) return;
  if (n.trim() && n.trim() !== show.name) { show.name = n.trim().slice(0, 60); commit(); updateTop(); const f = $('#set-name'); if (f) f.value = show.name; }
  const file = (show.name || 'show').replace(/[^\p{L}\p{N} _-]/gu, '_') + '.json', json = JSON.stringify(show, null, 1);
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: file, types: [{ description: 'Show Régie LED', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable(); await w.write(json); await w.close();
      return toast(`Show enregistré : « ${h.name} ».`);
    } catch (e) { if (e?.name === 'AbortError') return; }                 // annulé par l'utilisateur
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Show enregistré dans les téléchargements : « ${file} ».`);
}
function replaceShow(s) {
  show = s; live = M.emptyLive(); live.sceneId = show.sceneId; sel = null; clearAuto(); prep.layers = {}; prepCue = null;
  zoneSel = null; drawing = null; zoneMulti.clear(); libSel.clear(); filterFiles();
  commit(); renderAll(); setTab(tab);
}

/* ---------- boucle d'affichage ---------- */
let engLive = null;
function drawView(view, cv, other, zone, out) {
  const eng = other || engLive;                      // moteur de la sortie par défaut, ou celui de l'aperçu
  if (!eng || !eng.cw) return;
  let w, h;
  if (view === 'comp') { w = eng.cw; h = eng.ch; }
  else if (view === 'retour') { w = 960; h = 540; }
  else if (view === 'zone' && zone) { const k = Math.min(1, 960 / zone.src.w, 540 / zone.src.h); w = Math.max(2, Math.round(zone.src.w * k)); h = Math.max(2, Math.round(zone.src.h * k)); }
  else { const o = show.output, k = Math.min(1, 960 / o.w, 960 / o.h); w = Math.max(2, Math.round(o.w * k)); h = Math.max(2, Math.round(o.h * k)); }
  const g = eng.canvas;
  if (g.width < w || g.height < h) { g.width = Math.max(g.width, w); g.height = Math.max(g.height, h); }
  if (view === 'retour') eng.presentRetour(w, h, out); else eng.present(view, w, h, zone ? { zone, fit: false } : {});
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  cv.getContext('2d').drawImage(g, 0, g.height - h, w, h, 0, 0, w, h);
}
let slowT = 0;
/** Mac : toutes les 10 s, tant qu'un PowerPoint en direct est préparé ou à la sortie, sa fenêtre est remise sous le bord de l'écran
 *  si macOS l'a remontée (sinon le curseur de la souris qui passe dessus apparaît dans la capture : mur et écran retour).
 *  Sans bruit : ni message, ni premier plan volé ; une minute de pause si PowerPoint ne répond pas (diaporama fermé). */
let pptParkAt = 0;
function pptKeepParked(now) {
  if (now < pptParkAt || !/Mac/.test(navigator.platform)) return;
  pptParkAt = now + 10000;
  const ids = [...Object.values(live.layers || {}), ...(prepOn ? Object.values(prep.layers || {}) : [])].map(L => L?.clipId).filter(Boolean);
  const c = ids.map(id => show.clips[id]).find(x => x?.ppt);
  if (!c) return;
  fetch('/api/ppt/cmd?do=park&file=' + encodeURIComponent(c.ppt), { method: 'POST' })
    .then(r => { if (!r.ok) pptParkAt = Date.now() + 60000; }).catch(() => { pptParkAt = Date.now() + 60000; });
}
function loop(t) {
  engLive = eng;
  requestAnimationFrame(loop);
  regieFrames++;
  if (eng) {
    eng.setState(show, live); eng.frame();
    if (tab === 'regie') {
      const o = monOut !== 'main' && M.outputById(show, monOut);
      if (o && o.id !== 'main') {                              // aperçu d'une sortie secondaire : son propre moteur, avec ses calques masqués
        if (!engOut2) { try { engOut2 = new Engine({ role: 'preview', maxW: 640 }); } catch { engOut2 = null; } }
        if (engOut2) {
          engOut2.hideLayers = o.mode === 'retour' ? null : new Set(o.hidden); engOut2.audio = eng.audio; engOut2.setState(show, live); engOut2.frame();
          const zone = o.mode === 'zone' && show.slices.find(z => z.id === o.zoneId);
          if (o.mode === 'retour') drawView('retour', $('#preview'), engOut2, null, o);
          else drawView(zone ? 'zone' : 'comp', $('#preview'), engOut2, zone || null);
        }
      } else { drawView('comp', $('#preview')); if (engOut2) { engOut2.reset(); } }
    }
    else if (tab === 'mapping') mapping.frame();
    else if (tab === 'outputs') drawOutputsView();
  }
  if (prepOn && engPrep) {
    // Préparation identique à la sortie (rien de nouveau préparé, même scène) : l'écran Préparation recopie l'image de l'écran Sortie
    // au lieu de décoder une 2e fois les mêmes vidéos ; hors de l'onglet Régie, il ne décode rien du tout. Sous Windows, où les
    // vidéos sont décodées par le processeur, chaque décodage en double coûtait cher (images perdues avec plusieurs vidéos 4K) et
    // occupait une des 6 connexions vers le serveur local.
    const same = eng && prepCue == null && (!live.sceneId || live.sceneId === show.sceneId) && !prepDiffers();
    if (tab !== 'regie' || same) {
      if (engPrep.sources.size) engPrep.reset();
      if (tab === 'regie') drawView('comp', $('#preview-prep'), eng);
    } else {
      prep.beat0 = live.beat0; engPrep.audio = eng ? eng.audio : 0.5;
      engPrep.setState(show, prep); engPrep.frame();
      drawView('comp', $('#preview-prep'), engPrep);
    }
  }
  micFrame(); vuFrame();
  const beat = (Date.now() - live.beat0) / 60000 * show.bpm;
  $('#beat-dot').style.opacity = String(1 - (beat % 1) * 0.85);
  if (t - slowT > 250) {
    slowT = t;
    updateOutStatus();
    if (t - (window.__healthT || 0) > 1000) { window.__healthT = t; healthUpdate(); }
    pptKeepParked(Date.now());
    if (tab === 'outputs') for (const o of show.outputs) {             // état de chaque fenêtre de sortie
      const st = $(`#view-outputs [data-outst="${CSS.escape(o.id)}"]`), on = outIsOpen(o.id), card = st?.closest('.oc');
      if (st && st.textContent !== outputStatus(o)) st.textContent = outputStatus(o);
      if (card && card.classList.contains('on') !== on) { card.classList.toggle('on', on); const b = card.querySelector('[data-act="out-open"]'); if (b) { b.textContent = on ? 'Rouvrir' : 'Ouvrir'; b.classList.toggle('gold', !on); } }
    }
    if (placeShapes()) renderShapes();          // l'aperçu a changé de taille : on recale les contours
    if (eng && tab === 'regie') for (const el of $$('#grid .cell.playing')) {
      const p = eng.progress(el.dataset.layer);
      el.querySelector('.c-bar i').style.width = p == null ? '0' : (p * 100).toFixed(1) + '%';
    }
    const a = $('#cue-auto');
    if (a) a.textContent = autoAt ? 'Suite automatique dans ' + Math.max(0, Math.ceil((autoAt - Date.now()) / 1000)) + ' s' : '';
  }
}

function renderAll() { renderLib(); renderScenes(); renderGrid(); renderCues(); renderInspector(); updateTop(); renderShapeBar(); renderShapes(); if (tab === 'mapping') mapping?.render(); }

async function boot() {
  let data = null, readOk = false;
  try { const r = await fetch('/api/show'); if (r.ok) { data = await r.json(); readOk = true; } } catch { /* serveur injoignable */ }
  // Copie locale (gardée à chaque modification) : prise si le show n'a pas pu être lu, ou si le dernier enregistrement avait échoué.
  let local = null, unsaved = false;
  try { local = JSON.parse(localStorage.getItem('regieLed.state'))?.show || null; unsaved = localStorage.getItem(UNSAVED_KEY) === '1'; } catch { /* pas de copie */ }
  if (local && (!readOk || unsaved)) {
    data = local;
    setTimeout(() => toast(readOk ? 'Show repris depuis la copie de la régie : ses dernières modifications n\'avaient pas pu être enregistrées. Enregistrement en cours.' : 'Le show n\'a pas pu être lu sur le disque : repris depuis la copie de la régie.', 'err'), 800);
    if (readOk) setTimeout(saveShow, 1500);                  // le serveur répond : la copie récente y est réenregistrée
  } else if (!readOk) {
    saveBlocked = true;                                      // ni show lisible ni copie : surtout ne rien écraser
    setTimeout(() => toast('Le show n\'a pas pu être lu (serveur local injoignable ou fichier verrouillé). Rien ne sera enregistré : relance la régie.', 'err'), 800);
  }
  show = M.normalizeShow(data);
  live = restoreLive();
  bc = new BroadcastChannel('regie-led');
  bc.onmessage = e => {
    const m = e.data;
    if (m.t === 'hello') push();
    else if (m.t === 'levels') { levels = m.l || {}; levelsAt = Date.now(); levelsRun = !!m.run; }
    else if (m.t === 'status' && m.out && m.out !== 'main') { outInfos[m.out] = { ...m, seen: Date.now() }; }
    else if (m.t === 'bye' && m.out && m.out !== 'main') { delete outInfos[m.out]; }
    else if (m.t === 'status') {
      outInfo = m; outSeen = Date.now();
      // Fenêtre de sortie restée sur un code trop ancien pour se recharger seule : la régie la recharge elle-même si elle peut l'atteindre.
      if (m.v === undefined) {
        staleSeen = Date.now();
        if (Date.now() - staleTried > 20000) { staleTried = Date.now(); refreshOutput(); }
      }
      // Fenêtre de sortie ouverte avec un code plus ancien que la régie : elle se recharge toute seule.
      if (appVersion && m.v && m.v < appVersion && Date.now() - reloadAsked > 8000) { reloadAsked = Date.now(); bc.postMessage({ t: 'reload' }); }
    }
    else if (m.t === 'bye') { outSeen = 0; }
  };
  try {
    eng = new Engine({ role: 'preview', maxW: 960 });
    eng.audio = 0.5;
    eng.onEnded = clipId => { if (live.cue >= 0 && Object.values(live.layers).some(L => L.clipId === clipId)) nextCue(); };
  } catch (e) { toast(e.message, 'err'); }
  mapping = initMapping({
    root: $('#view-mapping'), show: () => show, live: () => live, out: () => (Date.now() - outSeen < 2600 ? outInfo : null),
    commit, drawView: (view, cv) => drawView(view, cv), toast, refresh: () => { updatePlaying(); }, addLayerForZone, layersOfZone: id => show.layers.filter(l => l.zone === id).map(l => l.name),
    zoneSel: () => zoneSel, selectZone, syncQuad, toggleQuad, quadMove, quadCorner, zonePoint: M.zonePoint, shapeBar: () => { renderShapeBar(); if (drawing) renderDraw(); }, squarify,
    multi: id => zoneMulti.has(id), toggleMulti, snapOn: () => snapOn, snapMove, snapEdges, localGroups, setVertex, insertVertex, deleteVertex, afterEdit: () => { renderShapes(); },
  });
  await loadMedia();
  window.regieDesktop?.onUpdate?.(m => toast(m.text));                 // application de bureau : mise à jour disponible ou prête
  fetch('/api/version').then(r => r.json()).then(j => { appVersion = j.v || 0; }).catch(() => {});
  setInterval(() => {                       // dépannage : état de la régie, lisible sur le serveur local (/api/diag)
    const streams = Object.fromEntries(Object.entries(window.__ledStreams).map(([id, s]) => { const t = s.getVideoTracks()[0]; return [id, { active: s.active, label: t?.label, state: t?.readyState, muted: t?.muted, size: t ? t.getSettings().width + 'x' + t.getSettings().height : '' }]; }));
    fetch('/api/diag?who=regie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      at: new Date().toISOString(), v: appVersion, prep: prepOn, streams, rtc: relay.states(),
      live: Object.fromEntries(show.layers.map(l => [l.name, show.clips[live.layers[l.id]?.clipId]?.name || ''])), out: Date.now() - outSeen < 2600 ? outInfo : null,
      outputs: show.outputs.map(o => ({ id: o.id, name: o.name, mode: o.mode, hidden: o.hidden.length, open: outIsOpen(o.id) })) }) }).catch(() => {});
  }, 3000);
  listCams(false).then(() => { for (const c of camKnown) c.seen = camDevices.some(d => d.deviceId === c.deviceId); saveCams(); if (camDevices.some(d => d.label)) renderLib(); });   // sources déjà autorisées : liste à jour sans rien demander
  bindTop(); bindLib(); bindGrid(); bindCues(); bindInspector(); bindSettings(); bindShapes(); bindScenes(); bindOutputsView();
  renderAll();
  $('#save-state').textContent = data ? 'Enregistré' : '';
  push();
  bc.postMessage({ t: 'audio', v: 0.5 });
  loadScreens(false);
  setPrep(prepOn);
  requestAnimationFrame(loop);
}
boot();
