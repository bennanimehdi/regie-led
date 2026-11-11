/* Régie LED — fenêtre de sortie : à mettre en plein écran sur la sortie HDMI reliée au processeur LED.
 * Elle reçoit l'état de la régie (BroadcastChannel) et fait son propre rendu : si la régie est rechargée
 * ou fermée, la sortie continue d'afficher la dernière image demandée. */
import { Engine } from './engine.js';
import { sharedStream, directStream } from './sources.js';
import { startReceiver } from './relay.js';
import { Meter, meterCtx, meterRunning } from './meter.js';
import { outputById } from './model.js';

// Quelle sortie est cette fenêtre ? output.html = la principale (LED, mapping, son) ; output.html?out=<id> = une sortie secondaire
// (retour conférenciers, autre salle…) : toute la composition ou une zone en plein cadre, sans ses calques masqués, sans son.
const outId = new URLSearchParams(location.search).get('out') || 'main';
const isMain = outId === 'main';
const hint = document.getElementById('hint');
// Plein écran : celui demandé par la page, ou, dans l'application de bureau, la fenêtre native qui couvre tout l'écran.
const isFs = () => !!document.fullscreenElement || (!!window.regieDesktop && outerWidth >= screen.width && outerHeight >= screen.height);
let eng;
try { eng = new Engine({ role: 'output' }); }
catch (e) { hint.textContent = e.message; throw e; }
document.body.prepend(eng.canvas);

const bc = new BroadcastChannel('regie-led');
let state = null;
const me = () => (state ? outputById(state.show, outId) : null);
const apply = s => {
  if (!s?.show || !s.live) return;
  state = s; eng.setState(s.show, s.live); eng.sinkId = s.show.audioOut || '';
  const o = me(); eng.hideLayers = new Set(o?.hidden || []); eng.silent = !isMain;
  if (o && !isMain) document.title = 'Régie LED — ' + o.name;
};

try { apply(JSON.parse(localStorage.getItem('regieLed.state'))); } catch { /* premier lancement */ }
bc.onmessage = e => {
  const m = e.data;
  if (m.t === 'state') apply(m);
  else if (m.t === 'audio') eng.audio = m.v;
  else if (m.t === 'reload') location.reload();          // la régie a un code plus récent que cette fenêtre
};
/** Clips « fenêtre en direct » actuellement à l'écran : ceux dont il faut la capture. */
const liveScreens = () => (state ? Object.values(state.live.layers || {}).map(L => L.clipId).filter(id => state.show.clips[id]?.type === 'screen') : []);
const relay = startReceiver(liveScreens, id => !!directStream(id));
let version = 0;
fetch('/api/version').then(r => r.json()).then(j => { version = j.v || 0; }).catch(() => {});
/** Un clip « fenêtre en direct » est à l'écran mais cette fenêtre ne reçoit pas la capture de la régie. */
function missingCapture() {
  if (!state) return false;
  return Object.values(state.live.layers || {}).some(L => state.show.clips[L.clipId]?.type === 'screen' && !sharedStream(L.clipId));
}
bc.postMessage({ t: 'hello' });
window.__eng = eng;          // pour le diagnostic

/* Vumètres : niveau de chaque source qui joue ici (c'est ce que le mur entend), envoyé à la régie 10 fois par seconde.
 * `in` = niveau du signal de la source ; `out` = ce qui sort réellement (après le volume du clip et le fondu). */
const meters = new Map();    // clipId → {m, at}
setInterval(() => {
  const l = {};
  for (const [id, e] of eng.sources) {
    const s = e.src;
    if (!s.v) continue;
    let m = meters.get(id);
    if (!m || (!m.m.ok && Date.now() - m.at > 1000)) { m?.m.dispose(); m = { m: new Meter(s.stream || s.v), at: Date.now() }; meters.set(id, m); }
    if (m.m.ok) { const v = m.m.level(); l[id] = { in: v, out: s.v.muted ? 0 : v * (s.v.volume ?? 1) }; }
    else l[id] = { in: -1, out: -1 };                                  // pas de piste audio
  }
  for (const id of [...meters.keys()]) if (!eng.sources.has(id)) { meters.get(id).m.dispose(); meters.delete(id); }
  if (meters.size && isMain) bc.postMessage({ t: 'levels', l, run: meterRunning() });
}, 100);

