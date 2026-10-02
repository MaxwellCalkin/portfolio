import * as THREE from 'three';

/**
 * Stylized cloud layer: a transparent shell around a planet with fbm
 * coverage, soft painterly lighting (bright sunlit tops, cool undersides,
 * warm terminator) and fades that hide the shell's geometry up close.
 */
export function createCloudLayer(spec, atmo) {
  const R = spec.radius, H = R * 0.17;
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uCamPlanet: atmo.uCamPlanet, uSunDir: atmo.uSunDir,
      uRadius: { value: R + H }, uCoverage: { value: spec.clouds ?? 0.4 }, uTime: { value: 0 },
      uTint: { value: new THREE.Color(spec.ambient?.sky || '#ffffff') }, uSunset: { value: new THREE.Vector3(...spec.atmosphere.sunset) },
      uSeed: { value: (spec.seed % 97) * 1.37 },
    },
    vertexShader: /* glsl */`
      varying vec3 vLocal;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vLocal;
      uniform vec3 uCamPlanet, uSunDir, uTint, uSunset;
      uniform float uRadius, uCoverage, uTime, uSeed;
      #include <logdepthbuf_pars_fragment>
      float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
      float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * n3(p); p = p * 2.07 + 3.1; a *= 0.5; } return v; }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vLocal);
        vec3 q = d * 5.5 + uSeed + vec3(uTime * 0.004, 0.0, uTime * 0.003);
        float warp = fbm(q * 0.7);
        float c = fbm(q + warp * 1.6);
        // Puffy clumps: sharpen the coverage edge, then add billowy interior detail.
        float edge = 0.62 - uCoverage * 0.22;
        float alpha = smoothstep(edge, edge + 0.12, c);
        if (alpha < 0.01) discard;
        float billow = fbm(q * 3.0 + 7.0);
        float sun = dot(d, uSunDir);
        float day = smoothstep(-0.12, 0.25, sun);
        float camR = length(uCamPlanet);
        bool below = camR < uRadius;
        vec3 lit = vec3(1.0, 0.99, 0.97) * (0.82 + 0.3 * billow);
        vec3 shade = mix(uTint * 0.62, vec3(0.62, 0.68, 0.78), 0.5);
        vec3 col = mix(shade, lit, below ? 0.35 + 0.25 * billow : 0.75);
        col = mix(col, uSunset * 1.05, (1.0 - smoothstep(0.0, 0.3, abs(sun - 0.05))) * 0.65);
        col *= mix(0.06, 1.0, day);
        // Fade where the shell is nearly edge-on or right next to the camera.
        vec3 toCam = uCamPlanet - vLocal;
        float dist = length(toCam);
        float grazing = abs(dot(normalize(toCam), d));
        alpha *= smoothstep(0.0, 0.12, grazing) * smoothstep(60.0, 420.0, dist);
        alpha *= below ? 0.88 : 0.95;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R + H, 160, 96), material);
  mesh.name = `${spec.id}-clouds`; mesh.renderOrder = 3; mesh.frustumCulled = false;
  mesh.position.fromArray(spec.position);
  return mesh;
}
