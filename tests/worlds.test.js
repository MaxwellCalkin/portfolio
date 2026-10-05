import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANETS, SUN_DIRECTION } from '../game/world/system.js';
import { LAYOUTS, prepareSpecs } from '../game/world/layout.js';
import { createPlanetShape, siteLocalToDir, dirToSiteLocal, tangentFrame } from '../game/world/planet-shape.js';
import { atmosphereParams, fogPalette } from '../game/world/atmosphere.js';

const specs = prepareSpecs();
const shapes = new Map(specs.map(s => [s.id, createPlanetShape(s)]));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('five worlds, each with a layout, a site frame and a distinct orbit', () => {
  assert.equal(PLANETS.length, 5);
  for (const spec of specs) {
    assert.ok(LAYOUTS[spec.id], `${spec.id} has a layout`);
    const { up, forward, right } = spec.frame;
    for (const v of [up, forward, right]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
    assert.ok(Math.abs(dot(up, forward)) < 1e-9 && Math.abs(dot(up, right)) < 1e-9 && Math.abs(dot(forward, right)) < 1e-9);
  }
  for (let i = 0; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) {
    const a = specs[i], b = specs[j];
    const gap = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
    assert.ok(gap > (a.radius + b.radius) * 2.5, `${a.id} and ${b.id} are well separated`);
  }
});

test('main sites face the morning sun', () => {
  for (const spec of specs) {
    const elevation = Math.asin(dot(spec.frame.up, SUN_DIRECTION)) * 180 / Math.PI;
    assert.ok(elevation > 20 && elevation < 75, `${spec.id} sun elevation ${elevation.toFixed(1)}°`);
  }
});

test('terrain is deterministic and finite everywhere', () => {
  for (const spec of specs) {
    const a = shapes.get(spec.id), b = createPlanetShape(spec);
    for (let i = 0; i < 200; i++) {
      const v = [Math.sin(i * 12.9898) * 2 - 1, Math.cos(i * 78.233), Math.sin(i * 3.7)];
      const l = Math.hypot(...v); const d = v.map(x => x / l);
      const h = a.heightAt(...d);
      assert.ok(Number.isFinite(h), `${spec.id} height finite`);
      assert.equal(h, b.heightAt(...d));
      assert.ok(Math.abs(h) < 600, `${spec.id} relief stays in range (${h})`);
      assert.ok(a.surfaceRadius(...d) >= spec.radius + (a.seaLevel ?? -1e9));
    }
  }
});

test('site-local coordinates round-trip on every world', () => {
  for (const spec of specs) {
    for (const [x, z] of [[0, 0], [10, -20], [-140, -150], [300, 120]]) {
      const [rx, rz] = dirToSiteLocal(spec.frame, spec.radius, siteLocalToDir(spec.frame, spec.radius, x, z));
      assert.ok(Math.abs(rx - x) < 1e-6 && Math.abs(rz - z) < 1e-6, `${spec.id} (${x}, ${z})`);
    }
  }
  const frame = tangentFrame([0, 1, 0], [0, 1, 0]); // degenerate hint still gives a frame
  assert.ok(Math.abs(Math.hypot(...frame.forward) - 1) < 1e-9);
});

test('plateaus are flat and dry where the landmarks stand', () => {
  for (const spec of specs) {
    const shape = shapes.get(spec.id), layout = LAYOUTS[spec.id];
    const center = shape.heightAt(...spec.frame.up);
    if (spec.siteHeight != null) assert.ok(Math.abs(center - spec.siteHeight) <= layout.plateau.mound + 0.5, `${spec.id} site height ${center}`);
    const points = [layout.spawn, layout.ship, ...layout.landmarks.filter(m => !m.stack).map(m => m.at)];
    for (const [x, z] of points) {
      const h = shape.heightAt(...siteLocalToDir(spec.frame, spec.radius, x, z));
      if (shape.seaLevel !== null) assert.ok(h > shape.seaLevel + 1, `${spec.id} (${x}, ${z}) above the sea: ${h.toFixed(1)}`);
      assert.ok(Math.abs(h - center) < layout.plateau.mound + 3, `${spec.id} (${x}, ${z}) on the plateau: ${h.toFixed(1)} vs ${center.toFixed(1)}`);
    }
  }
});

test('sea-stack beacons rise out of the water on raised sites', () => {
  const spec = specs.find(s => s.id === 'mission'), shape = shapes.get('mission');
  for (const mark of LAYOUTS.mission.landmarks.filter(m => m.stack)) {
    const h = shape.heightAt(...siteLocalToDir(spec.frame, spec.radius, ...mark.at));
    assert.ok(Math.abs(h - mark.stack.height) < 2.5, `${mark.id} stack top ${h.toFixed(1)} ~ ${mark.stack.height}`);
  }
});

test('atmospheres produce bright, colored daytime horizons', () => {
  for (const spec of specs) {
    const p = atmosphereParams(spec);
    assert.equal(p.betaM.length, 3);
    const fog = fogPalette(spec);
    const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    assert.ok(luma(fog.day) > 0.15, `${spec.id} horizon is bright (${luma(fog.day).toFixed(3)})`);
    assert.ok(luma(fog.night) < luma(fog.day));
  }
});
