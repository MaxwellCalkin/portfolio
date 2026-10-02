import test from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, cellCenter, gridSize, buildFloraCell, STRIDE, CELL_SIZE } from '../game/world/flora-cells.js';
import { prepareSpecs, LAYOUTS } from '../game/world/layout.js';
import { createPlanetShape } from '../game/world/planet-shape.js';
import { RECIPES } from '../game/world/flora.js';

test('cells tile the cube sphere and round-trip through their centers', () => {
  const R = 6200, n = gridSize(R);
  assert.ok(n * CELL_SIZE >= 2 * R);
  for (const [face, i, j] of [[0, 0, 0], [3, n - 1, 5], [5, n >> 1, n >> 1], [2, 17, n - 2]]) {
    const c = cellCenter(face, i, j, n, R), l = Math.hypot(...c);
    assert.deepEqual(cellOf(c.map(v => v / l), n), { face, i, j });
  }
});

test('flora generation is deterministic per cell and layer', () => {
  const spec = prepareSpecs().find(s => s.id === 'philosophy'), shape = createPlanetShape(spec);
  const layout = LAYOUTS.philosophy;
  const ctx = { seed: spec.seed, radius: spec.radius, densityScale: 1, colliders: {}, recipe: RECIPES.philosophy,
    exclusions: { frame: spec.frame, plateauCos: Math.cos((layout.plateau.radius + layout.plateau.falloff + 60) / spec.radius), zones: layout.landmarks.map(m => ({ x: m.at[0], z: m.at[1], r: m.clear })) } };
  const n = gridSize(spec.radius), c = cellOf(spec.frame.up, n);
  const all = RECIPES.philosophy.map((_, i) => i);
  const a = buildFloraCell(shape, ctx, c.face, c.i, c.j, all);
  const b = buildFloraCell(shape, ctx, c.face, c.i, c.j, [0]);
  assert.deepEqual([...a.layers[0]], [...b.layers[0]], 'a layer is identical when generated alone');
  let instances = 0;
  for (const data of Object.values(a.layers)) {
    assert.equal(data.length % STRIDE, 0);
    instances += data.length / STRIDE;
    for (let o = 0; o < data.length; o += STRIDE) {
      const r = Math.hypot(data[o], data[o + 1], data[o + 2]);
      assert.ok(Math.abs(r - spec.radius) < 200, 'instances sit on the planet');
      assert.ok(Math.abs(Math.hypot(data[o + 3], data[o + 4], data[o + 5], data[o + 6]) - 1) < 1e-6, 'unit quaternions');
    }
  }
  assert.ok(instances > 0, 'the home site has vegetation');
});
