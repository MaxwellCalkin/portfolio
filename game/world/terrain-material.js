import * as THREE from 'three';

/**
 * Stylized terrain material: MeshStandardMaterial (so shadows, fog and log
 * depth keep working) extended with
 *  - painterly detail noise in planet-local space,
 *  - flat shaded water with depth tint, foam and ripples (below sea level the
 *    chunk vertices are clamped onto the sea surface),
 *  - bioluminescent night glow,
 *  - day/night ambient driven by the local sun angle,
 *  - aerial perspective that matches the atmosphere shell.
 */
const NOISE_GLSL = /* glsl */`
float tHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tHash(i), tHash(i + vec3(1,0,0)), f.x), mix(tHash(i + vec3(0,1,0)), tHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tHash(i + vec3(0,0,1)), tHash(i + vec3(1,0,1)), f.x), mix(tHash(i + vec3(0,1,1)), tHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

export function createTerrainMaterial(spec, atmo, fog) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
  const color = c => new THREE.Color(c);
  const uniforms = {
    uPlanetCenter: { value: new THREE.Vector3(...spec.position) },
    uCamPlanet: atmo.uCamPlanet,
    uSunDir: atmo.uSunDir,
    uRadius: atmo.uRadius,
    uAtmoRadius: atmo.uAtmoRadius,
    uScaleR: atmo.uScaleR,
    uTime: { value: 0 },
    uWater: { value: color(spec.palette.water) },
    uWaterDeep: { value: color(spec.palette.waterDeep) },
    uFoam: { value: color(spec.palette.foam) },
    uGlow: { value: color(spec.palette.glow) },
    uFogDay: { value: new THREE.Vector3(...fog.day) },
    uFogSunset: { value: new THREE.Vector3(...fog.sunset) },
    uFogNight: { value: new THREE.Vector3(...fog.night) },
    uSkyZenith: { value: new THREE.Vector3(...fog.zenith) },
    uFogDensity: { value: 1 / (spec.radius * 0.55) * (spec.fog ?? 1) },
    uAmbientNight: { value: 0.14 },
    uDetail: { value: 1 },
  };
  material.userData.uniforms = uniforms;
  material.customProgramCacheKey = () => 'unfolding-terrain-v1';
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aux;
varying vec2 vAux;
varying vec3 vPlanetPos;
uniform vec3 uPlanetCenter;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vAux = aux;
vPlanetPos = (modelMatrix * vec4(transformed, 1.0)).xyz - uPlanetCenter;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vAux;
varying vec3 vPlanetPos;
uniform vec3 uCamPlanet, uSunDir, uWater, uWaterDeep, uFoam, uGlow, uFogDay, uFogSunset, uFogNight, uSkyZenith;
uniform float uRadius, uAtmoRadius, uScaleR, uTime, uFogDensity, uAmbientNight, uDetail;
${NOISE_GLSL}
float waterMask;
float sunCosLocal;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 up = normalize(vPlanetPos);
  sunCosLocal = dot(up, uSunDir);
  float camDist = length(vPlanetPos - uCamPlanet);
  float near = 1.0 - smoothstep(60.0, 900.0, camDist);
  // Painterly breakup: two octaves of value noise, fading with distance.
  float n1 = tNoise(vPlanetPos * 0.35), n2 = tNoise(vPlanetPos * 1.7 + 11.0);
  diffuseColor.rgb *= mix(1.0, 0.86 + 0.22 * n1 + 0.1 * (n2 - 0.5), near * uDetail);
  // Water: depth tint, shoreline foam, gentle animated ripples.
  float depth = vAux.x;
  waterMask = smoothstep(0.02, 0.35, depth);
  if (waterMask > 0.0) {
    vec3 water = mix(uWater, uWaterDeep, smoothstep(0.5, 28.0, depth));
    float ripple = tNoise(vPlanetPos * 0.18 + vec3(uTime * 0.25, 0.0, uTime * 0.18));
    float foamBand = (1.0 - smoothstep(0.1, 1.1 + ripple * 0.8, depth)) * smoothstep(0.02, 0.15, depth);
    water = mix(water, uFoam, clamp(foamBand * 0.85, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, water, waterMask);
  }
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.16, waterMask);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (waterMask > 0.0) {
  float t = uTime;
  vec3 q = vPlanetPos * 0.08;
  vec3 wobble = vec3(tNoise(q + vec3(t * 0.3, 0.0, 0.0)) - 0.5, 0.0, tNoise(q + vec3(0.0, 0.0, t * 0.27) + 5.0) - 0.5);
  normal = normalize(normal + (viewMatrix * vec4(wobble * 0.22 * waterMask, 0.0)).xyz);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float night = 1.0 - smoothstep(-0.12, 0.08, sunCosLocal);
  float pulse = 0.75 + 0.25 * sin(uTime * 1.3 + vPlanetPos.x * 0.05 + vPlanetPos.z * 0.04);
  totalEmissiveRadiance += uGlow * vAux.y * night * pulse * 0.9;
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  float day = smoothstep(-0.18, 0.22, sunCosLocal);
  reflectedLight.indirectDiffuse *= mix(uAmbientNight, 1.0, day);
  reflectedLight.indirectSpecular *= mix(uAmbientNight, 1.0, day);
  if (waterMask > 0.0) {
    // Fake sky reflection: water mirrors the atmosphere with Fresnel falloff.
    float fresnel = 0.04 + 0.96 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
    vec3 sky = mix(uFogDay, uSkyZenith, 0.35) * mix(0.05, 1.0, day);
    reflectedLight.indirectSpecular += sky * fresnel * waterMask * 0.9;
    float glint = pow(saturate(tNoise(vPlanetPos * 2.6 + vec3(uTime * 0.9, 0.0, uTime * 0.7))), 14.0) * day;
    reflectedLight.directSpecular += vec3(glint) * 3.0 * waterMask * (1.0 - smoothstep(60.0, 400.0, length(vPlanetPos - uCamPlanet)));
  }
}`)
      .replace('#include <opaque_fragment>', `
{
  // Aerial perspective: optical path through the atmosphere shell.
  vec3 ro = uCamPlanet, rd = vPlanetPos - uCamPlanet;
  float len = length(rd); rd /= len;
  float b = dot(ro, rd), c = dot(ro, ro) - uAtmoRadius * uAtmoRadius, disc = b * b - c;
  float t0 = disc > 0.0 ? max(0.0, -b - sqrt(disc)) : len;
  float segment = max(0.0, len - t0);
  vec3 mid = ro + rd * (t0 + len) * 0.5;
  float density = exp(-max(length(mid) - uRadius, 0.0) / (uScaleR * 2.2));
  float fogAmount = 1.0 - exp(-segment * uFogDensity * density);
  float s = dot(normalize(mid), uSunDir);
  vec3 fogColor = mix(uFogNight, uFogDay, smoothstep(-0.1, 0.35, s));
  fogColor = mix(fogColor, uFogSunset, (1.0 - smoothstep(0.0, 0.32, abs(s - 0.06))) * 0.75);
  outgoingLight = mix(outgoingLight, fogColor, fogAmount);
}
#include <opaque_fragment>`);
  };
  return material;
}
