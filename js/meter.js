/* Régie LED — vumètre : niveau sonore d'un flux (caméra, fenêtre capturée) ou d'un élément <video>, mesuré sur une copie
 * du signal (captureStream) : le chemin audible (élément → périphérique de sortie) n'est pas modifié. */
let ctx = null;
/** Contexte audio partagé. Les navigateurs le laissent « suspendu » tant que l'utilisateur n'a pas cliqué dans la page. */
export function meterCtx() {
  if (!ctx) { try { ctx = new AudioContext(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const meterRunning = () => !!ctx && ctx.state === 'running';

export class Meter {
  /** input : MediaStream, ou élément média (son flux srcObject, sinon captureStream()). ok = false s'il n'y a pas de piste audio. */
  constructor(input) {
    const c = meterCtx();
    this.ok = false; this.hold = 0;
    if (!c || !input) return;
    let stream = input instanceof MediaStream ? input : null;
    if (!stream) {
      if (input.srcObject instanceof MediaStream) stream = input.srcObject;
      else if (input.captureStream) { try { stream = input.captureStream(); } catch { stream = null; } }
    }
    const tracks = stream ? stream.getAudioTracks() : [];
    if (!tracks.length) return;
    try {
      this.stream = new MediaStream([tracks[0]]);
      this.src = c.createMediaStreamSource(this.stream);
      this.an = c.createAnalyser(); this.an.fftSize = 512; this.an.smoothingTimeConstant = 0;
      this.src.connect(this.an);                       // analyse seulement : rien n'est renvoyé vers les haut-parleurs
      this.buf = new Float32Array(this.an.fftSize);
      this.ok = true;
    } catch { this.ok = false; }
  }
  /** Niveau 0..1 sur une échelle en dB (−60 dB → 0, 0 dB → 1), avec une descente lissée. */
  level() {
    if (!this.ok || !meterRunning()) return 0;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(s / this.buf.length), db = 20 * Math.log10(rms || 1e-6), v = Math.min(1, Math.max(0, (db + 60) / 60));
    this.hold = v > this.hold ? v : this.hold * 0.85;
    return this.hold;
  }
  dispose() { try { this.src?.disconnect(); } catch { /* déjà libéré */ } this.ok = false; }
}
