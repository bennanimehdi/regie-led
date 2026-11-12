/* Régie LED — sources d'image : chaque clip qui joue devient une texture WebGL mise à jour à chaque image.
 * Interface commune : { tex, w, h, ready, stretch, setClip(clip), start(t0), update(now, env), dispose() } */
import { hexToRgb } from './model.js';

class Base {
  constructor(eng, clip) { this.eng = eng; this.gl = eng.gl; this.clip = clip; this.tex = eng.newTex(); this.w = 0; this.h = 0; this.ready = false; this.t0 = Date.now(); }
  setClip(clip) { this.clip = clip; }
  start(t0) { this.t0 = t0; }
  update() {}
  upload(el) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); } catch { /* image pas encore décodable */ }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  /** Image d'une vidéo vers la carte graphique. Dans les aperçus de la régie, une vidéo bien plus grande que l'aperçu (4K…) est
   *  d'abord réduite : une 4K complète à chaque image, dans deux ou trois aperçus en plus de la sortie, peut saturer un PC portable
   *  (vidéo figée à la sortie). La fenêtre de sortie, elle, garde toujours la pleine résolution. */
  uploadVideo(v) {
    const eng = this.eng;
    if (eng.role === 'output' || !eng.maxW || v.videoWidth <= eng.maxW * 2) return this.upload(v);
    const w = Math.round(eng.maxW * 1.5), h = Math.max(1, Math.round(v.videoHeight * w / v.videoWidth));
    const cv = this.small ||= document.createElement('canvas');
    if (cv.width !== w || cv.height !== h || !this.smallCtx) { cv.width = w; cv.height = h; this.smallCtx = cv.getContext('2d', { alpha: false }); }
    try { this.smallCtx.drawImage(v, 0, 0, w, h); } catch { return; }
    this.upload(cv);
  }
  /** Suit les images que le décodeur produit vraiment (requestVideoFrameCallback). Sans ça, une vidéo à 30 i/s était renvoyée
   *  à la carte graphique à chaque rafraîchissement de l'écran : 144 fois par seconde sur un écran 144 Hz, soit près de 5 fois trop
   *  pour une 4K (saccades sous Windows, où cet envoi coûte cher). */
  watchFrames(v) {
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    this.rvfc = true;
    const cb = () => { this.fresh = true; if (!this.gone) v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
  /** Faut-il renvoyer l'image ? Oui s'il y a une nouvelle image décodée ; par sécurité aussi toutes les 0,5 s (rappel manqué,
   *  navigateur sans requestVideoFrameCallback : on revient à l'ancien comportement, une image par rafraîchissement). */
  freshFrame() {
    const now = performance.now();
    if (!this.rvfc || this.fresh || !this.ready || now - (this.upAt || 0) > 500) { this.fresh = false; this.upAt = now; return true; }
    return false;
  }
  dispose() { this.gone = true; this.gl.deleteTexture(this.tex); }
}

/** Son d'un élément <video> : seulement dans la fenêtre de sortie (l'aperçu de la régie reste muet), au volume du clip,
 *  vers le périphérique de sortie choisi dans les Réglages (eng.sinkId ; '' = sortie du Mac). */
function applyAudio(src, v, clip) {
  // src.gain : suit le fondu du calque (le son d'un clip qui s'efface baisse avec son image, et se coupe à la fin du fondu).
  const eng = src.eng, vol = eng.role === 'output' && !eng.silent && !eng.live?.mute ? Math.min(1, Math.max(0, +clip.volume || 0)) * Math.min(1, Math.max(0, src.gain ?? 1)) : 0;
  if (vol > 0 && !src.blocked) { if (v.muted) v.muted = false; if (Math.abs(v.volume - vol) > 0.005) v.volume = vol; }
  else if (!v.muted) v.muted = true;
  const sink = eng.role === 'output' ? (eng.sinkId || '') : '';
  if (v.setSinkId && src.sink !== sink) { src.sink = sink; v.setSinkId(sink).catch(() => { src.sink = ''; eng.sinkError = true; }); }
}

class VideoSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    const v = this.v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto'; v.muted = true; v.src = clip.src;
    v.addEventListener('ended', () => {
      if (this.clip.end === 'next') { if (!this.endedSent) { this.endedSent = true; eng.onEnded?.(this.clip.id); } }
      else if (this.loops()) { v.currentTime = this.seg().a; this.play(); }        // boucle avec un point de début : on repart de là
    });
    v.addEventListener('loadedmetadata', () => { if (this.lateSeek) this.seekLate(); });
    v.addEventListener('error', () => { this.error = true; });
    this.kicks = 0; this.stuckAt = 0;
    this.watchFrames(v);
    this.setClip(clip);
  }
  loops() { const c = this.clip; return c.end !== 'hold' && c.end !== 'next'; }
  /** Portion lue : de `start` à `stop` (secondes ; 0 = début / fin de la vidéo). */
  seg() {
    const c = this.clip, d = this.v.duration, a = Math.max(0, +c.start || 0);
    let b = +c.stop > a ? +c.stop : Infinity;
    if (isFinite(d) && d > 0) b = Math.min(b, d);
    return { a, b, cut: a > 0 || +c.stop > a };
  }
  setClip(clip) {
    this.clip = clip;
    const v = this.v;
    const loop = this.loops() && !this.seg().cut;          // avec une découpe, la boucle est gérée à la main (le navigateur repartirait de 0)
    if (v.loop !== loop) v.loop = loop;
    const rate = Math.min(4, Math.max(0.1, +clip.speed || 1));
    if (v.playbackRate !== rate) v.playbackRate = rate;
    applyAudio(this, v, clip);
  }
  seekLate() {
    const v = this.v, { a, b } = this.seg();
    if (!isFinite(b)) return;
    const len = Math.max(0.1, b - a), el = (Date.now() - this.t0) / 1000 * v.playbackRate;
    v.currentTime = this.loops() ? a + el % len : Math.min(a + el, Math.max(a, b - 0.05));
    this.lateSeek = false;
  }
  /** Écran Préparation (eng.staging) : une vidéo « en attente » (clip.hold) reste figée sur son point de départ tant qu'elle
   *  n'est pas à la sortie ; dès qu'elle y passe, elle joue en même temps que le mur. */
  frozen() { const e = this.eng; return !!(e.staging && this.clip.hold !== false && !(e.isLive && e.isLive(this.clip.id))); }
  start(t0) {
    this.t0 = t0; this.held = false; this.endedSent = false; this.stuckAt = 0; this.kicks = 0;
    const v = this.v;
    if (this.frozen()) { this.wasFrozen = true; v.pause(); try { v.currentTime = this.seg().a; } catch { /* pas encore chargée */ } return; }
    if (Date.now() - t0 > 400) { this.lateSeek = true; if (v.readyState >= 1) this.seekLate(); }   // fenêtre ouverte en cours de route, ou saut de position
    else { try { v.currentTime = this.seg().a; } catch { /* pas encore chargée */ } }
    this.play();
  }
  play() {
    const v = this.v, p = v.play();
    if (p) p.catch(() => {
      if (!v.muted) { this.blocked = true; v.muted = true; this.eng.audioBlocked = true; v.play().catch(() => {}); }
    });
  }
  update() {
    const v = this.v;
    if (this.frozen()) {                                                     // figée sur le point de départ (image seule)
      this.wasFrozen = true;
      const a = this.seg().a;
      if (!v.paused) v.pause();
      if (v.readyState >= 1 && Math.abs(v.currentTime - a) > 0.25 && !v.seeking) v.currentTime = a;
    } else if (this.wasFrozen) { this.wasFrozen = false; this.start(this.t0); }   // elle vient de passer à la sortie : lecture calée sur le mur
    // Pause demandée par la régie : la vidéo s'arrête ; à la reprise, t0 a été décalé et start() la recale au bon endroit.
    if (this.pausedAt) { if (!v.paused) { v.pause(); this.pausedByUs = true; } }
    else if (this.pausedByUs) { this.pausedByUs = false; this.play(); }
    if (v.readyState >= 2 && v.videoWidth) {
      if (this.rvfc ? this.freshFrame() : (!this.ready || v.currentTime !== this.lastT)) { this.uploadVideo(v); this.lastT = v.currentTime; }
      this.w = v.videoWidth; this.h = v.videoHeight; this.ready = true;
      if (this.frozen()) return;
      const { a, b, cut } = this.seg();
      if (cut && isFinite(b) && v.currentTime >= b - 0.03) {                    // point de fin atteint
        if (this.loops()) v.currentTime = a;
        else if (!v.paused) { v.pause(); this.held = true; if (this.clip.end === 'next' && !this.endedSent) { this.endedSent = true; this.eng.onEnded?.(this.clip.id); } }
      }
      if (this.eng.role === 'output') this.watchdog(v);
    }
  }
  /** Fenêtre de sortie : une vidéo qui doit jouer mais reste en pause, ou dont l'image ne bouge plus (décodeur bloqué, PC
   *  saturé), est relancée — plusieurs fois s'il le faut, et c'est noté dans le journal (Aide → Ouvrir le dossier des journaux). */
  watchdog(v) {
    const now = performance.now();
    if (this.held || this.pausedAt || v.ended || this.frozen()) { this.stuckAt = 0; return; }
    if (v.paused) {                                                       // lecture refusée ou interrompue : on relance (au plus toutes les 1,5 s)
      if (now - (this.kickAt || 0) > 1500) { this.kickAt = now; if (this.kicks++ >= 1) console.warn(`Vidéo « ${this.clip.name || this.clip.src} » en pause à la sortie : relance`); this.play(); }
      return;
    }
    this.kicks = 0;
    if (v.seeking || v.currentTime !== this.wT) { this.wT = v.currentTime; this.stuckAt = now; return; }
    if (!this.stuckAt) { this.stuckAt = now; return; }
    if (now - this.stuckAt > 2500 && now - (this.nudgeAt || 0) > 4000) {   // image figée depuis 2,5 s alors qu'elle joue : on la décoince
      this.nudgeAt = now; this.stuckAt = now;
      console.warn(`Vidéo « ${this.clip.name || this.clip.src} » figée à la sortie (${v.videoWidth}×${v.videoHeight}, état ${v.readyState}) : relance`);
      try { v.currentTime = v.currentTime + 0.04; } catch { /* sans gravité */ }
      this.play();
    }
  }
  /** Position de lecture 0..1 dans la portion lue (pour la barre de progression de la régie). */
  progress() { const { a, b } = this.seg(); return isFinite(b) && b > a ? Math.min(1, Math.max(0, (this.v.currentTime - a) / (b - a))) : 0; }
  dispose() { const v = this.v; v.pause(); v.removeAttribute('src'); v.load(); super.dispose(); }
}

class ImageSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    const img = this.img = new Image();
    img.onload = () => { this.w = img.naturalWidth || 1; this.h = img.naturalHeight || 1; this.upload(img); this.ready = true; };
    img.onerror = () => { this.error = true; };
    img.src = clip.src;
  }
}

/** Adresse de l'image d'une page de document (page à partir de 0). */
export const docPageUrl = (doc, page) => '/doc/' + encodeURIComponent(doc) + '/' + String(page + 1).padStart(3, '0') + '.jpg';

/** Document à pages (PDF, Word, Excel…) : affiche la page `clip.page` ; on garde la page précédente tant que la nouvelle charge. */
class DocSource extends Base {
  constructor(eng, clip) { super(eng, clip); this.cur = -1; this.loading = -1; }
  update() {
    const c = this.clip, n = Math.max(1, +c.pages || 1), page = Math.min(n - 1, Math.max(0, Math.round(+c.page || 0)));
    if (page === this.cur || page === this.loading) return;
    this.loading = page;
    const img = new Image();
    img.onload = () => {
      if (this.loading !== page || this.dead) return;
      this.w = img.naturalWidth || 1; this.h = img.naturalHeight || 1; this.upload(img);
      this.cur = page; this.loading = -1; this.ready = true;
      if (page + 1 < n) new Image().src = docPageUrl(c.doc, page + 1);        // la page suivante est prête d'avance
    };
    img.onerror = () => { if (this.loading === page) { this.loading = -1; this.cur = page; this.error = true; } };
    img.src = docPageUrl(c.doc, page);
  }
  dispose() { this.dead = true; super.dispose(); }
}

class CameraSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    const v = this.v = document.createElement('video');
    v.playsInline = true; v.muted = true; this.watchFrames(v);
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (clip.deviceId) video.deviceId = { exact: clip.deviceId };
    // Le son de la source (entrée audio de la carte de capture) n'est demandé que par la fenêtre de sortie, telle quelle (sans traitement « voix »).
    const wantAudio = eng.role === 'output' && !eng.silent && clip.audio;
    const audio = wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(clip.audioDeviceId ? { deviceId: { exact: clip.audioDeviceId } } : {}) } : false;
    const md = navigator.mediaDevices;
    (md ? md.getUserMedia({ video, audio }).catch(e => (wantAudio ? md.getUserMedia({ video, audio: false }).then(s => { eng.cameraError = 'Son de la source indisponible : ' + (e.message || e); return s; }) : Promise.reject(e))) : Promise.reject(new Error('indisponible')))
      .then(stream => {
        if (this.dead) return stream.getTracks().forEach(t => t.stop());
        this.stream = stream; v.srcObject = stream; this.setClip(this.clip); this.play();
      })
      .catch(e => { this.error = true; eng.cameraError = String(e.message || e); });
  }
  setClip(clip) { this.clip = clip; applyAudio(this, this.v, clip); }
  play() {
    const p = this.v.play();
    if (p) p.catch(() => { if (!this.v.muted) { this.blocked = true; this.v.muted = true; this.eng.audioBlocked = true; this.v.play().catch(() => {}); } });
  }
  update() {
    const v = this.v;
    if (v.readyState >= 2 && v.videoWidth) { if (this.freshFrame()) this.upload(v); this.w = v.videoWidth; this.h = v.videoHeight; this.ready = true; }
  }
  dispose() { this.dead = true; this.stream?.getTracks().forEach(t => t.stop()); this.v.srcObject = null; super.dispose(); }
}

