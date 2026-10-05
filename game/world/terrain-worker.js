import { createPlanetShape } from './planet-shape.js';
import { buildChunk } from './terrain-builder.js';
import { buildFloraCell } from './flora-cells.js';

/**
 * World worker: builds terrain chunk meshes and flora cells off the main
 * thread. Both are deterministic functions of the planet spec, so results are
 * identical to the main-thread fallback.
 */
const shapes = new Map();
const floraContexts = new Map();

export function runTask(task, getShape, getFlora) {
  if (task.type === 'build') return buildChunk(getShape(task.planet), task.node);
  if (task.type === 'flora') return buildFloraCell(getShape(task.planet), getFlora(task.planet), task.face, task.i, task.j, task.layers);
  throw new Error(`Unknown task ${task.type}`);
}

function transferables(result) {
  const list = [];
  if (result.positions) list.push(result.positions.buffer, result.normals.buffer, result.colors.buffer, result.aux.buffer);
  if (result.layers) for (const array of Object.values(result.layers)) list.push(array.buffer);
  return list;
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = event => {
    const message = event.data;
    if (message.type === 'init') {
      for (const spec of message.specs) shapes.set(spec.id, createPlanetShape(spec));
      self.postMessage({ type: 'ready' });
      return;
    }
    if (message.type === 'floraInit') { floraContexts.set(message.planet, message.ctx); return; }
    if (message.type === 'task') {
      try {
        const result = runTask(message.task, id => shapes.get(id), id => floraContexts.get(id));
        self.postMessage({ type: 'result', id: message.id, result }, transferables(result));
      } catch (error) {
        self.postMessage({ type: 'error', id: message.id, error: String(error?.message || error) });
      }
    }
  };
}
