/* Régie LED — moteur de rendu WebGL2, identique dans la régie (aperçu) et dans la fenêtre de sortie.
 *
 * À chaque image :
 *   1. chaque calque est dessiné dans un tampon (clip sortant + clip entrant = fondu enchaîné, effets du calque) ;
 *   2. les calques sont empilés dans la « composition » selon leur mode de mélange et leur opacité ;
 *   3. present('comp')   affiche la composition telle quelle (aperçu) ;
 *      present('output') découpe la composition en zones et pose chaque zone sur la sortie HDMI (mapping).
 */
import { transitionCode, hexToRgb, sliceMatrix, SHAPE_INDEX, shapePoints, shapeGroups, validPoly, fullQuad, zoneQuad, zonePoint, squareToQuad, newClip, isTimerClip, RETOUR_TIMER } from './model.js';
import { createSource, sourceSig } from './sources.js';

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.,1.); }`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_size, u_off;
uniform vec4 u_rect;
uniform vec4 u_crop;
uniform vec2 u_res;
uniform float u_rrot;
uniform int u_zshape;
uniform int u_zq; uniform vec3 u_zh0, u_zh1, u_zh2;   // zone à coins libres : composition (y vers le bas) → carré de la zone
uniform sampler2D u_mask;                           // forme libre (u_zshape == 6) : masque dessiné à la main
uniform float u_rot, u_aspect, u_alpha, u_beat, u_audio;
uniform float u_bri, u_con, u_sat, u_hue, u_inv, u_pix, u_rgb, u_strobe, u_pulse, u_zoom, u_audioAmt, u_tintAmt;
uniform int u_mirror;
uniform vec3 u_tint;
uniform int u_tr; uniform float u_trT, u_trIn;      // transition en cours : type (1 volet →, 2 volet ↓, 3 glisser, 4 iris, 5 zoom), avancement 0..1, 1 = image entrante
vec3 hueRot(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca = cos(a), sa = sin(a); return c*ca + cross(k,c)*sa + k*dot(k,c)*(1.-ca); }
vec4 samp(vec2 uv){
  vec2 p = uv - 0.5 - u_off;
  p.x *= u_aspect; float c = cos(u_rot), s = sin(u_rot); p = vec2(c*p.x + s*p.y, -s*p.x + c*p.y); p.x /= u_aspect;
  vec2 t = p/u_size + 0.5;
  if (t.x < 0. || t.x > 1. || t.y < 0. || t.y > 1.) return vec4(0.);
  vec4 col = texture(u_tex, mix(u_crop.xy, u_crop.zw, t));     // rognage du clip (0,0,1,1 = image entière)
  return vec4(col.rgb*col.a, col.a);
}
void main(){
  vec2 uv;
  if (u_zq == 1) {                                    // zone à coins libres : homographie inverse vers le carré de la zone
    vec3 hp = vec3(v_uv.x, 1. - v_uv.y, 1.), hq = vec3(dot(u_zh0, hp), dot(u_zh1, hp), dot(u_zh2, hp));
    if (hq.z <= 1e-7) { o = vec4(0.); return; }
    uv = vec2(hq.x/hq.z, 1. - hq.y/hq.z);
  }
  else if (u_rrot != 0.) {                            // zone tournée (écran en losange) : repère local de la zone
    vec2 ps = (v_uv - (u_rect.xy + u_rect.zw*0.5))*u_res; ps.y = -ps.y;
    float cr = cos(u_rrot), sr = sin(u_rrot);
    vec2 l = vec2(cr*ps.x + sr*ps.y, -sr*ps.x + cr*ps.y);
    uv = vec2(l.x/(u_rect.z*u_res.x) + 0.5, 0.5 - l.y/(u_rect.w*u_res.y));
  } else uv = (v_uv - u_rect.xy)/u_rect.zw;          // zone cible du calque (toute l'image : 0,0,1,1)
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) { o = vec4(0.); return; }
  if (u_zshape > 0) {                                 // forme de l'écran : le calque est découpé à cette forme
    vec2 zm = abs(uv - 0.5); float vd = 1. - uv.y;
    if ((u_zshape == 1 && zm.x + zm.y > 0.5) || (u_zshape == 2 && dot(zm*2., zm*2.) > 1.) || (u_zshape == 3 && zm.x > vd*0.5)
      || (u_zshape == 4 && zm.x > (1. - vd)*0.5) || (u_zshape == 5 && zm.y > 0.5 - 0.5*zm.x)) { o = vec4(0.); return; }
    if (u_zshape == 6 && texture(u_mask, uv).r < 0.5) { o = vec4(0.); return; }
  }
  if (u_tr > 0) {                                     // transitions dans le repère de la zone (uv 0..1, y vers le haut)
    float e = u_trT*u_trT*(3. - 2.*u_trT);           // départ et arrivée en douceur
    if (u_tr == 1) { if ((u_trIn > 0.5) != (uv.x < e)) { o = vec4(0.); return; } }
    else if (u_tr == 2) { if ((u_trIn > 0.5) != (uv.y > 1. - e)) { o = vec4(0.); return; } }
    else if (u_tr == 3) { uv.x += u_trIn > 0.5 ? e - 1. : e; if (uv.x < 0. || uv.x > 1.) { o = vec4(0.); return; } }
    else if (u_tr == 4) {
      vec2 d = (uv - 0.5)*vec2(u_aspect, 1.); float R = e*0.5*length(vec2(u_aspect, 1.)) * 1.02;
      if ((u_trIn > 0.5) != (length(d) < R)) { o = vec4(0.); return; }
    }
    else if (u_tr == 5) { float k = u_trIn > 0.5 ? mix(0.55, 1., e) : mix(1., 1.6, e); uv = (uv - 0.5)/k + 0.5; if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) { o = vec4(0.); return; } }
  }
  float bp = fract(u_beat);
  uv = (uv - 0.5)/(1. + u_zoom*0.3*pow(1.-bp, 3.)) + 0.5;
  if (u_mirror == 1 || u_mirror == 3) uv.x = 0.5 - abs(uv.x - 0.5);
  if (u_mirror == 2 || u_mirror == 3) uv.y = 0.5 + abs(uv.y - 0.5);
  if (u_mirror == 4) {
    vec2 p = uv - 0.5; p.x *= u_aspect;
    float seg = 6.2831853/8., a = mod(atan(p.y, p.x), seg); a = abs(a - seg*0.5);
    p = length(p)*vec2(cos(a), sin(a)); p.x /= u_aspect; uv = p + 0.5;
  }
  if (u_pix > 0.) { float n = mix(160., 6., u_pix); vec2 g = vec2(n*u_aspect, n); uv = (floor(uv*g) + 0.5)/g; }
  vec4 c;
  if (u_rgb > 0.) {
    float d = u_rgb*0.04; vec4 a = samp(uv + vec2(d,0.)), b = samp(uv), e = samp(uv - vec2(d,0.));
    c = vec4(a.r, b.g, e.b, max(max(a.a, b.a), e.a));
  } else c = samp(uv);
  vec3 rgb = c.a > 0. ? c.rgb/c.a : vec3(0.);
  if (u_hue != 0.) rgb = hueRot(rgb, u_hue*6.2831853);
  float l = dot(rgb, vec3(.2126,.7152,.0722));
  rgb = mix(vec3(l), rgb, u_sat);
  rgb = (rgb - 0.5)*u_con + 0.5;
  rgb = mix(rgb, 1. - rgb, u_inv);
  rgb = mix(rgb, l*u_tint*1.4, u_tintAmt);
  float gain = u_bri;
  gain *= mix(1., 0.15 + 1.7*u_audio, u_audioAmt);
  gain *= mix(1., 0.25 + 1.25*pow(1.-bp, 2.), u_pulse);
  rgb = clamp(rgb*gain, 0., 1.);
  float al = c.a*u_alpha;
  if (u_strobe > 0.) al *= step(fract(u_beat*u_strobe), 0.5);
  o = vec4(rgb*al, al);
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex; uniform float u_mul, u_alpha;
void main(){ vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb*u_mul, c.a)*u_alpha; }`;

