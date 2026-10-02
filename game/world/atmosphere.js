import * as THREE from 'three';

/**
 * Single-scattering planetary atmosphere (Rayleigh + Mie) used three ways:
 *  1. A back-face shell around each planet: it is the sky dome while you
 *     stand on the planet and the glowing limb when you see it from space.
 *  2. A JS port that precomputes horizon/fog colors so distant terrain fades
 *     into the same sky it sits against.
 *  3. Shared parameters for terrain aerial perspective.
 * The atmosphere is deliberately ~40x thinner than Earth's relative to the
 * planet (these worlds are a few km across), so coefficients are scaled to give
 * Earth-like optical depths.
 */

export function atmosphereParams(spec) {
  const a = spec.atmosphere, R = spec.radius, top = R * (1 + a.height);
  const thickness = top - R, scaleR = thickness * 0.26, scaleM = thickness * 0.1;
  const density = a.density ?? 1;
  const betaR = a.rayleigh.map(c => c * 0.26 * density / scaleR);
  const betaM = 0.03 * (a.mie ?? 0.7) * density / scaleM;
  return { radius: R, top, scaleR, scaleM, betaR, betaM, mieG: 0.8, sunIntensity: 16, night: a.night, sunset: a.sunset };
}

/* ------------------------------------------------------------------ GLSL */
export const SCATTER_GLSL = /* glsl */`
uniform vec3 uCamPlanet;
uniform vec3 uSunDir;
uniform float uRadius;
uniform float uAtmoRadius;
uniform float uScaleR;
uniform float uScaleM;
uniform vec3 uBetaR;
uniform float uBetaM;
uniform float uMieG;
uniform float uSunIntensity;
uniform vec3 uNightGlow;
uniform int uSteps;

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return vec2(1e20, -1e20);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
// Soft planet shadow: 1 in sunlight, 0 in the planet's umbra.
float sunVisibility(vec3 pos) {
  float along = dot(pos, uSunDir);
  if (along >= 0.0) return 1.0;
  float closest = length(pos - uSunDir * along);
  return smoothstep(uRadius * 0.985, uRadius * 1.02, closest);
}
vec3 scatterAtmosphere(vec3 ro, vec3 rd, out vec3 transmittance) {
  transmittance = vec3(1.0);
  vec2 a = raySphere(ro, rd, uAtmoRadius);
  float t0 = max(a.x, 0.0), t1 = a.y;
  vec2 p = raySphere(ro, rd, uRadius);
  if (p.x > 0.0) t1 = min(t1, p.x);
  if (t1 <= t0) return vec3(0.0);
  float ds = (t1 - t0) / float(uSteps);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSteps) break;
    vec3 pos = ro + rd * (t0 + ds * (float(i) + 0.5));
    float h = max(length(pos) - uRadius, 0.0);
    float dR = exp(-h / uScaleR) * ds, dM = exp(-h / uScaleM) * ds;
    odR += dR; odM += dM;
    float lt = raySphere(pos, uSunDir, uAtmoRadius).y;
    float lds = lt * 0.25, lodR = 0.0, lodM = 0.0;
    for (int j = 0; j < 4; j++) {
      vec3 lp = pos + uSunDir * lds * (float(j) + 0.5);
      float lh = max(length(lp) - uRadius, 0.0);
      lodR += exp(-lh / uScaleR) * lds; lodM += exp(-lh / uScaleM) * lds;
    }
    vec3 tau = uBetaR * (odR + lodR) + uBetaM * 1.1 * (odM + lodM);
    vec3 att = exp(-tau) * sunVisibility(pos);
    sumR += dR * att; sumM += dM * att;
  }
  float mu = dot(rd, uSunDir), g = uMieG;
  float phaseR = 0.0596831 * (1.0 + mu * mu);
  float phaseM = 0.1193662 * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  transmittance = exp(-(uBetaR * odR + uBetaM * 1.1 * odM));
  vec3 night = uNightGlow * (1.0 - exp(-odR / uScaleR * 0.004)) ;
  return uSunIntensity * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM) + night;
}
`;

const shellVertex = /* glsl */`
varying vec3 vLocal;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const shellFragment = /* glsl */`
varying vec3 vLocal;
${SCATTER_GLSL}
uniform float uSunDisc;
uniform vec4 uOthers[6];
uniform int uOtherCount;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vLocal - uCamPlanet);
  vec3 T;
  vec3 color = scatterAtmosphere(uCamPlanet, rd, T);
  // Sun disc, only if the view ray clears the planet.
  vec2 hit = raySphere(uCamPlanet, rd, uRadius);
  float mu = dot(rd, uSunDir);
  if (hit.x < 0.0 || hit.x > 1e19) {
    float disc = smoothstep(0.99985, 0.99993, mu) * uSunDisc;
    color += vec3(1.0, 0.95, 0.85) * disc * 60.0 * T;
  }
  // Stylization: a touch more saturation than physics would give.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = max(mix(vec3(luma), color, 1.3), 0.0);
  // What lies behind (space, other worlds) shows through by transmittance; a
  // bright sky also softens it a little. Stars and nebula fade separately.
  float alpha = dot(T, vec3(0.3333)) * (1.0 - 0.4 * smoothstep(0.2, 0.9, luma));
  // Other worlds hang in this sky like big moons: keep them vivid.
  for (int i = 0; i < 6; i++) {
    if (i >= uOtherCount) break;
    vec2 o = raySphere(uCamPlanet - uOthers[i].xyz, rd, uOthers[i].w);
    if (o.x > 0.0 && o.x < 1e19) { color *= 0.3; alpha = mix(alpha, 1.0, 0.85); break; }
  }
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Uniforms shared between the shell and terrain materials of one planet. */
export function createAtmosphereUniforms(spec, quality = 'high') {
  const p = atmosphereParams(spec);
  return {
    uCamPlanet: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3() },
    uRadius: { value: p.radius },
    uAtmoRadius: { value: p.top },
    uScaleR: { value: p.scaleR },
    uScaleM: { value: p.scaleM },
    uBetaR: { value: new THREE.Vector3(...p.betaR) },
    uBetaM: { value: p.betaM },
    uMieG: { value: p.mieG },
    uSunIntensity: { value: p.sunIntensity },
    uNightGlow: { value: new THREE.Vector3(...p.night).multiplyScalar(0.5) },
    uSteps: { value: quality === 'low' ? 6 : 10 },
  };
}

