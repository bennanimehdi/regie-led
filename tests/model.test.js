/* Tests sans dépendance : node tests/model.test.js */
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// Homographie : les 4 coins du carré unité arrivent sur les 4 coins du quadrilatère (rectangle, biais, trapèze).
for (const q of [
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[100, 50], [740, 50], [740, 410], [100, 410]],
  [[10, 20], [300, 60], [280, 400], [-30, 350]],
  [[0, 0], [200, 30], [180, 160], [20, 200]],
]) {
  const h = M.squareToQuad(q), inv = M.invert3(h);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = M.applyH(h, u, v);
    near(x, q[i][0], 1e-6); near(y, q[i][1], 1e-6);
    const [bu, bv] = M.applyH(inv, x, y);
    near(bu, u, 1e-6); near(bv, v, 1e-6);
  });
}

// sliceMatrix : le centre de la zone est à l'intérieur (w > 0), y compris pour une zone retournée.
const out = { w: 1920, h: 1080 };
for (const dst of [
  [[0, 0], [1920, 0], [1920, 1080], [0, 1080]],
  [[1920, 0], [0, 0], [0, 1080], [1920, 1080]],        // miroir
  [[500, 100], [500, 600], [200, 600], [200, 100]],    // quart de tour
]) {
  const m = M.sliceMatrix({ dst }, out.w, out.h);
  const b = M.quadBounds(dst);
  const [u, v, w] = M.applyH(m, (b.x + b.w / 2) / out.w, (b.y + b.h / 2) / out.h);
  assert.ok(w > 0); near(u, 0.5, 1e-6); near(v, 0.5, 1e-6);
}
assert.equal(M.sliceMatrix({ dst: [[0, 0], [0, 0], [0, 0], [0, 0]] }, 100, 100), null);

// Show par défaut et normalisation.
const d = M.defaultShow();
assert.equal(d.layers.length, 3);
for (const l of d.layers) assert.equal(d.cells[l.id].length, d.cols);
assert.equal(M.normalizeShow(null).layers.length, 3);
const n = M.normalizeShow({ layers: [{ id: 'a', name: 'A' }], cols: 3, clips: { x: { type: 'text' }, bad: null }, cells: { a: ['x', 'zzz'] }, cues: [{ layers: { a: 'x' } }], slices: [] });
assert.deepEqual(n.cells.a, ['x', null, null]);
assert.equal(n.clips.x.id, 'x'); assert.ok(!('bad' in n.clips));
assert.equal(n.layers[0].fx.bri, 1);
assert.equal(n.slices.length, 1);

// Nettoyage : un clip encore cité par le conducteur est conservé, les autres disparaissent.
n.cells.a[0] = null; n.clips.y = M.newClip('gen', { id: 'y' });
M.pruneClips(n);
assert.ok(n.clips.x); assert.ok(!n.clips.y);

assert.deepEqual(M.hexToRgb('#ff0000'), [1, 0, 0]);
// Premier lancement (aucun show enregistré) : le show par défaut a bien sa sortie principale et une zone.
const fresh = M.normalizeShow(null);
assert.equal(fresh.outputs.length, 1); assert.equal(fresh.outputs[0].id, 'main'); assert.ok(fresh.layers.length >= 1);

console.log('OK — modèle et géométrie');
