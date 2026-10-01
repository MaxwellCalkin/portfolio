import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* Art QA viewer. Query params:
   model=/models/x.glb  layout=grid|single  node=<name>  yaw=0.6 pitch=0.35 dist=1
   anim=<clip> t=<seconds>  bg=#rrggbb  ground=#rrggbb  wire=1  spin=1  palette=<world> */
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const info = document.getElementById('info');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1.05);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(q.get('bg') || '#7fa9c9');
scene.fog = new THREE.Fog(scene.background, 80, 400);
const camera = new THREE.PerspectiveCamera(num('fov', 35), innerWidth / innerHeight, 0.05, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight('#cfe6ff', '#6b5a4a', 1.4));
const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
sun.position.set(-6, 10, 7); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight('#9fdcff', 1.2); rim.position.set(5, 4, -8); scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(500, 64), new THREE.MeshStandardMaterial({ color: q.get('ground') || '#9aa48e', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const PALETTES = {
  philosophy: { Grass: '#79c99a', Leaf: '#3fae8c', LeafAlt: '#7fe0b5', Bark: '#6b5b4e', Rock: '#dfe8e0', RockDark: '#8fa8a0', Petal: '#ffd38a', Crystal: '#9ff5dc', Glow: '#8cf0d1', Sand: '#f1e3c0', Stone: '#e6ece6', Trim: '#8cf0d1' },
  experience: { Grass: '#e8c26a', Leaf: '#7d8f4a', LeafAlt: '#b38b4a', Bark: '#5a3b2e', Rock: '#c86e4c', RockDark: '#6e3a30', Petal: '#ff9a62', Crystal: '#ffb27a', Glow: '#ff9a62', Sand: '#e0a06a', Stone: '#d9a07a', Trim: '#ff9a62' },
  projects: { Grass: '#a98fe8', Leaf: '#8c6fe0', LeafAlt: '#c9a6ff', Bark: '#3d3557', Rock: '#5c5080', RockDark: '#3d3557', Petal: '#e2b8ff', Crystal: '#c9a6ff', Glow: '#e2b8ff', Sand: '#9c86d6', Stone: '#8d7fbf', Trim: '#e2b8ff' },
  mission: { Grass: '#4fa3a8', Leaf: '#2f7f8f', LeafAlt: '#7cc9c0', Bark: '#4a5566', Rock: '#b7cbe0', RockDark: '#6f8fb3', Petal: '#83e8ff', Crystal: '#a9f0ff', Glow: '#83e8ff', Sand: '#e6e2d0', Stone: '#c9d8e8', Trim: '#83e8ff' },
  contact: { Grass: '#c9b25a', Leaf: '#5f8f4a', LeafAlt: '#9fb85a', Bark: '#6e4a32', Rock: '#b9774a', RockDark: '#8c5233', Petal: '#ffd27a', Crystal: '#ffe3a0', Glow: '#ffd27a', Sand: '#e8c27a', Stone: '#e2c08f', Trim: '#ffd27a' },
};
const palette = PALETTES[q.get('palette')] || null;

function label(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = 'rgba(8,12,19,.75)'; g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#e9f7f2'; g.font = '28px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 32);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false })); s.renderOrder = 10; return s;
}
function triangles(object) {
  let n = 0; object.traverse(o => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return n;
}

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const url = q.get('model') || '/models/flora.glb';
loader.load(url, gltf => {
  const root = gltf.scene;
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    if (/^COL_/.test(o.name)) { o.visible = q.get('colliders') === '1'; if (o.visible) o.material = new THREE.MeshBasicMaterial({ color: '#ff3366', wireframe: true }); return; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (palette && palette[m.name]) m.color.set(palette[m.name]);
      if (palette && m.name === 'Glow') { m.emissive.set(palette.Glow); m.emissiveIntensity = 2; }
      if (q.get('wire') === '1') m.wireframe = true;
    }
  });
  let items = root.children.slice();
  if (q.get('node')) items = items.filter(o => o.name === q.get('node'));
  const lines = [`${url}  total tris: ${triangles(root)}  clips: ${gltf.animations.map(a => `${a.name}(${a.duration.toFixed(2)}s)`).join(', ') || 'none'}`];
  const holder = new THREE.Group(); scene.add(holder);
  if (q.get('layout') === 'single' || items.length === 1) {
    for (const item of items) holder.add(item);
  } else {
    const cols = Math.ceil(Math.sqrt(items.length));
    const boxes = items.map(o => new THREE.Box3().setFromObject(o));
    const cell = Math.max(2, ...boxes.map(b => Math.max(b.max.x - b.min.x, b.max.z - b.min.z))) * 1.25;
    items.forEach((item, i) => {
      const x = (i % cols - (cols - 1) / 2) * cell, z = (Math.floor(i / cols) - (Math.ceil(items.length / cols) - 1) / 2) * cell;
      item.position.x += x; item.position.z += z; holder.add(item);
      const b = boxes[i], size = b.getSize(new THREE.Vector3());
      const tag = label(item.name); tag.position.set(x, -0.15, z + size.z / 2 + cell * 0.12); tag.scale.set(cell * 0.6, cell * 0.075, 1); holder.add(tag);
      lines.push(`${String(i).padStart(2)} ${item.name.padEnd(20)} tris ${String(triangles(item)).padStart(5)}  size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
    });
  }
  info.textContent = lines.join('\n');
  const box = new THREE.Box3().setFromObject(holder), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62 * num('dist', 1);
  const yaw = num('yaw', 0.6), pitch = num('pitch', 0.32);
  const d = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(center.x + Math.sin(yaw) * Math.cos(pitch) * d, center.y + Math.sin(pitch) * d, center.z + Math.cos(yaw) * Math.cos(pitch) * d);
  controls.target.copy(center); controls.update();
  sun.target.position.copy(center); sun.position.copy(center).add(new THREE.Vector3(-0.45, 0.8, 0.5).multiplyScalar(radius * 3));
  const sc = sun.shadow.camera; sc.left = sc.bottom = -radius * 1.6; sc.right = sc.top = radius * 1.6; sc.near = 0.1; sc.far = radius * 8; sc.updateProjectionMatrix();
  scene.fog.near = d * 2; scene.fog.far = d * 8;
  let mixer = null;
  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(holder);
    const clip = gltf.animations.find(a => a.name === q.get('anim')) || gltf.animations[0];
    const action = mixer.clipAction(clip); if (q.has('t')) { action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; } action.play(); mixer.setTime(num('t', 0));
  }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (mixer && !q.has('t')) mixer.update(dt);
    if (q.get('spin') === '1') holder.rotation.y += dt * 0.4;
    controls.update(); renderer.render(scene, camera);
  });
  window.__ready = true;
}, undefined, err => { info.textContent = `Failed to load ${url}: ${err.message || err}`; window.__ready = true; window.__error = String(err); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
