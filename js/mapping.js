/* Régie LED — éditeur de mapping (formes libres).
 * À gauche la composition : on y découpe des zones (rectangles).
 * À droite la sortie HDMI. Par défaut elle est verrouillée : elle reproduit la composition telle quelle.
 * Avec « Sortie personnalisée » (show.customOut), on y pose chaque zone à la position et à la taille attendues par le
 * processeur LED — rectangle, rotation, miroir, ou 4 coins libres. Toutes les valeurs sont en pixels. */
import { clamp, newSlice, quadBounds, uid, shapeOptions, shapeGroups, squareToQuad, applyH, zoneQuad, zonePoint } from './model.js';

const COLORS = ['#ffb300', '#00c2ff', '#ff4d6d', '#5ad65a', '#c77dff', '#ff8c42', '#f5f5f5'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initMapping(ctx) {
  const root = ctx.root;
  let selId = null, drag = null, free = false, bound = false, snap = null;
  const show = () => ctx.show();
  const cur = () => show().slices.find(z => z.id === selId) || null;
  const $ = s => root.querySelector(s);
  /** Emplacement « naturel » d'une zone sur la sortie : le même que dans la composition. */
  function aligned(z) {
    const s = show(), kx = s.output.w / s.comp.w, ky = s.output.h / s.comp.h;
    if (zoneQuad(z)) return z.quad.map(([x, y]) => [Math.round(x * kx), Math.round(y * ky)]);
    const x0 = Math.round(z.src.x * kx), y0 = Math.round(z.src.y * ky), x1 = Math.round((z.src.x + z.src.w) * kx), y1 = Math.round((z.src.y + z.src.h) * ky);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  /** Sélection partagée avec la barre « Formes » de la régie (ctx.selectZone) : on la suit, et on la prévient. */
  function pick(id) { selId = id; ctx.selectZone?.(id); }
  function render() {
    const s = show();
    const zs = ctx.zoneSel?.();
    if (zs && s.slices.some(z => z.id === zs)) selId = zs;
    if (!cur()) selId = s.slices[0]?.id || null;
    root.innerHTML = `
      <div class="map-top">
        <label>Composition <input type="number" data-res="comp.w" min="16" max="16384" value="${s.comp.w}"> × <input type="number" data-res="comp.h" min="16" max="16384" value="${s.comp.h}"> px</label>
        <label>Sortie HDMI <input type="number" data-res="output.w" min="16" max="16384" value="${s.output.w}"> × <input type="number" data-res="output.h" min="16" max="16384" value="${s.output.h}"> px</label>
        <label class="chk"><input type="checkbox" id="map-test"${ctx.live().test ? ' checked' : ''}> Mire de réglage</label>
        <label class="chk" title="Décoché (conseillé) : la sortie HDMI est exactement la composition. Coché : tu places toi-même chaque zone dans le signal, quand le processeur LED attend un écran à un autre endroit que dans ton image."><input type="checkbox" id="map-custom"${s.customOut ? ' checked' : ''}> Sortie personnalisée</label>
        ${s.customOut ? `<label class="chk" title="Décoché : tirer un coin redimensionne la zone sans la déformer. Coché : chaque coin bouge seul (écran en biais, trapèze)."><input type="checkbox" id="map-free"${free ? ' checked' : ''}> Coins libres</label>` : ''}
        <span class="map-out" id="map-out"></span>
      </div>
      <div class="shapebar" data-shapebar="map"></div>
      <div class="map-body">
        <div class="map-pane"><h4>1 · Composition <small>— ce que tu crées. Découpe la partie d'image destinée à chaque écran.</small></h4>
          <div class="stage" id="st-in"><canvas></canvas><svg></svg></div></div>
        <div class="map-pane"><h4>2 · Sortie HDMI <small>— ${s.customOut ? 'ce que reçoit le processeur LED. Place chaque zone à son emplacement.' : 'verrouillée : identique à la composition. Rien à régler ici.'}</small></h4>
          <div class="stage" id="st-out"><canvas></canvas><svg></svg></div></div>
        <aside class="panel map-side" id="map-side"></aside>
      </div>`;
    layout(); renderSide(); overlays(); ctx.shapeBar?.();
    if (!bound) { bind(); bound = true; }
  }

  function layout() {
    const s = show();
    for (const [id, d] of [['#st-in', s.comp], ['#st-out', s.output]]) {
      const st = $(id);
      st.style.aspectRatio = d.w + ' / ' + d.h;
      st.style.width = `min(100%, calc((100vh - 230px) * ${d.w / d.h}))`;
      st.querySelector('svg').setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
    }
  }

  function renderSide() {
    const s = show(), z = cur();
    const list = s.slices.map((x, i) => `<li class="${x.id === selId ? 'sel' : ''}" data-id="${x.id}">
        <i style="background:${COLORS[i % COLORS.length]}"></i><input type="checkbox" data-on="${x.id}"${x.on ? ' checked' : ''} title="Afficher cette zone">
        <span>${i + 1} · ${esc(x.name)}</span></li>`).join('');
    let f = '<p class="empty">Ajoute une zone par écran LED.</p>';
    if (z) {
      const b = quadBounds(z.dst);
      const n = (k, label, v) => `<label><span>${label}</span><input type="number" data-f="${k}" value="${Math.round(v)}"></label>`;
      f = `<label class="f"><span>Nom</span><input type="text" data-f="name" value="${esc(z.name)}"></label>
        <label class="f"><span>Forme de l'écran</span><select data-f="shape">${shapeOptions(z).map(([v, t]) => `<option value="${v}"${(z.shape || 'rect') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <p class="note">La forme masque ce qui dépasse de l'écran (cercle, losange en escalier, triangle…) et se voit dans la mire. Pour un écran carré simplement <b>tourné</b>, garde « Rectangle » et règle la rotation ci-dessous.</p>
        <h4>Dans la composition (px)</h4>
        ${zoneQuad(z) ? `<div class="quad4 two">${['Haut gauche', 'Haut droit', 'Bas droit', 'Bas gauche'].map((lab, i) => `<label><span>${lab}</span><span class="pair"><input type="number" data-f="q.${i}.0" value="${Math.round(z.quad[i][0])}"><input type="number" data-f="q.${i}.1" value="${Math.round(z.quad[i][1])}"></span></label>`).join('')}</div>
        <div class="row"><button class="btn sm on" data-act="quad" title="Revenir à un rectangle (sa boîte englobante)">⬚ Coins libres</button></div>
        <p class="note">Coins libres : tire chaque coin (rond doré) dans la composition pour épouser un écran en biais ou en trapèze ; l'image de cette zone se déforme avec, et la sortie suit.</p>`
        : `<div class="quad4">${n('src.x', 'X', z.src.x)}${n('src.y', 'Y', z.src.y)}${n('src.w', 'Largeur', z.src.w)}${n('src.h', 'Hauteur', z.src.h)}</div>
        <div class="row rotrow"><label>Rotation de la découpe <input type="number" data-f="src.rot" step="1" value="${Math.round(z.src.rot || 0)}"> °</label>
          ${[0, 45, -45, 90].map(r => `<button class="btn sm${Math.round(z.src.rot || 0) === r ? ' on' : ''}" data-rot="${r}">${r}°</button>`).join('')}</div>
        <div class="row"><button class="btn sm" data-act="quad" title="Chaque coin se déplace seul : écran en biais, trapèze, perspective">⬚ Coins libres</button></div>`}
        <p class="note">${s.customOut ? 'Écran monté en losange : découpe un carré, tourne-le de 45° (ou −45° si la mire apparaît penchée dans l\'autre sens) et pose-le droit sur la sortie.' : 'La rotation penche le contenu de cette zone dans l\'image.'}</p>
        <details><summary>Taille exacte depuis le pitch LED</summary>
          <div class="quad4"><label><span>Pitch (mm)</span><input type="number" data-pitch step="0.01" min="0.5" max="40" value="${z.pitch || 3.9}" list="pitches"></label><label><span>Largeur (m)</span><input type="number" data-pw step="0.01" min="0.1" value="${z.pw || ''}" placeholder="ex. 5"></label><label><span>Hauteur (m)</span><input type="number" data-ph step="0.01" min="0.1" value="${z.ph || ''}" placeholder="ex. 3"></label><label><span>&nbsp;</span><button class="btn sm gold" data-act="pitch">Appliquer</button></label></div>
          <datalist id="pitches">${[1.5, 1.8, 1.9, 2.5, 2.6, 2.9, 3.9, 4.8, 5.9, 6.25, 8, 10].map(p => `<option value="${p}">`).join('')}</datalist>
          <p class="note" data-pitch-info>${z.pitch && z.pw && z.ph ? `${z.pw} m × ${z.ph} m en P${z.pitch} = ${Math.round(z.pw * 1000 / z.pitch)} × ${Math.round(z.ph * 1000 / z.pitch)} px` : 'Pixels = taille (mm) ÷ pitch. Ex. : 5 m × 3 m en P3,9 → 1282 × 769 px.'} Ces pixels sont ceux du processeur : avec la sortie réglée à sa résolution, 1 px ici = 1 px sur le mur, quel que soit le pitch. Flèches du clavier = 1 px.</p>
        </details>
        ${s.customOut ? `<h4>Sur la sortie (px)</h4>
        <div class="quad4">${n('dst.x', 'X', b.x)}${n('dst.y', 'Y', b.y)}${n('dst.w', 'Largeur', b.w)}${n('dst.h', 'Hauteur', b.h)}</div>
        <div class="row"><button class="btn sm" data-act="one" title="Même taille que dans la composition : aucun redimensionnement, pixel pour pixel">Taille réelle 1:1</button>
          <button class="btn sm" data-act="rot" title="Tourner d'un quart de tour (écran monté en portrait)">⟳ 90°</button>
          <button class="btn sm" data-act="fliph" title="Miroir gauche-droite">⇆</button><button class="btn sm" data-act="flipv" title="Miroir haut-bas">⇅</button></div>
        <details${free ? ' open' : ''}><summary>Les 4 coins (forme libre)</summary>
          <div class="quad4 two">${['Haut gauche', 'Haut droit', 'Bas droit', 'Bas gauche'].map((lab, i) => `<label><span>${lab}</span><span class="pair"><input type="number" data-f="p.${i}.0" value="${Math.round(z.dst[i][0])}"><input type="number" data-f="p.${i}.1" value="${Math.round(z.dst[i][1])}"></span></label>`).join('')}</div>
        </details>
        <div class="row"><button class="btn sm" data-act="align" title="Remet cette zone droite, au même endroit et à la même taille que dans la composition">Aligner sur la composition</button></div>` : '<p class="note">Sortie verrouillée : cette zone part vers le mur exactement là où elle est dans la composition. Pour la placer ailleurs dans le signal (processeur réglé autrement), coche « Sortie personnalisée » en haut.</p>'}
        <div class="row"><button class="btn sm" data-act="full">Plein cadre</button><button class="btn sm" data-act="dup">Dupliquer</button><button class="btn sm danger" data-act="del">Supprimer</button></div>
        <h4>Contenu de cette zone</h4>
        ${(() => { const ls = ctx.layersOfZone(z.id); return ls.length ? `<p class="note">Calque(s) affiché(s) ici : <b>${esc(ls.join(', '))}</b>. Dans l'onglet Régie, les clips lancés sur ce calque remplissent cette zone.</p>` : '<p class="note">Pour l\'instant cette zone montre simplement la partie de l\'image qu\'elle découpe.</p>'; })()}
        <button class="btn sm gold" data-act="layer">＋ Calque pour cette zone</button>
        <p class="note">Crée un calque dont tous les clips sont cadrés dans cette zone : un calque par écran, et chaque écran a son contenu.</p>`;
    }
    $('#map-side').innerHTML = `<div class="panel-h"><h3>Zones</h3><button class="btn sm gold" data-act="add">＋ Zone</button></div>
      <ul class="zone-list">${list}</ul><div class="fields">${f}
      <p class="note">Astuce : coche « Mire de réglage », puis règle chaque zone en regardant le vrai mur LED. Flèches du clavier = 1 px.</p></div>`;
  }

  /** Dessine les cadres et poignées par-dessus les deux aperçus. */
  function overlays() {
    const s = show();
    const unit = (st, w) => w / Math.max(1, st.getBoundingClientRect().width);     // 1 px écran, en unités de l'aperçu
    const stIn = $('#st-in'), stOut = $('#st-out');
    if (!stIn) return;
    const ui = unit(stIn, s.comp.w), uo = unit(stOut, s.output.w);
    let a = '', b = '';
    s.slices.forEach((z, i) => {
      const c = COLORS[i % COLORS.length], on = z.id === selId, cls = `z${on ? ' sel' : ''}${z.on ? '' : ' off'}${ctx.multi?.(z.id) ? ' multi' : ''}`;
      const zq = zoneQuad(z);
      const tr = z.src.rot && !zq ? ` transform="rotate(${z.src.rot} ${z.src.x + z.src.w / 2} ${z.src.y + z.src.h / 2})"` : '';
      const shps = z.shape && z.shape !== 'rect' && z.shape !== 'carre' ? shapeGroups(z) : null;
      a += zq ? `<g><polygon class="${cls}" data-id="${z.id}" points="${zq.map(p => p.join(',')).join(' ')}" stroke="${c}" fill="${c}"/>
        ${shps ? shps.map(shp => `<polygon class="zs" points="${shp.map(([u, v]) => zonePoint(z, u, v).map(Math.round).join(',')).join(' ')}" stroke="${c}"/>`).join('') : ''}`
        : `<g${tr}><rect class="${cls}" data-id="${z.id}" x="${z.src.x}" y="${z.src.y}" width="${z.src.w}" height="${z.src.h}" stroke="${c}" fill="${c}"/>
        ${shps ? shps.map(shp => `<polygon class="zs" points="${shp.map(([u, v]) => (z.src.x + u * z.src.w) + ',' + (z.src.y + v * z.src.h)).join(' ')}" stroke="${c}"/>`).join('') : ''}`;
      a += `
        <text class="zl" x="${z.src.x + 8 * ui}" y="${z.src.y + 20 * ui}" font-size="${14 * ui}" fill="${c}">${i + 1} · ${esc(z.name)}</text>`;
      const custom = !!s.customOut, dst = custom ? z.dst : aligned(z);
      const bb = quadBounds(dst);
      const Hq = shps ? squareToQuad(dst) : null;
      const trO = !custom && z.src.rot ? ` transform="rotate(${z.src.rot} ${bb.x + bb.w / 2} ${bb.y + bb.h / 2})"` : '';
      b += `<g${trO}><polygon class="${cls}${custom ? '' : ' ro'}"${custom ? ` data-id="${z.id}"` : ''} points="${dst.map(p => p.join(',')).join(' ')}" stroke="${c}" fill="${c}"/>
        ${shps ? shps.map(shp => `<polygon class="zs" points="${shp.map(([u, v]) => applyH(Hq, u, v).slice(0, 2).map(Math.round).join(',')).join(' ')}" stroke="${c}"/>`).join('') : ''}
        <text class="zl" x="${bb.x + 8 * uo}" y="${bb.y + 20 * uo}" font-size="${14 * uo}" fill="${c}">${i + 1} · ${esc(z.name)}</text></g>`;
      if (on && zq) zq.forEach((p, k) => { a += `<circle class="zo-v" data-id="${z.id}" data-q="${k}" cx="${p[0]}" cy="${p[1]}" r="${7 * ui}"><title>Tirer ce coin</title></circle>`; });
      else if (on) {
        const sc = [[z.src.x, z.src.y], [z.src.x + z.src.w, z.src.y], [z.src.x + z.src.w, z.src.y + z.src.h], [z.src.x, z.src.y + z.src.h]];
        sc.forEach((p, h) => { a += `<circle class="hd" data-id="${z.id}" data-h="${h}" cx="${p[0]}" cy="${p[1]}" r="${7 * ui}"/>`; });
        const mx = z.src.x + z.src.w / 2;
        a += `<line class="zo-rl" x1="${mx}" y1="${z.src.y}" x2="${mx}" y2="${z.src.y - 26 * ui}"/><circle class="zo-r" data-id="${z.id}" data-r="1" cx="${mx}" cy="${z.src.y - 26 * ui}" r="${7 * ui}"><title>Tourner la découpe (Aimant : par 15°)</title></circle>`;
        if (z.shape === 'libre' && ctx.localGroups) ctx.localGroups(z).forEach((g, pg) => g.forEach((q, v) => { const n = g[(v + 1) % g.length]; a += `<circle class="zo-m" data-id="${z.id}" data-pg="${pg}" data-m="${v}" cx="${(q[0] + n[0]) / 2}" cy="${(q[1] + n[1]) / 2}" r="${3.5 * ui}"><title>Ajouter un point ici</title></circle><circle class="zo-v" data-id="${z.id}" data-pg="${pg}" data-v="${v}" cx="${q[0]}" cy="${q[1]}" r="${4.5 * ui}"><title>Déplacer ce point (Alt+clic : l'enlever)</title></circle>`; }));
      }
      a += '</g>';
      if (on && s.customOut) {
        z.dst.forEach((p, h) => { b += `<circle class="hd" data-id="${z.id}" data-h="${h}" cx="${p[0]}" cy="${p[1]}" r="${7 * uo}"/>`; });
      }
    });
    stIn.querySelector('svg').innerHTML = a;
    stOut.querySelector('svg').innerHTML = b;
  }

  function changed(side = true) { overlays(); if (side) renderSide(); ctx.commit(); ctx.shapeBar?.(); }
  function clampSrc(z) {
    const { comp } = show();
    z.src.w = clamp(Math.round(z.src.w), 1, comp.w); z.src.h = clamp(Math.round(z.src.h), 1, comp.h);
    z.src.x = clamp(Math.round(z.src.x), 0, comp.w - z.src.w); z.src.y = clamp(Math.round(z.src.y), 0, comp.h - z.src.h);
  }
  /** Replace les 4 coins dans une nouvelle boîte englobante en gardant la forme (rotation, miroir, biais). */
  function refit(pts, ob, nb) {
    return pts.map(([x, y]) => [Math.round(nb.x + (ob.w ? (x - ob.x) / ob.w : 0) * nb.w), Math.round(nb.y + (ob.h ? (y - ob.y) / ob.h : 0) * nb.h)]);
  }
  function setField(z, k, v) {
    if (k === 'name') { z.name = String(v); return; }
    if (k === 'shape') { z.shape = String(v); if (v === 'carre') ctx.squarify?.(z); return; }
    if (k.startsWith('q.') && zoneQuad(z)) { const [, i, j] = k.split('.'), nv = Math.round(+v); if (isFinite(nv)) { z.quad[+i][+j] = nv; ctx.syncQuad(z); } return; }
    v = Math.round(+v);
    if (!isFinite(v)) return;
    const [a, b, c] = k.split('.');
    if (a === 'src' && b === 'rot') { z.src.rot = ((v % 360) + 540) % 360 - 180; return; }
    if (a === 'src') {
      const { comp } = show();
      z.src[b] = v;
      if (b === 'x') z.src.w = Math.min(z.src.w, comp.w - clamp(v, 0, comp.w - 1));   // déplacer réduit la taille plutôt que d'être bloqué
      if (b === 'y') z.src.h = Math.min(z.src.h, comp.h - clamp(v, 0, comp.h - 1));
      clampSrc(z);
    }
    else if (a === 'dst') {
      // On repart de la forme mémorisée à l'entrée dans le champ : taper « 9 », « 96 », « 960 » ne l'abîme pas.
      z.custom = true;
      if (!snap || snap.id !== z.id) snap = { id: z.id, dst: z.dst.map(p => [...p]) };
      const ob = quadBounds(snap.dst), nb = { ...quadBounds(z.dst), [b]: b === 'w' || b === 'h' ? Math.max(1, v) : v };
      z.dst = refit(snap.dst, ob, nb);
    } else if (a === 'p') { z.dst[+b][+c] = v; z.custom = true; }
  }

  function point(e, st, d) {
    const r = st.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * d.w, (e.clientY - r.top) / r.height * d.h];
  }
  function onDown(e) {
    const st = e.target.closest('.stage'), el = e.target.closest('[data-id]');
    if (!st) return;
    if (!el) return;
    e.preventDefault();
    snap = null; document.activeElement?.blur?.();
    const s = show(), pane = st.id === 'st-in' ? 'in' : 'out', d = pane === 'in' ? s.comp : s.output;
    if (pane === 'in' && e.shiftKey && el.classList.contains('z')) return ctx.toggleMulti?.(el.dataset.id);   // Maj+clic : sélection multiple (fusion)
    const was = selId; selId = el.dataset.id;
    const z = cur();
    drag = { pane, st, d, h: el.dataset.h != null ? +el.dataset.h : null, start: point(e, st, d), src: { ...z.src }, dst: z.dst.map(p => [...p]), rot: el.dataset.r != null };
    if (pane === 'in' && zoneQuad(z)) { drag.quad = z.quad.map(p => [...p]); drag.qk = el.dataset.q != null ? +el.dataset.q : null; }
    if (pane === 'in' && (el.dataset.v != null || el.dataset.m != null)) {                 // sommet d'une forme dessinée
      const pg = +el.dataset.pg;
      if (el.dataset.v != null && e.altKey) { drag = null; if (ctx.deleteVertex(z, pg, +el.dataset.v)) changed(); return; }
      const v = el.dataset.v != null ? +el.dataset.v : ctx.insertVertex(z, pg, +el.dataset.m);
      if (v == null) { drag = null; return; }
      drag.vert = { pg, v }; overlays(); ctx.commit();
    }
    if (was !== selId) { renderSide(); overlays(); ctx.selectZone?.(selId); }
  }
  function onMove(e) {
    if (!drag) return;
    const z = cur(); if (!z) return;
    const [px, py] = point(e, drag.st, drag.d), dx = Math.round(px - drag.start[0]), dy = Math.round(py - drag.start[1]);
    if (drag.pane === 'in') {
      const o = drag.src;
      if (drag.quad) {                                       // coins libres : un coin seul, ou toute la forme
        if (drag.qk != null) ctx.quadCorner(z, drag.quad, drag.qk, drag.quad[drag.qk][0] + dx, drag.quad[drag.qk][1] + dy);
        else ctx.quadMove(z, drag.quad, o, dx, dy);
        ctx.afterEdit?.();
      }
      else if (drag.vert) { ctx.setVertex(z, drag.vert.pg, drag.vert.v, [px, py]); }
      else if (drag.rot) {                                   // poignée de rotation : angle entre le centre et la souris
        let a = Math.atan2(py - (o.y + o.h / 2), px - (o.x + o.w / 2)) * 180 / Math.PI + 90;
        a = ((a + 540) % 360) - 180;
        if (ctx.snapOn?.()) a = Math.round(a / 15) * 15;
        z.src.rot = Math.round(a);
        const f = root.querySelector('[data-shapebar] [data-zf="rot"]'); if (f) f.value = z.src.rot;
      }
      else if (drag.h == null) {                              // déplacement : l'aimant cale les bords et le centre (case « Aimant »)
        const [x, y] = ctx.snapMove ? ctx.snapMove(z, o.w, o.h, o.x + dx, o.y + dy) : [o.x + dx, o.y + dy];
        z.src = { ...o, x, y }; clampSrc(z);
      }
      else {
        const { comp } = show(), r = -(o.rot || 0) * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
        const lx = Math.round(cr * dx - sr * dy), ly = Math.round(sr * dx + cr * dy);     // déplacement vu dans le repère de la zone
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (drag.h === 0 || drag.h === 3) x0 = clamp(x0 + lx, 0, x1 - 1); else x1 = clamp(x1 + lx, x0 + 1, comp.w);
        if (drag.h === 0 || drag.h === 1) y0 = clamp(y0 + ly, 0, y1 - 1); else y1 = clamp(y1 + ly, y0 + 1, comp.h);
        if (ctx.snapEdges) [x0, y0, x1, y1] = ctx.snapEdges(z, drag.h, x0, y0, x1, y1);
        if (z.shape === 'carre') {                     // carré : un seul côté, ancré au coin opposé
          let side = Math.max(1, Math.abs(lx) >= Math.abs(ly) ? x1 - x0 : y1 - y0);
          const ax = drag.h === 0 || drag.h === 3 ? x1 : x0, ay = drag.h === 0 || drag.h === 1 ? y1 : y0;
          side = Math.min(side, drag.h === 0 || drag.h === 3 ? ax : comp.w - ax, drag.h === 0 || drag.h === 1 ? ay : comp.h - ay);
          if (drag.h === 0 || drag.h === 3) x0 = ax - side; else x1 = ax + side;
          if (drag.h === 0 || drag.h === 1) y0 = ay - side; else y1 = ay + side;
        }
        z.src = { ...o, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    } else if (!show().customOut) return;
    else if (drag.h == null) { const [sx, sy] = outSnap(z, drag.dst, dx, dy); z.dst = drag.dst.map(([x, y]) => [x + dx + sx, y + dy + sy]); }
    else if (free || e.altKey) { z.dst = drag.dst.map(p => [...p]); z.dst[drag.h] = [drag.dst[drag.h][0] + dx, drag.dst[drag.h][1] + dy]; }
    else {
      const ob = quadBounds(drag.dst), p = drag.dst[drag.h];
      let x0 = ob.x, y0 = ob.y, x1 = ob.x + ob.w, y1 = ob.y + ob.h;
      if (p[0] > ob.x + ob.w / 2) x1 = Math.max(x0 + 1, x1 + dx); else x0 = Math.min(x1 - 1, x0 + dx);
      if (p[1] > ob.y + ob.h / 2) y1 = Math.max(y0 + 1, y1 + dy); else y0 = Math.min(y1 - 1, y0 + dy);
      z.dst = refit(drag.dst, ob, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    drag.moved = true;
    if (drag.pane === 'out') z.custom = true;
    overlays(); syncFields(z); ctx.commit();
    if (drag.pane === 'in') { const f = root.querySelector('[data-shapebar] [data-zf="rot"]'); if (f) f.value = Math.round(z.src.rot || 0); }
  }
  /** Aimant sur la sortie (zones placées à la main) : bords et centre de la zone calés sur ceux du signal et des autres zones. */
  function outSnap(z, quad, dx, dy) {
    if (!ctx.snapOn?.()) return [0, 0];
    const s = show(), tol = s.output.w / 110, b = quadBounds(quad);
    const cx = [0, s.output.w / 2, s.output.w], cy = [0, s.output.h / 2, s.output.h];
    for (const o of s.slices) if (o !== z && o.on) { const ob = quadBounds(o.dst); cx.push(ob.x, ob.x + ob.w / 2, ob.x + ob.w); cy.push(ob.y, ob.y + ob.h / 2, ob.y + ob.h); }
    const best = (v0, size, c) => { let d = 0, bd = tol; for (const v of [v0, v0 + size / 2, v0 + size]) for (const t of c) { const dd = t - v; if (Math.abs(dd) < bd) { bd = Math.abs(dd); d = dd; } } return Math.round(d); };
    return [best(b.x + dx, b.w, cx), best(b.y + dy, b.h, cy)];
  }
  function syncFields(z) {
    const b = quadBounds(z.dst), vals = { ...(zoneQuad(z) ? Object.fromEntries(z.quad.flatMap((p, i) => [[`q.${i}.0`, p[0]], [`q.${i}.1`, p[1]]])) : {}), 'src.x': z.src.x, 'src.y': z.src.y, 'src.w': z.src.w, 'src.h': z.src.h, 'src.rot': z.src.rot || 0, 'dst.x': b.x, 'dst.y': b.y, 'dst.w': b.w, 'dst.h': b.h };
    z.dst.forEach((p, i) => { vals[`p.${i}.0`] = p[0]; vals[`p.${i}.1`] = p[1]; });
    for (const el of root.querySelectorAll('#map-side [data-f]')) if (el.dataset.f in vals) el.value = Math.round(vals[el.dataset.f]);
  }

  function bind() {
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('focusin', e => {
      const z = cur();
      snap = z && e.target.dataset?.f?.startsWith('dst.') ? { id: z.id, dst: z.dst.map(p => [...p]) } : null;
    });
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', () => { drag = null; });
    addEventListener('resize', () => { if (!root.hidden) overlays(); });
    root.addEventListener('change', e => {
      const t = e.target, s = show();
      if (t.dataset.res) {
        const [a, b] = t.dataset.res.split('.');
        s[a][b] = clamp(Math.round(+t.value) || s[a][b], 16, 16384); t.value = s[a][b];
        for (const z of s.slices) clampSrc(z);
        layout(); changed();
      }
      if (t.id === 'map-test') { ctx.live().test = t.checked; ctx.commit(false); ctx.refresh(); }
      if (t.id === 'map-free') { free = t.checked; renderSide(); }
      if (t.id === 'map-custom') {
        s.customOut = t.checked;
        // Les zones jamais placées à la main partent du même emplacement que dans la composition.
        if (t.checked) { for (const z of s.slices) if (!z.custom) z.dst = aligned(z); }
        else free = false;
        ctx.commit(); render();
      }
      if (t.dataset.on) { const z = s.slices.find(x => x.id === t.dataset.on); if (z) { z.on = t.checked; changed(false); } }
      if (t.dataset.f === 'name' || t.dataset.f === 'shape') { renderSide(); ctx.shapeBar?.(); }
    });
    root.addEventListener('input', e => {
      const t = e.target, z = cur();
      if (!t.dataset.f || !z) return;
      if (t.type === 'number' && t.value === '') return;
      setField(z, t.dataset.f, t.value);
      overlays(); ctx.commit();
    });
    root.addEventListener('click', e => {
      const s = show(), act = e.target.closest('[data-act]')?.dataset.act, li = e.target.closest('.zone-list li');
      if (li && !e.target.closest('input')) { pick(li.dataset.id); renderSide(); overlays(); return; }
      const rb = e.target.closest('[data-rot]');
      if (rb && cur()) { cur().src.rot = +rb.dataset.rot; return changed(); }
      if (!act) return;
      const z = cur();
      if (act === 'add') { const n = newSlice(s); s.slices.push(n); pick(n.id); return changed(); }
      if (!z) return;
      if (act === 'layer') { ctx.addLayerForZone(z); renderSide(); return; }
      if (act === 'del') { s.slices.splice(s.slices.indexOf(z), 1); pick(s.slices[0]?.id || null); return changed(); }
      if (act === 'dup') {
        const n = JSON.parse(JSON.stringify(z)); n.id = uid(); n.name = z.name + ' (copie)';
        n.dst = n.dst.map(([x, y]) => [x + 20, y + 20]);
        s.slices.push(n); pick(n.id); return changed();
      }
      if (act === 'quad') { ctx.toggleQuad(z); renderSide(); overlays(); return; }
      if (act === 'full') { delete z.quad; z.src = { x: 0, y: 0, w: s.comp.w, h: s.comp.h, rot: 0 }; z.dst = [[0, 0], [s.output.w, 0], [s.output.w, s.output.h], [0, s.output.h]]; z.custom = false; return changed(); }
      if (act === 'pitch') {                                   // taille de la zone = dimensions physiques de l'écran ÷ pitch
        const pitch = +$('#map-side [data-pitch]')?.value, pw = +$('#map-side [data-pw]')?.value, ph = +$('#map-side [data-ph]')?.value;
        if (!(pitch > 0) || !(pw > 0) || !(ph > 0)) { ctx.toast('Indique le pitch (mm), la largeur et la hauteur (m) de l\'écran.', 'err'); return; }
        const w = Math.round(pw * 1000 / pitch), h = Math.round(ph * 1000 / pitch);
        z.pitch = pitch; z.pw = pw; z.ph = ph; delete z.quad;              // la taille exacte s'applique à un rectangle
        z.src.w = Math.max(1, Math.min(w, s.comp.w)); z.src.h = Math.max(1, Math.min(h, s.comp.h));
        z.src.x = Math.min(z.src.x, s.comp.w - z.src.w); z.src.y = Math.min(z.src.y, s.comp.h - z.src.h);
        if (!z.custom) z.dst = aligned(z);
        ctx.toast(`« ${z.name} » : ${w} × ${h} px (${pw} m × ${ph} m en P${pitch})` + (w > s.comp.w || h > s.comp.h ? ' — plus grand que la composition : agrandis-la en haut.' : '.'));
        return changed();
      }
      if (act === 'align') { z.dst = aligned(z); z.custom = false; return changed(); }
      if (!['fliph', 'flipv', 'rot', 'one'].includes(act)) return;
      z.custom = true;
      const ob = quadBounds(z.dst);
      if (act === 'fliph') z.dst = [z.dst[1], z.dst[0], z.dst[3], z.dst[2]];
      if (act === 'flipv') z.dst = [z.dst[3], z.dst[2], z.dst[1], z.dst[0]];
      if (act === 'rot') {           // quart de tour horaire : la boîte englobante échange largeur et hauteur
        z.dst = z.dst.map(([x, y]) => {
          const u = ob.w ? (x - ob.x) / ob.w : 0, v = ob.h ? (y - ob.y) / ob.h : 0;
          return [Math.round(ob.x + (1 - v) * ob.h), Math.round(ob.y + u * ob.w)];
        });
      }
      if (act === 'one') {
        const side = Math.abs(z.dst[1][0] - z.dst[0][0]) >= Math.abs(z.dst[1][1] - z.dst[0][1]);   // bord haut horizontal ?
        z.dst = refit(z.dst, ob, { x: ob.x, y: ob.y, w: side ? z.src.w : z.src.h, h: side ? z.src.h : z.src.w });
      }
      changed();
    });
  }

  return {
    render,
    /** Sélection venue de la régie (barre « Formes », clic sur une forme) : on la reflète si l'onglet est affiché. */
    select(id) { selId = id; if (!root.hidden && $('#st-in')) { renderSide(); overlays(); } },
    /** Les formes ont changé ailleurs (barre « Formes », glisser sur l'écran) : on redessine les cadres (et le panneau si `side`). */
    refresh(side = true) { if (root.hidden || !$('#st-in')) return; overlays(); const z = cur(); if (z) syncFields(z); if (side) renderSide(); },
    frame() {
      const a = $('#st-in canvas'), b = $('#st-out canvas');
      if (!a) return;
      ctx.drawView('comp', a); ctx.drawView('output', b);
      const o = ctx.out(), s = show(), el = $('#map-out');
      const txt = !o ? 'Fenêtre de sortie fermée' : o.w === s.output.w && o.h === s.output.h ? `Sortie réelle ${o.w}×${o.h} px : identique, pixel pour pixel` : `Attention : la fenêtre de sortie fait ${o.w}×${o.h} px`;
      if (el.textContent !== txt) { el.textContent = txt; el.className = 'map-out' + (o && !(o.w === s.output.w && o.h === s.output.h) ? ' warn' : ''); }
    },
    /** Flèches : déplace la zone sélectionnée — dans la composition si la sortie est verrouillée, sinon sur la sortie (Alt : composition). */
    key(e) {
      const z = cur(), d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!z || !d) return false;
      e.preventDefault();
      const k = e.shiftKey ? 10 : 1;
      if ((e.altKey || !show().customOut) && zoneQuad(z)) ctx.quadMove(z, z.quad.map(p => [...p]), { ...z.src }, d[0] * k, d[1] * k, false);
      else if (e.altKey || !show().customOut) { z.src.x += d[0] * k; z.src.y += d[1] * k; clampSrc(z); }
      else { z.dst = z.dst.map(([x, y]) => [x + d[0] * k, y + d[1] * k]); z.custom = true; }
      overlays(); syncFields(z); ctx.commit();
      return true;
    },
  };
}