const FRAG_MAP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex, u_mask; uniform vec3 u_h0, u_h1, u_h2; uniform vec4 u_src; uniform vec2 u_res; uniform float u_mul, u_rot; uniform int u_shape;
uniform int u_sq; uniform vec3 u_sh0, u_sh1, u_sh2;          // zone à coins libres : carré de la zone → composition
void main(){
  vec3 p = vec3(v_uv.x, 1. - v_uv.y, 1.);
  vec3 q = vec3(dot(u_h0,p), dot(u_h1,p), dot(u_h2,p));
  if (q.z <= 1e-7) discard;
  vec2 uv = q.xy/q.z;
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) discard;
  vec2 m = abs(uv - 0.5);                                   // forme de l'écran
  if (u_shape == 1 && m.x + m.y > 0.5) discard;
  if (u_shape == 2 && dot(m*2., m*2.) > 1.) discard;
  if (u_shape == 3 && m.x > uv.y*0.5) discard;
  if (u_shape == 4 && m.x > (1. - uv.y)*0.5) discard;
  if (u_shape == 5 && m.y > 0.5 - 0.5*m.x) discard;
  if (u_shape == 6 && texture(u_mask, vec2(uv.x, 1. - uv.y)).r < 0.5) discard;   // forme libre : masque (v vers le haut)
  vec2 c = u_src.xy + uv*u_src.zw;
  if (u_sq == 1) { vec3 sp = vec3(uv, 1.), sr = vec3(dot(u_sh0, sp), dot(u_sh1, sp), dot(u_sh2, sp)); c = sr.xy/sr.z; }
  else if (u_rot != 0.) {
    vec2 d = (uv - 0.5)*u_src.zw*u_res; float cr = cos(u_rot), sr = sin(u_rot);
    c = (u_src.xy + u_src.zw*0.5) + vec2(cr*d.x - sr*d.y, sr*d.x + cr*d.y)/u_res;
    if (c.x < 0. || c.x > 1. || c.y < 0. || c.y > 1.) discard;
  }
  o = vec4(texture(u_tex, vec2(c.x, 1. - c.y)).rgb*u_mul, 1.);
}`;

const FRAG_GEN = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform int u_kind; uniform float u_t, u_beat, u_scale, u_aspect, u_transp; uniform vec3 u_a, u_b;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv = v_uv; vec2 p = (uv - 0.5)*vec2(u_aspect, 1.); float m = 1.;
  if (u_kind == 1) m = 0.5 + 0.5*sin(6.2831853*(uv.x*u_scale*0.5 + uv.y*0.25 - u_t*0.15));
  else if (u_kind == 2) m = smoothstep(0.48, 0.52, abs(fract(p.x*u_scale*3. - u_t*0.5) - 0.5)*2.);
  else if (u_kind == 3) m = smoothstep(0.48, 0.52, abs(fract(p.y*u_scale*3. - u_t*0.5) - 0.5)*2.);
  else if (u_kind == 4) {
    float s = u_scale*3., t = u_t;
    float v = sin(p.x*s + t) + sin(p.y*s*1.3 + t*1.3) + sin((p.x + p.y)*s*0.8 + t*0.7) + sin(length(p)*s*2. - t*1.5);
    m = 0.5 + 0.5*sin(v*1.6);
  }
  else if (u_kind == 5) m = smoothstep(0.45, 0.55, abs(fract(length(p)*u_scale*3. - u_t*0.5) - 0.5)*2.);
  else if (u_kind == 6) { vec2 g = floor(p*u_scale*4. + vec2(u_t*0.5, 0.)); m = mod(g.x + g.y, 2.); }
  else if (u_kind == 7) m = hash(floor(uv*vec2(u_aspect,1.)*90.*u_scale) + floor(u_t*24.)*7.13);
  else if (u_kind == 8) m = pow(1. - fract(u_beat), 4.);
  else if (u_kind == 9) { float x = fract(u_t*0.25)*1.3 - 0.15; m = smoothstep(0.12/u_scale, 0., abs(uv.x - x)); }
  float a = u_transp > 0.5 ? m : 1.;
  vec3 col = u_transp > 0.5 ? u_a : mix(u_b, u_a, m);
  o = vec4(col, a);
}`;

