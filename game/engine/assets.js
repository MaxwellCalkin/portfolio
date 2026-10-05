import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Shared, cached GLB loading (meshopt-compressed assets from public/models). */
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();

export function modelUrl(name) {
  return `${import.meta.env?.BASE_URL ?? '/'}models/${name}`;
}

export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(name, new Promise((resolve, reject) => loader.load(modelUrl(name), resolve, undefined, reject)));
  }
  return cache.get(name);
}

export async function loadJSON(name) {
  const response = await fetch(modelUrl(name));
  if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
  return response.json();
}
