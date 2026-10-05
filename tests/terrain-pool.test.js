import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainWorkerPool } from '../game/world/terrain-lod.js';
import { prepareSpecs } from '../game/world/layout.js';
import { createPlanetShape } from '../game/world/planet-shape.js';

test('a crashed terrain worker hands its unfinished chunks back to be built', () => {
  const made = [];
  globalThis.Worker = class {
    constructor() { this.posted = []; made.push(this); }
    postMessage(message) { this.posted.push(message); }
    terminate() { this.terminated = true; }
  };
  try {
    const specs = prepareSpecs(), shapes = new Map(specs.map(s => [s.id, createPlanetShape(s)]));
    const pool = new TerrainWorkerPool(specs, { size: 1, shapes });
    const [worker] = made;
    worker.onmessage({ data: { type: 'ready' } });
    const built = [];
    pool.request({ type: 'build', planet: specs[0].id, node: { face: 0, level: 0, ix: 0, iy: 0, N: 4 } }, 0, chunk => built.push(chunk));
    pool.pump();
    assert.equal(worker.posted.filter(m => m.type === 'task').length, 1, 'the chunk went to the worker');
    worker.onerror(new Error('worker crashed'));
    assert.ok(worker.terminated);
    assert.equal(pool.usable, false);
    pool.pump(50); // no workers left: the main thread finishes the chunk
    assert.equal(built.length, 1);
    assert.ok(built[0].positions.length > 0);
  } finally {
    delete globalThis.Worker;
  }
});