export function createAtmosphereShell(spec, uniforms) {
  const p = atmosphereParams(spec);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSunDisc: { value: 1 }, uOthers: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uOtherCount: { value: 0 } },
    vertexShader: shellVertex,
    fragmentShader: shellFragment,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.top, 128, 80), material);
  mesh.name = `${spec.id}-atmosphere`;
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

/* -------------------------------------------------------------- JS port */
function raySphere(ro, rd, r) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - r * r, d = b * b - c;
  if (d < 0) return [1e20, -1e20];
  const s = Math.sqrt(d); return [-b - s, -b + s];
}
/** CPU scattering for a few directions per frame (fog/horizon colors). Returns [r,g,b]. */
export function scatterCPU(p, ro, rd, sunDir, steps = 12) {
  const a = raySphere(ro, rd, p.top);
  const t0 = Math.max(a[0], 0); let t1 = a[1];
  const hit = raySphere(ro, rd, p.radius); if (hit[0] > 0) t1 = Math.min(t1, hit[0]);
  if (t1 <= t0) return [0, 0, 0];
  const ds = (t1 - t0) / steps, sumR = [0, 0, 0], sumM = [0, 0, 0];
  let odR = 0, odM = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + ds * (i + 0.5), pos = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const h = Math.max(Math.hypot(...pos) - p.radius, 0), dR = Math.exp(-h / p.scaleR) * ds, dM = Math.exp(-h / p.scaleM) * ds;
    odR += dR; odM += dM;
    const lt = raySphere(pos, sunDir, p.top)[1], lds = lt / 4; let lodR = 0, lodM = 0;
    for (let j = 0; j < 4; j++) {
      const lp = [pos[0] + sunDir[0] * lds * (j + 0.5), pos[1] + sunDir[1] * lds * (j + 0.5), pos[2] + sunDir[2] * lds * (j + 0.5)];
      const lh = Math.max(Math.hypot(...lp) - p.radius, 0); lodR += Math.exp(-lh / p.scaleR) * lds; lodM += Math.exp(-lh / p.scaleM) * lds;
    }
    const along = pos[0] * sunDir[0] + pos[1] * sunDir[1] + pos[2] * sunDir[2];
    let vis = 1;
    if (along < 0) { const cl = Math.hypot(pos[0] - sunDir[0] * along, pos[1] - sunDir[1] * along, pos[2] - sunDir[2] * along); const x = Math.min(1, Math.max(0, (cl - p.radius * 0.985) / (p.radius * 0.035))); vis = x * x * (3 - 2 * x); }
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(p.betaR[c] * (odR + lodR) + p.betaM * 1.1 * (odM + lodM))) * vis;
      sumR[c] += dR * att; sumM[c] += dM * att;
    }
  }
  const mu = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2], g = p.mieG;
  const phaseR = 0.0596831 * (1 + mu * mu);
  const phaseM = 0.1193662 * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5));
  return [0, 1, 2].map(c => p.sunIntensity * (sumR[c] * p.betaR[c] * phaseR + sumM[c] * p.betaM * phaseM));
}

/**
 * Precomputes the fog palette for a planet: horizon colors at noon and at
 * sunset, sampled from the CPU scattering model, plus the night tint.
 */
export function fogPalette(spec) {
  const p = atmosphereParams(spec), R = p.radius;
  const up = [0, 1, 0], ro = [0, R + 20, 0];
  const horizon = (sunElevation, azimuthToSun) => {
    const sun = [Math.cos(sunElevation), Math.sin(sunElevation), 0];
    const rd = [Math.cos(azimuthToSun) * 0.995, 0.03, Math.sin(azimuthToSun) * 0.995];
    return scatterCPU(p, ro, rd, sun);
  };
  const avg = (...colors) => [0, 1, 2].map(c => colors.reduce((s, v) => s + v[c], 0) / colors.length);
  return {
    day: avg(horizon(1.2, 0), horizon(1.2, Math.PI)),
    sunset: avg(horizon(0.04, 0), horizon(0.04, 0.6)),
    night: p.night.map(c => c * 0.35),
    zenith: scatterCPU(p, ro, up, [Math.cos(1.2), Math.sin(1.2), 0]),
  };
}