function loop() {
  requestAnimationFrame(loop);
  if (!state) return;
  const c = eng.canvas, o = me();
  if (isMain) {
    const { w, h } = state.show.output;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    eng.frame();
    eng.present('output', w, h);
    return;
  }
  // Sortie secondaire : elle remplit son écran, quelle que soit sa résolution (bandes noires si les proportions diffèrent).
  const w = Math.max(2, Math.round(innerWidth * devicePixelRatio)), h = Math.max(2, Math.round(innerHeight * devicePixelRatio));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  eng.frame();
  const zone = o?.mode === 'zone' && state.show.slices.find(z => z.id === o.zoneId);
  if (zone) eng.present('zone', w, h, { zone, fit: true }); else eng.present('comp', w, h, { fit: true });
}
requestAnimationFrame(loop);

setInterval(() => bc.postMessage({
  t: 'status', out: outId, w: Math.round(innerWidth * devicePixelRatio), h: Math.round(innerHeight * devicePixelRatio),
  fs: isFs(), fps: eng.fps, audioBlocked: !!eng.audioBlocked, cameraError: eng.cameraError || '',
  v: version, noCapture: missingCapture(), linked: !!window.opener,
  via: liveScreens().map(id => (directStream(id) ? 'direct' : window.__ledRemote?.[id] ? 'relais' : 'rien')).join(','), rtc: relay.states().join(' '),
}), 1000);
addEventListener('pagehide', () => bc.postMessage({ t: 'bye', out: outId }));
// Dépannage : état de cette fenêtre, lisible sur le serveur local (/api/diag).
setInterval(() => {
  const srcs = [...eng.sources].map(([id, e]) => ({ id, type: e.src.clip?.type, ready: !!e.src.ready, w: e.src.w, h: e.src.h, stream: !!e.src.stream, video: e.src.v ? e.src.v.readyState + '/' + e.src.v.videoWidth : '', frames: e.src.v?.getVideoPlaybackQuality?.().totalVideoFrames ?? null }));
  fetch('/api/diag?who=' + (isMain ? 'sortie' : 'sortie-' + outId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    at: new Date().toISOString(), v: version, opener: !!window.opener, live: liveScreens(), via: liveScreens().map(id => (directStream(id) ? 'direct' : window.__ledRemote?.[id] ? 'relais' : 'rien')),
    rtc: relay.states(), sources: srcs, fps: eng.fps, size: innerWidth + 'x' + innerHeight, visible: document.visibilityState }) }).catch(() => {});
}, 3000);

/* Plein écran, curseur masqué, écran maintenu allumé */
let hintT;
function showHint() {
  clearTimeout(hintT);
  if (isFs()) return hint.classList.add('off');
  hint.classList.remove('off');
  hintT = setTimeout(() => hint.classList.add('off'), 8000);
}
function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
addEventListener('click', () => {
  // Un clic dans cette fenêtre autorise aussi le son des vidéos et la mesure du niveau (règle des navigateurs).
  if (eng.audioBlocked) { eng.audioBlocked = false; for (const e of eng.sources.values()) e.src.blocked = false; }
  meterCtx();
  if (!isFs()) toggleFs();
});
addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') toggleFs(); });
document.addEventListener('fullscreenchange', showHint);
addEventListener('resize', showHint);
showHint();

let idleT;
addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => document.body.classList.add('idle'), 2000);
});
document.body.classList.add('idle');

async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch { /* refusé : sans gravité */ } }
keepAwake();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