const FULL_FRAME = { scale: 1, x: 0, y: 0, rot: 0 };
const NO_FX = { bri: 1, con: 1, sat: 1, hue: 0, inv: 0, mirror: 0, pix: 0, rgb: 0, tint: '#ffffff', tintAmt: 0, strobe: 0, pulse: 0, zoom: 0, audio: 0 };

export class Engine {
  /** role : 'output' (fenêtre de sortie, pleine résolution, son) ou 'preview' (aperçu de la régie, allégé). */
  constructor({ role = 'preview', maxW = 0 } = {}) {
    this.role = role; this.maxW = maxW;
    const canvas = this.canvas = document.createElement('canvas');
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 indisponible sur ce navigateur.');
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    this.progs = {};
    for (const [name, frag] of Object.entries({ src: FRAG_SRC, blit: FRAG_BLIT, map: FRAG_MAP, gen: FRAG_GEN })) this.progs[name] = this.program(frag);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.sources = new Map();       // clipId → {src, sig, used}
    this.rt = {};                   // layerId → état de lecture du calque
    this.cw = 0; this.ch = 0;
    this.audio = 0.5;               // niveau sonore 0..1 (0,5 = neutre tant que le micro est coupé)
    this.sinkId = '';               // périphérique de sortie du son (fenêtre de sortie ; '' = celui du Mac)
    this.hideLayers = null;         // Set d'ids de calques à ne pas rendre (sortie secondaire : retour, autre salle) ; null = tous
    this.silent = false;            // sortie secondaire : jamais de son (le son ne sort que par la sortie principale)
    this.master = 1; this.fps = 0; this._frames = 0; this._fpsT = performance.now(); this._last = performance.now();
    this.mire = { cv: document.createElement('canvas'), tex: this.newTex(), sig: '' };
    this.masks = new Map();                                     // zoneId → {sig, tex} : masque d'une forme libre (dessinée à la main)
    const bt = this.newTex();                                   // 1 pixel noir opaque : le « fond noir » d'une zone
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.black = { src: { tex: bt, w: 1, h: 1, stretch: true } };
  }

