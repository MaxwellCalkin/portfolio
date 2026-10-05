import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { SUN_DIRECTION } from './system.js';

/** Deep-space backdrop: nebula dome, starfield and the sun. */

export const SPACE_SCALE = { sky: 420000, stars: 380000, sunDistance: 300000 };

let glowTexture = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  if (typeof document === 'undefined') return null; // unit tests (no canvas): glows render as plain sprites
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.08, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,0.32)'); gradient.addColorStop(0.5, 'rgba(255,255,255,0.07)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 256, 256);
  glowTexture = new THREE.CanvasTexture(c); glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}
export function createGlow(color = '#ffffff', size = 1, opacity = 1) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
  sprite.scale.setScalar(size); return sprite;
}

const SKY_NOISE = /* glsl */`
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sHash(i), sHash(i + vec3(1,0,0)), f.x), mix(sHash(i + vec3(0,1,0)), sHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(sHash(i + vec3(0,0,1)), sHash(i + vec3(1,0,1)), f.x), mix(sHash(i + vec3(0,1,1)), sHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float sFbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * sNoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return v; }
`;

export function createNebula() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uSunDir: { value: new THREE.Vector3(...SUN_DIRECTION) }, uFade: { value: 1 } },
    vertexShader: /* glsl */`varying vec3 vDir;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`varying vec3 vDir; uniform vec3 uSunDir; uniform float uFade;
      ${SKY_NOISE}
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vDir);
        // A tilted galactic band with dust lanes, teal on one side and wine on the other.
        vec3 axis = normalize(vec3(0.25, 0.9, -0.35));
        float band = exp(-pow(dot(d, axis) / 0.32, 2.0));
        float n = sFbm(d * 3.2 + 4.0), detail = sFbm(d * 9.0 + n * 3.0);
        float dust = smoothstep(0.38, 0.75, n) * band;
        float lanes = smoothstep(0.55, 0.75, sFbm(d * 6.5 + 13.0)) * band;
        vec3 teal = vec3(0.035, 0.11, 0.13), wine = vec3(0.16, 0.055, 0.07), violet = vec3(0.07, 0.045, 0.14);
        vec3 tint = mix(mix(teal, violet, smoothstep(-0.4, 0.3, d.x)), wine, smoothstep(0.1, 0.8, d.z * 0.7 - d.x * 0.4));
        vec3 sky = vec3(0.004, 0.008, 0.014) + tint * dust * 1.2 + vec3(0.09, 0.12, 0.14) * pow(detail, 3.0) * band * 0.9;
        sky *= 1.0 - lanes * 0.55;
        // Warm light bleeding around the sun direction.
        float sunGlow = pow(max(dot(d, uSunDir), 0.0), 18.0);
        sky += vec3(0.25, 0.17, 0.09) * sunGlow * 0.12;
        gl_FragColor = vec4(sky * uFade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SPACE_SCALE.sky, 48, 32), material);
  mesh.renderOrder = -100; mesh.frustumCulled = false; mesh.name = 'nebula';
  return mesh;
}

export function createStarfield(count = 9000, seed = 42) {
  const random = mulberry32(seed), positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const color = new THREE.Color(), axis = new THREE.Vector3(0.25, 0.9, -0.35).normalize(), v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Concentrate ~45% of stars in the galactic band.
    let accepted = false;
    while (!accepted) {
      const y = random() * 2 - 1, theta = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      v.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
      accepted = random() < 0.55 + 0.45 * Math.exp(-Math.pow(v.dot(axis) / 0.3, 2));
    }
    v.multiplyScalar(SPACE_SCALE.stars * (0.92 + random() * 0.08));
    positions.set([v.x, v.y, v.z], i * 3);
    const warm = random() < 0.28;
    color.setHSL(warm ? 0.07 + random() * 0.06 : 0.55 + random() * 0.1, 0.25 + random() * 0.4, 0.62 + random() * 0.33);
    colors.set([color.r, color.g, color.b], i * 3);
    sizes[i] = random() < 0.025 ? 3.6 + random() * 2.4 : 0.9 + Math.pow(random(), 3) * 2.2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uFade: { value: 1 } },
    vertexShader: /* glsl */`attribute float size; varying vec3 vColor; uniform float uTime, uPixelRatio;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float twinkle = 0.85 + 0.15 * sin(uTime * 1.7 + position.x * 0.013 + position.y * 0.007);
        gl_PointSize = size * twinkle * uPixelRatio;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`varying vec3 vColor; uniform float uFade;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - 0.5); float a = 1.0 - smoothstep(0.08, 0.5, d);
        gl_FragColor = vec4(vColor * 1.6, a * uFade);
      }`,
    transparent: true, vertexColors: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -90; points.frustumCulled = false; points.name = 'stars';
  return points;
}

/** The sun: a hot disc with layered glow, placed far along SUN_DIRECTION. */
export function createSun() {
  const group = new THREE.Group(); group.name = 'sun';
  const d = SPACE_SCALE.sunDistance;
  group.position.set(SUN_DIRECTION[0] * d, SUN_DIRECTION[1] * d, SUN_DIRECTION[2] * d);
  const core = new THREE.Mesh(new THREE.SphereGeometry(d * 0.012, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.4, 4.4), toneMapped: true }));
  group.add(core);
  const inner = createGlow('#fff2d6', d * 0.09, 0.95), outer = createGlow('#ffcf8a', d * 0.42, 0.35);
  group.add(inner, outer);
  group.userData = { core, inner, outer };
  return group;
}