const pad = n => String(n).padStart(2, '0');

class TextSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    this.cv = document.createElement('canvas');
    this.ctx = this.cv.getContext('2d');
    this.stretch = true;
    this.sig = '';
  }
  content(now) {
    const c = this.clip;
    if (c.mode === 'clock') {
      const d = new Date(now);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + (c.secs ? ':' + pad(d.getSeconds()) : '');
    }
    if (c.mode === 'countdown') {
      let target;
      if (c.cdMode === 'heure') {
        const [hh, mm] = String(c.cdTime || '0:0').split(':').map(Number);
        const d = new Date(now); d.setHours(hh || 0, mm || 0, 0, 0);
        target = d.getTime();
      } else target = this.t0 + (+c.cdMin || 0) * 60000;
      const left = Math.ceil((target - now) / 1000);
      if (left <= 0) return c.cdEnd || '00:00';
      const h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
      return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
    }
    return String(c.text ?? '');
  }
  update(now, env, tw, th) {
    const c = this.clip, W = tw || this.eng.cw, H = th || this.eng.ch;      // taille de la zone cible (ou de l'image)
    // Compte à rebours « en attente » dans l'écran Préparation : il affiche son temps de départ et ne décompte qu'une fois à la sortie (comme une vidéo).
    const e = this.eng, waiting = e.staging && c.mode === 'countdown' && c.cdMode !== 'heure' && c.hold !== false && !(e.isLive && e.isLive(c.id));
    if (waiting) now = this.t0;
    else if (this.pausedAt && c.mode !== 'clock') now = this.pausedAt;        // pause : le compte à rebours et le bandeau se figent (l'horloge, elle, continue)
    const text = this.content(now);
    const scrolling = c.scroll && c.mode === 'text';
    const sig = scrolling ? '' : [W, H, text, c.font, c.size, c.bold, c.color, c.align, c.valign, c.outline, c.shadow, c.bg, c.bgColor, c.bgAlpha].join('|');
    if (!scrolling && sig === this.sig) return;
    this.sig = sig;
    const cv = this.cv, ctx = this.ctx;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.clearRect(0, 0, W, H);
    let px = Math.max(4, (+c.size || 10) / 100 * H);
    const family = `"${String(c.font || 'Helvetica Neue').replace(/"/g, '')}", "Helvetica Neue", Arial, sans-serif`;
    ctx.font = `${c.bold ? '700' : '400'} ${px}px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.direction = /[֐-ࣿ]/.test(text) ? 'rtl' : 'ltr';
    const lines = scrolling ? [text.replace(/\s*\n\s*/g, '   •   ')] : text.split('\n');
    if (!scrolling) {                     // zone étroite (totem) : on réduit la taille pour que la ligne la plus longue tienne
      const widest = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
      if (widest > W * 0.92) { px = Math.max(4, px * W * 0.92 / widest); ctx.font = `${c.bold ? '700' : '400'} ${px}px ${family}`; }
    }
    const lh = px * 1.18, total = lines.length * lh, m = W * 0.04;
    let top = c.valign === 'top' ? m * 0.7 : c.valign === 'bottom' ? H - total - m * 0.7 : (H - total) / 2;
    const bg = hexToRgb(c.bgColor), bgCss = `rgba(${bg.map(v => Math.round(v * 255)).join(',')},${+c.bgAlpha || 0})`;
    if (c.bg === 'full') { ctx.fillStyle = bgCss; ctx.fillRect(0, 0, W, H); }
    if (c.bg === 'bar') { ctx.fillStyle = bgCss; ctx.fillRect(0, top - px * 0.28, W, total + px * 0.56); }
    ctx.fillStyle = c.color || '#fff';
    ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
      const y = top + lh * (i + 0.5);
      let x;
      if (scrolling) {
        const tw = ctx.measureText(line).width, span = W + tw;
        const dist = ((now - this.t0) / 1000 * (+c.scrollSpeed || 1) * W * 0.15) % span;
        const rtl = ctx.direction === 'rtl';
        ctx.textAlign = 'left'; ctx.direction = 'ltr';
        x = rtl ? -tw + dist : W - dist;
      } else {
        ctx.textAlign = c.align === 'left' ? 'left' : c.align === 'right' ? 'right' : 'center';
        x = c.align === 'left' ? m : c.align === 'right' ? W - m : W / 2;
      }
      if (c.shadow) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = px * 0.18; ctx.shadowOffsetY = px * 0.05; }
      if (c.outline) { ctx.strokeStyle = '#000'; ctx.lineWidth = px * 0.12; ctx.strokeText(line, x, y); ctx.shadowColor = 'transparent'; }
      ctx.fillText(line, x, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    });
    this.w = W; this.h = H; this.upload(cv); this.ready = true;
  }
}

const GEN_KIND = { uni: 0, degrade: 1, barres: 2, lignes: 3, plasma: 4, tunnel: 5, damier: 6, neige: 7, flash: 8, balayage: 9 };

class GenSource extends Base {
  constructor(eng, clip) { super(eng, clip); this.stretch = true; this.fbo = eng.gl.createFramebuffer(); this.fw = 0; this.fh = 0; }
  update(now, env, tw, th) {
    const gl = this.gl, eng = this.eng, c = this.clip, W = tw || eng.cw, H = th || eng.ch;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.fw !== W || this.fh !== H) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      this.fw = W; this.fh = H;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const p = eng.use('gen');
    const speed = +c.speed || 0;
    gl.uniform1i(p.u.u_kind, GEN_KIND[c.kind] ?? 0);
    gl.uniform1f(p.u.u_t, c.sync ? env.beat * speed : ((this.pausedAt || now) - this.t0) / 1000 * speed);   // en pause : le motif se fige
    gl.uniform1f(p.u.u_beat, env.beat);
    gl.uniform1f(p.u.u_scale, Math.max(0.05, +c.density || 1));
    gl.uniform1f(p.u.u_aspect, W / H);
    gl.uniform3fv(p.u.u_a, hexToRgb(c.colorA));
    gl.uniform3fv(p.u.u_b, hexToRgb(c.colorB));
    gl.uniform1f(p.u.u_transp, c.transp ? 1 : 0);
    eng.quad();
    this.w = W; this.h = H; this.ready = true;
  }
  dispose() { this.gl.deleteFramebuffer(this.fbo); super.dispose(); }
}

/** Flux d'une fenêtre capturée : choisi dans la régie (window.__ledStreams), relu par la sortie via la fenêtre qui l'a ouverte. */
export function directStream(id) {
  try { const s = window.__ledStreams?.[id]; if (s?.active) return s; } catch { /* pas dans la régie */ }
  try { const s = window.opener?.__ledStreams?.[id]; if (s?.active) return s; } catch { /* sortie ouverte à part */ }
  try { const s = window.parent !== window ? window.parent.__ledStreams?.[id] : null; if (s?.active) return s; } catch { /* cadre isolé */ }
  return null;
}
/** Capture du clip : lue directement quand c'est possible, sinon reçue de la régie par le relais (js/relay.js). */
export function sharedStream(id) { return directStream(id) || window.__ledRemote?.[id] || null; }

class ScreenSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    const v = this.v = document.createElement('video');
    v.playsInline = true; v.muted = true; this.watchFrames(v);
    this.stream = null; this.checked = 0;
  }
  update(now) {
    if (now - this.checked > 500) {                       // la fenêtre peut être choisie, changée ou fermée à tout moment
      this.checked = now;
      const s = sharedStream(this.clip.id), live = s && s.active ? s : null;
      if (live !== this.stream) {
        this.stream = live; this.v.srcObject = live; this.ph = false;
        if (live) this.v.play().catch(() => {}); else this.ready = false;
      }
      if (!live && !this.ph && this.eng.role === 'preview') this.placeholder();
      if (live) applyAudio(this, this.v, this.clip);        // son de la fenêtre capturée (si Chrome l'a fourni), au volume du clip
    }
    const v = this.v;
    if (this.stream && v.readyState >= 2 && v.videoWidth) { if (this.ph || this.freshFrame()) this.upload(v); this.ph = false; this.w = v.videoWidth; this.h = v.videoHeight; this.ready = true; }
  }
  /** Carton d'attente, dans la régie seulement (jamais sur le mur) : rappelle qu'il reste à choisir la fenêtre. */
  placeholder() {
    const W = this.eng.cw, H = this.eng.ch, cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#15171c'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#f0b429'; ctx.lineWidth = Math.max(2, H / 120); ctx.setLineDash([H / 30, H / 45]);
    ctx.strokeRect(H * 0.06, H * 0.1, W - H * 0.12, H * 0.8);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0b429'; ctx.font = `700 ${H * 0.085}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(this.clip.ppt ? 'PowerPoint en direct' : 'Fenêtre en direct', W / 2, H * 0.42, W * 0.8);
    ctx.fillStyle = '#ece9e2'; ctx.font = `400 ${H * 0.048}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText('Clique sur « Choisir la fenêtre à afficher »', W / 2, H * 0.55, W * 0.8);
    ctx.fillText('dans les réglages de ce clip', W / 2, H * 0.62, W * 0.8);
    this.w = W; this.h = H; this.upload(cv); this.ready = true; this.ph = true;
  }
  dispose() { this.v.srcObject = null; super.dispose(); }   // on ne coupe pas le flux : il appartient à la régie
}

/* ---------- diaporama ---------- */
const FX_NONE = { bri: 1, con: 1, sat: 1, hue: 0, inv: 0, mirror: 0, pix: 0, rgb: 0, tint: '#ffffff', tintAmt: 0, strobe: 0, pulse: 0, zoom: 0, audio: 0 };
const FRAME_NONE = { scale: 1, x: 0, y: 0, rot: 0, cropL: 0, cropR: 0, cropT: 0, cropB: 0 };
/** Ordre aléatoire reproductible : la régie et la sortie tirent le même ordre à partir du même instant de lancement. */
function shuffled(n, seed) {
  let s = (Math.floor(seed) >>> 0) || 1;
  const rnd = () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Diaporama : enchaîne images et vidéos de la médiathèque avec un fondu, dans sa propre texture.
 *  Tout se calcule à partir de l'instant de lancement (t0) : la régie et la sortie montrent la même diapositive au même moment.
 *  Une image dure `dur` secondes ; une vidéo est jouée en entier (sa durée, lue dans le fichier). */
class SlideshowSource extends Base {
  constructor(eng, clip) {
    super(eng, clip);
    this.stretch = true;
    this.fbo = eng.gl.createFramebuffer(); this.fw = 0; this.fh = 0;
    this.subs = new Map();          // index de l'entrée → source image/vidéo
    this.durs = [];                 // durée des vidéos (s), connue dès la lecture des métadonnées
    this.readyAt = {};              // index → instant où l'image a été prête (le fondu attend l'image)
    this.probes = [];
    (clip.items || []).forEach((it, i) => {
      if (it.type !== 'video') return;
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.src = it.src;
      v.addEventListener('loadedmetadata', () => { if (isFinite(v.duration) && v.duration > 0) this.durs[i] = v.duration; });
      this.probes.push(v);
    });
  }
  itemDur(i) {
    const it = this.clip.items[i], d = Math.max(0.5, +this.clip.dur || 5);
    return it.type === 'video' && this.durs[i] ? Math.max(0.5, this.durs[i]) : d;
  }
  orderFor(cycle) {
    const n = this.clip.items.length;
    if (this.clip.order !== 'random') return Array.from({ length: n }, (_, i) => i);
    if (this.ordCycle !== cycle || this.ordN !== n) { this.ordCycle = cycle; this.ordN = n; this.ord = shuffled(n, this.t0 / 1000 + cycle * 7919); }
    return this.ord;
  }
  /** Où en est le diaporama à l'instant `now` : entrée affichée, instant de son début, entrée précédente (pour le fondu). */
  where(now) {
    const c = this.clip, n = c.items.length;
    let total = 0; for (let i = 0; i < n; i++) total += this.itemDur(i);
    let el = Math.max(0, (now - this.t0) / 1000), cycle = 0, finished = false;
    if (c.end === 'loop') { cycle = Math.floor(el / total); el -= cycle * total; }
    else if (el >= total) { el = total - 1e-3; finished = true; }
    const order = this.orderFor(cycle);
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const d = this.itemDur(order[k]);
      if (el < acc + d || k === n - 1) {
        const prev = k > 0 ? order[k - 1] : (c.end === 'loop' && cycle > 0 ? this.orderFor(cycle - 1)[n - 1] : -1);
        const next = k + 1 < n ? order[k + 1] : (c.end === 'loop' ? this.orderFor(cycle + 1)[0] : -1);
        return { i: order[k], prev, next, startMs: this.t0 + (cycle * total + acc) * 1000, finished, progress: total > 0 ? (cycle * total + el) / (c.end === 'loop' ? total * (cycle + 1) : total) : 0, cycleProgress: total > 0 ? el / total : 0 };
      }
      acc += d;
    }
    return { i: order[0] ?? 0, prev: -1, next: -1, startMs: this.t0, finished, progress: 0, cycleProgress: 0 };
  }
  /** Source d'une entrée (créée au besoin) ; `startMs` ≠ null la démarre à cet instant (vidéo : lecture, calage si en retard). */
  sub(i, startMs) {
    const it = this.clip.items[i];
    let s = this.subs.get(i);
    if (!s) {
      s = createSource(this.eng, { id: this.clip.id + '#' + i, type: it.type, src: it.src, end: 'hold', hold: false, speed: 1, volume: +this.clip.volume || 0, fit: this.clip.fit });
      s.startedAt = null;
      this.subs.set(i, s);
    } else if (it.type === 'video') s.setClip({ ...s.clip, volume: +this.clip.volume || 0 });
    if (startMs != null && s.startedAt !== startMs) { s.startedAt = startMs; s.start(startMs); }
    return s;
  }
  update(now, env, tw, th) {
    const gl = this.gl, eng = this.eng, c = this.clip, W = tw || eng.cw, H = th || eng.ch, n = c.items?.length || 0;
    if (!n) { this.ready = false; return; }
    if (this.pausedAt) now = this.pausedAt;                                   // pause : le diaporama s'arrête sur la diapositive en cours
    const pos = this.where(now);
    this.prog = c.end === 'loop' ? pos.cycleProgress : pos.progress;
    const cur = this.sub(pos.i, pos.startMs);
    if (cur.ready && this.readyAt[pos.i] == null) this.readyAt[pos.i] = Math.max(pos.startMs, now - 20);
    for (const k of Object.keys(this.readyAt)) if (+k !== pos.i) delete this.readyAt[k];
    const fade = Math.max(0, +c.fade || 0) * 1000;
    const f0 = this.readyAt[pos.i] ?? now;
    const t = cur.ready ? (fade > 0 ? Math.min(1, (now - f0) / fade) : 1) : 0;    // tant que l'image n'est pas prête, la précédente reste
    const prev = t < 1 && pos.prev >= 0 && pos.prev !== pos.i ? this.sub(pos.prev, null) : null;
    // On ne garde que l'entrée affichée, celle qui s'efface et la suivante (préchargée).
    const keep = new Set([pos.i, prev ? pos.prev : -1, pos.next]);
    for (const [i, s] of this.subs) if (!keep.has(i)) { s.dispose(); this.subs.delete(i); }
    if (pos.next >= 0 && pos.next !== pos.i && !this.subs.has(pos.next)) this.sub(pos.next, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.fw !== W || this.fh !== H) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      this.fw = W; this.fh = H;
    }
    cur.pausedAt = this.pausedAt || 0;                                      // une vidéo du diaporama se met en pause avec lui
    cur.update(now, env, W, H);
    if (prev) prev.update(now, env, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);     // fondu enchaîné, comme entre deux clips
    const rect = { x: 0, y: 0, w: 1, h: 1, px: W, py: H, rot: 0, shape: 0 }, frame = { ...FRAME_NONE, fit: c.fit || 'contain' };
    if (prev && prev.ready) eng.drawSource({ src: prev }, frame, 1 - t, FX_NONE, env, rect);
    if (cur.ready && t > 0) eng.drawSource({ src: cur }, frame, t, FX_NONE, env, rect);
    gl.disable(gl.BLEND);
    this.w = W; this.h = H; this.ready = cur.ready || !!(prev && prev.ready);
    if (pos.finished && c.end === 'next' && !this.endedSent) { this.endedSent = true; eng.onEnded?.(c.id); }
  }
  progress() { return this.prog || 0; }
  dispose() {
    for (const s of this.subs.values()) s.dispose();
    this.subs.clear();
    for (const v of this.probes) { v.removeAttribute('src'); v.load(); }
    this.gl.deleteFramebuffer(this.fbo);
    super.dispose();
  }
}

const TYPES = { video: VideoSource, image: ImageSource, slideshow: SlideshowSource, camera: CameraSource, doc: DocSource, screen: ScreenSource, text: TextSource, gen: GenSource };

export function createSource(eng, clip) { const T = TYPES[clip.type]; return T ? new T(eng, clip) : null; }
/** Ce qui oblige à recréer la source (le reste se règle en direct). */
export function sourceSig(clip) {
  const src = clip.type === 'slideshow' ? (clip.items || []).map(i => i.type + ':' + i.src).join(',') : (clip.src || '');
  const audio = clip.type === 'camera' && clip.audio ? '|a:' + (clip.audioDeviceId || '*') : '';      // activer le son = rouvrir la source avec sa piste audio
  return clip.type + '|' + src + '|' + (clip.deviceId || '') + '|' + (clip.doc || '') + audio;
}