  program(frag) {
    const gl = this.gl, p = gl.createProgram();
    for (const [type, text] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
      const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader : ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Programme : ' + gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  use(name) { const pr = this.progs[name]; this.gl.useProgram(pr.p); return pr; }
  quad() { const gl = this.gl; gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
  newTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  }
  target(w, h) {
    const gl = this.gl, tex = this.newTex(), fbo = gl.createFramebuffer();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }

  setState(show, live) { this.show = show; this.live = live; }

  ensureSize() {
    const { comp } = this.show, gl = this.gl;
    const k = this.maxW && comp.w > this.maxW ? this.maxW / comp.w : 1;
    const w = Math.max(16, Math.round(comp.w * k)), h = Math.max(16, Math.round(comp.h * k));
    if (w === this.cw && h === this.ch) return;
    for (const t of [this.compT, this.layerT]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.cw = w; this.ch = h;
    this.compT = this.target(w, h); this.layerT = this.target(w, h);
    this.mire.sig = '';
  }

  source(clipId, now, clipObj) {
    const clip = clipObj || this.show.clips[clipId];
    if (!clip) return null;
    const sig = sourceSig(clip);
    let e = this.sources.get(clipId);
    if (e && e.sig !== sig) { e.src.dispose(); this.sources.delete(clipId); e = null; }
    if (!e) {
      const src = createSource(this, clip);
      if (!src) return null;
      e = { src, sig, used: now, stamp: -1 };
      this.sources.set(clipId, e);
    } else e.src.setClip(clip);
    e.used = now;
    return e;
  }

  /** Rapproche l'état de lecture de chaque calque de ce que demande `live` (lancement, fondu, arrêt). */
  /** Calques à rendre : ceux de la scène que l'état de lecture désigne (live.sceneId), sinon la scène en cours d'édition. */
  layers() { const { show, live } = this; return (live?.sceneId && show.scenes?.find(s => s.id === live.sceneId)?.layers) || show.layers; }
  syncLayers(now) {
    const { show, live } = this, layers = this.layers();
    for (const layer of layers) {
      const L = live.layers?.[layer.id] || { clipId: null, t0: 0 };
      const rt = this.rt[layer.id] || (this.rt[layer.id] = { cur: null, prev: null, key: null, fade: 0, fadeT0: 0, started: true });
      const clipId = L.clipId && show.clips[L.clipId] ? L.clipId : null;
      const key = clipId + '@' + L.t0;
      if (key === rt.key) continue;
      const first = rt.key === null;
      rt.key = key;
      if (rt.cur && rt.cur.clipId === clipId) { this.source(clipId, now)?.src.start(L.t0); continue; }   // relance du même clip
      rt.prev = rt.started ? rt.cur : rt.prev;
      rt.cur = clipId ? { clipId } : null;
      rt.t0 = L.t0;
      rt.fade = Math.max(0, +(L.fade ?? layer.fade ?? 0.5)) * 1000;
      rt.tr = L.tr || 'fade';
      rt.started = false;
      rt.late = first || now - L.t0 > rt.fade + 2500;      // fenêtre ouverte en cours de show : pas de fondu
      if (rt.cur) this.source(clipId, now)?.src.start(L.t0);
    }
    for (const id of Object.keys(this.rt)) if (!layers.some(l => l.id === id)) delete this.rt[id];
  }

  /** Masque d'une forme libre : le polygone dessiné, blanc sur noir, dans une texture (ligne 0 = haut de la zone, retournée à l'envoi). */
  maskTex(z) {
    if (z.shape !== 'libre' || !validPoly(z.poly)) return null;
    const gl = this.gl, sig = JSON.stringify([z.poly, z.extra || null]) + '|' + Math.round(z.src.w) + 'x' + Math.round(z.src.h);
    let m = this.masks.get(z.id);
    if (m && m.sig === sig) return m.tex;
    if (!m) { m = { sig: '', tex: this.newTex(), cv: document.createElement('canvas') }; this.masks.set(z.id, m); }
    m.sig = sig;
    const W = Math.max(64, Math.min(1024, Math.round(z.src.w))), H = Math.max(64, Math.min(1024, Math.round(z.src.h))), cv = m.cv, ctx = cv.getContext('2d');
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (const g of shapeGroups(z)) { ctx.beginPath(); g.forEach(([u, v], j) => ctx[j ? 'lineTo' : 'moveTo'](u * W, v * H)); ctx.closePath(); ctx.fill(); }   // union des formes collées
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, m.tex);         // unité 1 : ne touche pas à la texture en cours sur l'unité 0
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.activeTexture(gl.TEXTURE0);
    for (const id of this.masks.keys()) if (!this.show.slices.some(x => x.id === id)) { gl.deleteTexture(this.masks.get(id).tex); this.masks.delete(id); }
    return m.tex;
  }
  /** Programme map : la zone source est-elle un quadrilatère (coins libres dans la composition) ? */
  srcQuad(u, z) {
    const gl = this.gl, q = zoneQuad(z);
    gl.uniform1i(u.u_sq, q ? 1 : 0);
    if (!q) return;
    const { comp } = this.show, m = squareToQuad(q.map(([x, y]) => [x / comp.w, y / comp.h]));
    gl.uniform3f(u.u_sh0, m[0], m[1], m[2]); gl.uniform3f(u.u_sh1, m[3], m[4], m[5]); gl.uniform3f(u.u_sh2, m[6], m[7], m[8]);
  }
  /** Lie le masque d'une zone à l'unité de texture 1 (programme src ou map). */
  bindMask(u, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex || this.black.src.tex); gl.uniform1i(u.u_mask, 1);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Zone cible d'un calque : rectangle de la composition (px) ou null pour toute l'image. */
  zoneRect(layer, clip) {
    const id = clip?.zone === 'all' ? '' : (clip?.zone || layer.zone || '');
    const z = id && this.show.slices.find(x => x.id === id);
    if (!z) return null;
    const { comp } = this.show;
    const mask = this.maskTex(z), q = zoneQuad(z), shape = z.shape === 'libre' ? (mask ? 6 : 0) : (SHAPE_INDEX[z.shape] || 0);
    if (q) {                                            // coins libres : le contenu est déformé dans le quadrilatère
      const L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      return { x: z.src.x / comp.w, y: z.src.y / comp.h, w: z.src.w / comp.w, h: z.src.h / comp.h, px: (L(q[0], q[1]) + L(q[3], q[2])) / 2, py: (L(q[0], q[3]) + L(q[1], q[2])) / 2, rot: 0, shape, mask, H: sliceMatrix({ dst: q }, comp.w, comp.h) };
    }
    return { x: z.src.x / comp.w, y: z.src.y / comp.h, w: z.src.w / comp.w, h: z.src.h / comp.h, px: z.src.w, py: z.src.h, rot: (+z.src.rot || 0) * Math.PI / 180, shape, mask };
  }

  drawSource(e, clip, alpha, fx, env, rect, tr) {
    const gl = this.gl, src = e.src, p = this.use('src'), u = p.u;
    gl.uniform1i(u.u_tr, tr ? tr.code : 0); gl.uniform1f(u.u_trT, tr ? tr.t : 0); gl.uniform1f(u.u_trIn, tr?.in ? 1 : 0);
    const cl = Math.min(0.45, Math.max(0, +clip.cropL || 0)), cr = Math.min(0.45, Math.max(0, +clip.cropR || 0));
    const ct = Math.min(0.45, Math.max(0, +clip.cropT || 0)), cb = Math.min(0.45, Math.max(0, +clip.cropB || 0));
    const Ac = rect ? rect.px / rect.py : this.cw / this.ch, As = (src.w * (1 - cl - cr)) / (src.h * (1 - ct - cb)) || Ac;
    let sx = 1, sy = 1;
    const fit = src.stretch ? 'stretch' : clip.fit;
    if (fit === 'contain') { if (As > Ac) sy = Ac / As; else sx = As / Ac; }
    else if (fit !== 'stretch') { if (As > Ac) sx = As / Ac; else sy = Ac / As; }
    const k = Math.max(0.01, +clip.scale || 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(u.u_tex, 0);
    if (rect) gl.uniform4f(u.u_rect, rect.x, 1 - rect.y - rect.h, rect.w, rect.h); else gl.uniform4f(u.u_rect, 0, 0, 1, 1);
    gl.uniform2f(u.u_res, this.cw, this.ch); gl.uniform1f(u.u_rrot, rect ? rect.rot : 0); gl.uniform1i(u.u_zshape, rect ? rect.shape : 0);
    const H = rect?.H; gl.uniform1i(u.u_zq, H ? 1 : 0);
    if (H) { gl.uniform3f(u.u_zh0, H[0], H[1], H[2]); gl.uniform3f(u.u_zh1, H[3], H[4], H[5]); gl.uniform3f(u.u_zh2, H[6], H[7], H[8]); }
    this.bindMask(u, rect?.mask);
    gl.uniform4f(u.u_crop, cl, cb, 1 - cr, 1 - ct);
    gl.uniform2f(u.u_size, sx * k, sy * k);
    gl.uniform2f(u.u_off, (+clip.x || 0) * 0.5, -(+clip.y || 0) * 0.5);
    gl.uniform1f(u.u_rot, (+clip.rot || 0) * Math.PI / 180);
    gl.uniform1f(u.u_aspect, Ac);
    gl.uniform1f(u.u_alpha, alpha);
    gl.uniform1f(u.u_beat, env.beat); gl.uniform1f(u.u_audio, env.audio);
    gl.uniform1f(u.u_bri, fx.bri); gl.uniform1f(u.u_con, fx.con); gl.uniform1f(u.u_sat, fx.sat); gl.uniform1f(u.u_hue, fx.hue);
    gl.uniform1f(u.u_inv, fx.inv); gl.uniform1f(u.u_pix, fx.pix); gl.uniform1f(u.u_rgb, fx.rgb);
    gl.uniform1f(u.u_strobe, +fx.strobe || 0); gl.uniform1f(u.u_pulse, fx.pulse); gl.uniform1f(u.u_zoom, fx.zoom);
    gl.uniform1f(u.u_audioAmt, fx.audio); gl.uniform1f(u.u_tintAmt, fx.tintAmt);
    gl.uniform1i(u.u_mirror, +fx.mirror || 0);
    gl.uniform3fv(u.u_tint, hexToRgb(fx.tint));
    this.quad();
  }

  /** Calcule la composition du moment. À appeler une fois par image, avant present(). */
  frame() {
    if (!this.show || this.lost) return;
    const gl = this.gl, { show, live } = this, now = Date.now(), pnow = performance.now();
    const dt = Math.min(0.25, (pnow - this._last) / 1000); this._last = pnow;
    this._frames++;
    if (pnow - this._fpsT >= 1000) { this.fps = Math.round(this._frames * 1000 / (pnow - this._fpsT)); this._frames = 0; this._fpsT = pnow; }
    this.ensureSize();
    this.syncLayers(now);
    const env = { beat: (now - (live.beat0 || 0)) / 60000 * (show.bpm || 120), audio: this.audio };
    this.stamp = (this.stamp || 0) + 1;
    const prep = (id, rect) => {
      const e = this.source(id, now);
      const tw = rect ? Math.max(2, Math.round(rect.w * this.cw)) : this.cw, th = rect ? Math.max(2, Math.round(rect.h * this.ch)) : this.ch;
      if (e && e.stamp !== this.stamp) { e.stamp = this.stamp; e.src.update(now, env, tw, th); }
      return e;
    };

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.compT.fbo);
    gl.viewport(0, 0, this.cw, this.ch);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);

    for (const layer of this.layers()) {
      if (this.hideLayers?.has(layer.id)) continue;                                          // calque masqué sur cette sortie : pas dessiné (son état de lecture continue)
      const rt = this.rt[layer.id];
      if (!rt || (!rt.cur && !rt.prev)) continue;                                            // calque vide : rien à dessiner (même avec « Fond noir »)
      const opaqueRect = layer.opaque && layer.zone ? this.zoneRect(layer, null) : null;   // la zone cache ce qui est derrière, tant qu'un clip y joue
      const curClip = rt.cur && show.clips[rt.cur.clipId], prevClip = rt.prev && show.clips[rt.prev.clipId];
      const curRect = curClip ? this.zoneRect(layer, curClip) : null, prevRect = prevClip ? this.zoneRect(layer, prevClip) : null;
      const cur = rt.cur ? prep(rt.cur.clipId, curRect) : null;
      if (cur) cur.src.pausedAt = +(live.layers?.[layer.id]?.pausedAt) || 0;      // clip en pause (compte à rebours, vidéo…) : l'horloge de la source s'arrête à cet instant
      const prev = rt.prev ? prep(rt.prev.clipId, prevRect) : null;
      if (!rt.started && (!rt.cur || !cur || cur.src.ready || cur.src.error || now - rt.t0 > 4000)) {
        rt.started = true;
        rt.fadeT0 = rt.late ? rt.t0 : Math.max(rt.t0, now - 20);     // le fondu démarre quand l'image est prête
      }
      let t = 0;
      if (rt.started) t = rt.fade > 0 ? Math.min(1, (now - rt.fadeT0) / rt.fade) : 1;
      if (rt.started && t >= 1) rt.prev = null;
      // Le son suit le fondu : le clip qui s'efface baisse, celui qui arrive monte (appliqué par la source à l'image suivante).
      if (prev) prev.src.gain = rt.prev ? 1 - t : 0;
      if (cur) cur.src.gain = rt.started ? t : 0;
      if (layer.mute || layer.opacity <= 0) { if (cur) cur.src.gain = 0; if (prev) prev.src.gain = 0; continue; }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerT.fbo);
      gl.viewport(0, 0, this.cw, this.ch);
      gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      // Fond noir à la forme de la zone : apparaît avec le clip (fondu d'entrée) et disparaît avec lui (fondu de sortie).
      const blackA = rt.prev ? (rt.cur ? 1 : 1 - t) : (rt.cur ? t : 0);
      if (opaqueRect && blackA > 0) this.drawSource(this.black, FULL_FRAME, blackA, NO_FX, env, opaqueRect);
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
      const fx = layer.fx || NO_FX;
      // Transition : simple fondu d'opacité, « par le noir » (l'ancienne descend puis la nouvelle monte), ou effet géométrique
      // (volet, glisser, iris, zoom) calculé par le shader ; un clip qui arrive sur un calque vide ou qui le quitte fond toujours.
      const both = !!(rt.prev && rt.cur), code = both ? transitionCode(rt.tr) : 0;
      let aOut = 1 - t, aIn = t;
      if (both && rt.tr === 'dip') { aOut = Math.max(0, 1 - 2 * t); aIn = Math.max(0, 2 * t - 1); }
      else if (code && code !== 5) { aOut = 1; aIn = 1; }
      const trOut = code && t < 1 ? { code, t, in: false } : null, trIn = code && t < 1 ? { code, t, in: true } : null;
      if (prev && prev.src.ready && rt.prev && t < 1 && aOut > 0) this.drawSource(prev, prevClip, aOut, fx, env, prevRect, trOut);
      if (cur && cur.src.ready && t > 0 && aIn > 0) this.drawSource(cur, curClip, aIn, fx, env, curRect, trIn);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.compT.fbo);
      gl.viewport(0, 0, this.cw, this.ch);
      if (layer.blend === 'add') gl.blendFunc(gl.ONE, gl.ONE);
      else if (layer.blend === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      else if (layer.blend === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const b = this.use('blit');
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.layerT.tex); gl.uniform1i(b.u.u_tex, 0);
      gl.uniform1f(b.u.u_mul, 1); gl.uniform1f(b.u.u_alpha, Math.min(1, layer.opacity));
      this.quad();
    }
    gl.disable(gl.BLEND);

    // Sources qui ne servent plus : son coupé tout de suite, puis libérées (vidéo arrêtée, caméra relâchée).
    for (const [id, e] of this.sources) {
      if (e.stamp !== this.stamp && e.src.v && !e.src.v.muted) e.src.v.muted = true;
      if (now - e.used > 1500) { e.src.dispose(); this.sources.delete(id); }
    }

    const target = live.blackout ? 0 : (show.master?.opacity ?? 1);
    this.master += (target - this.master) * Math.min(1, dt * 10);
    if (Math.abs(target - this.master) < 0.002) this.master = target;
  }

