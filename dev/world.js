import * as THREE from 'three';
import { Universe } from '../game/world/universe.js';
import { PLANETS } from '../game/world/system.js';
import { siteLocalToDir } from '../game/world/planet-shape.js';
import { Flora } from '../game/world/flora.js';
import { loadModel, loadJSON } from '../game/engine/assets.js';

/* World lab: free camera for art direction.
   ?planet=philosophy&alt=3&yaw=0&pitch=-0.05&x=0&z=0  (on/near the main site)
   ?planet=philosophy&orbit=2.4&az=0.5&el=0.3            (view from space, distance in radii)
   ?quality=high|medium|low  &wait=1 (wait for terrain to settle) */
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const hud = document.getElementById('hud');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = q.get('tm') === 'aces' ? THREE.ACESFilmicToneMapping : q.get('tm') === 'agx' ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
renderer.toneMappingExposure = num('exposure', 1.0);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.3, 900000);
const universe = new Universe(scene, { quality: q.get('quality') || 'high' });
window.universe = universe; window.camera = camera; window.scene = scene;
let flora = null;
if (q.get('flora') !== '0') Promise.all([loadModel('flora.glb'), loadJSON('flora.json')]).then(([gltf, manifest]) => { flora = new Flora(scene, universe, gltf, manifest, { quality: q.get('quality') || 'high' }); window.flora = flora; }).catch(e => console.error(e));

const planet = universe.planets.find(p => p.spec.id === (q.get('planet') || 'philosophy')) || universe.planets[0];
const center = planet.center, R = planet.spec.radius;
const yaw = num('yaw', 0), pitch = num('pitch', -0.05);
if (q.has('orbit')) {
  const az = num('az', 0.4), el = num('el', 0.25), d = R * num('orbit', 2.5);
  const sun = universe.sunDir.clone();
  const side = new THREE.Vector3(0, 1, 0).cross(sun).normalize(), upv = sun.clone().cross(side).normalize();
  const dir = sun.clone().multiplyScalar(Math.cos(az) * Math.cos(el)).addScaledVector(side, Math.sin(az) * Math.cos(el)).addScaledVector(upv, Math.sin(el)).normalize();
  camera.position.copy(center).addScaledVector(dir, d);
  camera.up.copy(upv); camera.lookAt(center);
} else {
  const frame = planet.spec.frame;
  const dir = siteLocalToDir(frame, R, num('x', 0), num('z', 0));
  const up = new THREE.Vector3(...dir);
  const ground = planet.shape.surfaceRadius(dir[0], dir[1], dir[2]);
  camera.position.copy(center).addScaledVector(up, ground + num('alt', 2.2));
  const f = new THREE.Vector3(...frame.forward), r = new THREE.Vector3(...frame.right);
  // Re-project the site frame at the camera's own location.
  f.addScaledVector(up, -f.dot(up)).normalize(); r.crossVectors(f, up).normalize();
  const look = f.clone().applyAxisAngle(up, yaw);
  const pitchAxis = new THREE.Vector3().crossVectors(look, up).normalize();
  look.applyAxisAngle(pitchAxis, pitch);
  camera.up.copy(up); camera.lookAt(camera.position.clone().add(look));
}

// Free-fly controls for interactive use.
const keys = new Set(); let drag = null, speed = num('speed', 20);
addEventListener('keydown', e => keys.add(e.key.toLowerCase())); addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; }); addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY };
  camera.rotateOnWorldAxis(camera.up, -dx * 0.003); camera.rotateX(-dy * 0.003); });
addEventListener('wheel', e => { speed *= e.deltaY > 0 ? 0.8 : 1.25; });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

const clock = new THREE.Clock(); let time = num('time', 0), frames = 0, settled = 0, fpsTime = 0, fps = 0, fpsFrames = 0;
const tmp = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1); time += dt; frames++;
  const boost = keys.has('shift') ? 12 : 1;
  tmp.set((keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0), (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0), (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0));
  if (tmp.lengthSq()) camera.translateOnAxis(tmp.normalize(), speed * boost * dt);
  const local = universe.update(time, camera, camera.position);
  const fs = flora ? flora.update(camera.position, time) : null;
  renderer.render(scene, camera);
  fpsTime += dt; fpsFrames++; if (fpsTime > 0.5) { fps = fpsFrames / fpsTime; fpsTime = 0; fpsFrames = 0; }
  const s = universe.stats().find(x => x.id === local.planet?.spec.id) || {};
  hud.textContent = `${local.planet?.spec.id} alt ${local.altitude.toFixed(1)} m  day ${local.day.toFixed(2)}  fps ${fps.toFixed(0)}\nchunks ${s.visible} pending ${s.pending} cached ${s.cached} tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k calls ${renderer.info.render.calls}`;
  if (fs) hud.textContent += `\nflora ${fs.instances} inst, ${fs.cells} cells, ${fs.pending} pending`;
  if (s.pending === 0 && (q.get('flora') === '0' || (fs && fs.pending === 0 && fs.instances > 0) || local.altitude > 600)) settled++; else settled = 0;
  if (frames > 20 && (settled > 6 || frames > num('maxFrames', 900))) window.__ready = true;
  requestAnimationFrame(frame);
}
frame();