  /** Mire de réglage : grille + nom et cadre de chaque zone, dessinée à la place de la composition. */
  mireTex() {
    const { show } = this, m = this.mire, W = this.cw, H = this.ch;
    const sig = W + 'x' + H + JSON.stringify(show.slices.map(z => [z.name, z.on, z.src, z.shape, z.poly, z.extra, z.quad])) + show.comp.w;   // z.src inclut rot
    if (sig === m.sig) return m.tex;
    m.sig = sig;
    const cv = m.cv, ctx = cv.getContext('2d'), k = W / show.comp.w;
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#101014'; ctx.fillRect(0, 0, W, H);
    const step = Math.max(8, Math.round(100 * k));
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath();
    for (let x = 0; x <= W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, 3 * k);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.moveTo(W, 0); ctx.lineTo(0, H); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.3, 0, 7); ctx.stroke();
    const bars = ['#ffffff', '#ffe600', '#00e5ff', '#00d44a', '#ff3bd4', '#ff2a2a', '#2a55ff'];
    bars.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(W * (0.25 + i * 0.5 / bars.length), H * 0.46, W * 0.5 / bars.length + 1, H * 0.08); });
    const cols = ['#ffb300', '#00c2ff', '#ff4d6d', '#5ad65a', '#c77dff', '#ff8c42', '#f5f5f5'];
    show.slices.forEach((z, i) => {
      if (!z.on) return;
      const x = z.src.x * k, y = z.src.y * k, w = z.src.w * k, h = z.src.h * k, c = cols[i % cols.length];
      ctx.save();
      const zq = zoneQuad(z);
      if (z.src.rot && !zq) { ctx.translate(x + w / 2, y + h / 2); ctx.rotate(z.src.rot * Math.PI / 180); ctx.translate(-(x + w / 2), -(y + h / 2)); }
      for (const g of shapeGroups(z)) {
        ctx.beginPath();
        g.forEach(([u, v], j) => { const pt = zq ? zonePoint(z, u, v).map(t => t * k) : [x + u * w, y + v * h]; ctx[j ? 'lineTo' : 'moveTo'](pt[0], pt[1]); });
        ctx.closePath();
        ctx.globalAlpha = 0.16; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = c; ctx.lineWidth = Math.max(2, 6 * k); ctx.stroke();
      }
      const fs = Math.max(10, Math.min(w / 8, h / 4));
      ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${fs}px "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText((i + 1) + ' · ' + z.name, x + w / 2, y + h / 2 - fs * 0.35, w * 0.94);
      ctx.font = `400 ${fs * 0.45}px "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText(Math.round(z.src.w) + ' × ' + Math.round(z.src.h) + ' px' + (z.src.rot ? ' · ' + z.src.rot + '°' : ''), x + w / 2, y + h / 2 + fs * 0.55, w * 0.94);
      ctx.restore();
    });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return m.tex;
  }

  /** Dessine dans le canvas (coin bas-gauche, w×h px) la vue 'comp', la vue 'output' (mapping appliqué) ou 'zone' (une zone en plein cadre).
   *  opts.fit : garde les proportions (bandes noires) — sorties secondaires qui remplissent un écran quelconque ; opts.zone : la zone pour 'zone'. */
  present(view, w, h, opts = {}) {
    if (!this.show || this.lost || !this.compT) return;
    const gl = this.gl, { show, live } = this;
    const test = !!live.test, tex = test ? this.mireTex() : this.compT.tex, mul = test ? 1 : this.master;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (view === 'zone' && opts.zone) {                 // une zone de la composition, en plein cadre (retour conférenciers…)
      const z = opts.zone, ar = z.src.w / Math.max(1, z.src.h), k = Math.min(w / z.src.w, h / z.src.h);
      const vw = Math.max(1, Math.round(opts.fit === false ? w : Math.min(w, Math.round(h * ar)))), vh = Math.max(1, Math.round(opts.fit === false ? h : Math.min(h, Math.round(w / ar))));
      const vx = Math.floor((w - vw) / 2), vy = Math.floor((h - vh) / 2); void k;
      gl.viewport(vx, vy, vw, vh); gl.scissor(vx, vy, vw, vh);
      const p = this.use('map'), u = p.u, { comp } = show, m = sliceMatrix({ dst: fullQuad(vw, vh) }, vw, vh), mask = this.maskTex(z);
      gl.uniform1i(u.u_tex, 0); gl.uniform1f(u.u_mul, mul);
      gl.uniform3f(u.u_h0, m[0], m[1], m[2]); gl.uniform3f(u.u_h1, m[3], m[4], m[5]); gl.uniform3f(u.u_h2, m[6], m[7], m[8]);
      gl.uniform4f(u.u_src, z.src.x / comp.w, z.src.y / comp.h, z.src.w / comp.w, z.src.h / comp.h);
      gl.uniform2f(u.u_res, comp.w, comp.h); gl.uniform1f(u.u_rot, (+z.src.rot || 0) * Math.PI / 180);
      gl.uniform1i(u.u_shape, z.shape === 'libre' ? (mask ? 6 : 0) : (SHAPE_INDEX[z.shape] || 0));
      this.bindMask(u, mask); this.srcQuad(u, z);
      this.quad();
      gl.disable(gl.SCISSOR_TEST); return;
    }
    if (view === 'comp' && opts.fit) {                 // toute la composition, proportions gardées, centrée
      const ar = show.comp.w / show.comp.h, vw = Math.min(w, Math.round(h * ar)), vh = Math.min(h, Math.round(w / ar)), vx = Math.floor((w - vw) / 2), vy = Math.floor((h - vh) / 2);
      gl.viewport(vx, vy, vw, vh); gl.scissor(vx, vy, vw, vh);
    }
    if (view === 'comp' || !show.customOut) {          // sortie verrouillée : identique à la composition
      const b = this.use('blit');
      gl.uniform1i(b.u.u_tex, 0); gl.uniform1f(b.u.u_mul, mul); gl.uniform1f(b.u.u_alpha, 1);
      this.quad();
    } else {
      const p = this.use('map'), u = p.u, { comp, output } = show;
      gl.uniform1i(u.u_tex, 0); gl.uniform1f(u.u_mul, mul);
      for (const z of show.slices) {
        if (!z.on) continue;
        const m = sliceMatrix(z, output.w, output.h);
        if (!m) continue;
        gl.uniform3f(u.u_h0, m[0], m[1], m[2]); gl.uniform3f(u.u_h1, m[3], m[4], m[5]); gl.uniform3f(u.u_h2, m[6], m[7], m[8]);
        gl.uniform4f(u.u_src, z.src.x / comp.w, z.src.y / comp.h, z.src.w / comp.w, z.src.h / comp.h);
        gl.uniform2f(u.u_res, comp.w, comp.h); gl.uniform1f(u.u_rot, (+z.src.rot || 0) * Math.PI / 180);
        const mask = this.maskTex(z);
        gl.uniform1i(u.u_shape, z.shape === 'libre' ? (mask ? 6 : 0) : (SHAPE_INDEX[z.shape] || 0));
        this.bindMask(u, mask); this.srcQuad(u, z);
        this.quad();
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Écran retour (sortie en mode « retour ») : quels clips montrer. Le visuel = le clip marqué « retour » lancé en dernier à la
   *  sortie (PowerPoint, affiche, vidéo…), sinon l'affiche de repos de cette sortie ; le chrono = l'horloge ou le compte à rebours
   *  marqué « retour » lancé en dernier. Ne dépend ni des zones ni des calques : le conférencier voit le fichier en entier. */
  retourPick(o) {
    const { show } = this;
    let main = null, timer = null;
    for (const layer of this.layers()) {
      const rt = this.rt[layer.id], id = rt?.cur?.clipId, c = id && show.clips[id];
      if (!c?.retour) continue;
      const t0 = +rt.t0 || 0;
      if (isTimerClip(c)) { if (!timer || t0 >= timer.t0) timer = { id, t0, pausedAt: +(this.live.layers?.[layer.id]?.pausedAt) || 0 }; }
      else if (!main || t0 >= main.t0) main = { id, t0 };
    }
    return { main: main?.id || null, timer: timer || null };
  }
  /** Affiche de repos d'un écran retour : un fichier de la médiathèque, joué par une source à part (il n'est pas dans la grille). */
  retourIdle(o, now) {
    const f = o.idle;
    if (!f?.src) return null;
    const id = 'retour-idle:' + o.id, sig = f.type + '|' + f.src;
    let c = this.idleClips?.[id];
    if (!c || c.sig !== sig) {
      c = Object.assign(newClip(f.type === 'video' ? 'video' : 'image', { src: f.src, name: f.name || '', fit: 'contain' }), { id, sig });
      if (c.type === 'video') { c.volume = 0; c.hold = false; }
      (this.idleClips ||= {})[id] = c;
    }
    const fresh = !this.sources.has(id), e = this.source(id, now, c);
    if (e && fresh) e.src.start(now);                                     // une vidéo de repos démarre (et boucle) dès qu'elle paraît
    return e ? { e, clip: c } : null;
  }
  /** Dessine un écran retour (w×h px, coin bas-gauche du canvas) : le visuel entier, proportions gardées, puis le chrono à la place
   *  choisie (o.timer = {x, y, w, h}, fractions de l'écran, depuis le haut à gauche). À appeler après frame(). */
  presentRetour(w, h, o) {
    if (!this.show || this.lost || !this.compT) return;
    const gl = this.gl, { show, live } = this, now = Date.now();
    if (live.test) return this.present('comp', w, h, { fit: true });         // mire : comme les autres sorties
    const env = { beat: (now - (live.beat0 || 0)) / 60000 * (show.bpm || 120), audio: this.audio };
    const ready = (id, clipObj) => {
      const e = clipObj ? clipObj.e : this.source(id, now);
      if (e && e.stamp !== this.stamp) { e.stamp = this.stamp; e.src.update(now, env, w, h); }
      return e?.src.ready && e.src.w ? e : null;
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const box = (x, y, bw, bh) => { gl.viewport(x, y, bw, bh); gl.scissor(x, y, bw, bh); };
    // Le clip tel quel (sans zone, sans effet, sans cadrage de la composition) mais avec son rognage (barre de titre d'un PowerPoint…).
    const plain = c => ({ ...c, fit: 'stretch', scale: 1, x: 0, y: 0, rot: 0 });
    const aspect = (e, c) => (e.src.w * (1 - (+c.cropL || 0) - (+c.cropR || 0))) / Math.max(1, e.src.h * (1 - (+c.cropT || 0) - (+c.cropB || 0))) || 16 / 9;
    // Contenu dans un cadre (bx, by en px depuis le bas à gauche). fill = le « Remplissage » du clip : 'contain' (entier, bandes
    // noires), 'stretch' (étiré sur tout le cadre) ou 'cover' (tout le cadre, bords rognés) — le retour suit le réglage du clip.
    const fitIn = (e, c, bx, by, bw, bh, fill = 'contain') => {
      const a = aspect(e, c);
      if (fill === 'stretch') { box(bx, by, bw, bh); return this.drawSource(e, plain(c), 1, NO_FX, env, null); }
      if (fill === 'cover') {
        const A = bw / Math.max(1, bh); let cl = +c.cropL || 0, cr = +c.cropR || 0, ct = +c.cropT || 0, cb = +c.cropB || 0;
        if (a > A) { const x = (1 - cl - cr) * (1 - A / a) / 2; cl += x; cr += x; }          // plus large que l'écran : on rogne les côtés
        else if (a < A) { const y = (1 - ct - cb) * (1 - a / A) / 2; ct += y; cb += y; }     // plus haut : on rogne en haut et en bas
        box(bx, by, bw, bh); return this.drawSource(e, { ...plain(c), cropL: cl, cropR: cr, cropT: ct, cropB: cb }, 1, NO_FX, env, null);
      }
      let vw = bw, vh = Math.round(bw / a);
      if (vh > bh) { vh = bh; vw = Math.round(bh * a); }
      box(bx + Math.floor((bw - vw) / 2), by + Math.floor((bh - vh) / 2), Math.max(1, vw), Math.max(1, vh));
      this.drawSource(e, plain(c), 1, NO_FX, env, null);
    };
    const pick = this.retourPick(o);
    let main = pick.main && ready(pick.main), mainClip = main && show.clips[pick.main];
    let fill = mainClip && (mainClip.fit === 'stretch' || mainClip.fit === 'cover') ? mainClip.fit : 'contain';
    if (!main) { const idle = this.retourIdle(o, now); if (idle && ready(null, idle)) { main = idle.e; mainClip = idle.clip; fill = o.idleFit || 'stretch'; } }   // affiche de repos : son propre remplissage
    if (main) fitIn(main, mainClip, 0, 0, w, h, fill);
    const tc = pick.timer && show.clips[pick.timer.id];
    if (tc) {
      // Le chrono a son propre dessin, à la taille de son cadre : sur le mur il est dessiné à la taille de sa zone (il serait minuscule
      // dans le cadre). Même départ et même pause que celui de la sortie : il affiche exactement le même temps.
      const p = o.timer || RETOUR_TIMER, bw = Math.max(8, Math.round(p.w * w)), bh = Math.max(8, Math.round(p.h * h));
      const copy = { ...tc, id: 'retour-timer:' + o.id, size: 84, align: 'center', valign: 'middle', scroll: false };
      const e = this.source(copy.id, now, copy);
      if (e) {
        if (e.retourT0 !== pick.timer.t0) { e.retourT0 = pick.timer.t0; e.src.start(pick.timer.t0); }
        e.src.pausedAt = pick.timer.pausedAt;
        e.stamp = this.stamp; e.src.update(now, env, bw, bh);
        if (e.src.ready || e.src.w) {
          gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          fitIn(e, copy, Math.round(p.x * w), h - Math.round(p.y * h) - bh, bw, bh);
          gl.disable(gl.BLEND);
        }
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Libère toutes les sources (vidéos, caméra) : l'aperçu de préparation quand on le ferme. */
  reset() { for (const e of this.sources.values()) e.src.dispose(); this.sources.clear(); this.rt = {}; }

  /** Clip en cours sur un calque + progression de la vidéo (pour l'affichage de la régie). */
  progress(layerId) {
    const rt = this.rt[layerId], e = rt?.cur && this.sources.get(rt.cur.clipId);
    return e?.src.progress ? e.src.progress() : null;
  }
}
