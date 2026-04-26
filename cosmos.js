/* =============================================================
   cosmos.js — hero visualization
   Concentric holonic rings of particles representing depth × span
   ============================================================= */
(() => {
  if (typeof THREE === 'undefined') {
    console.warn('Three.js not loaded');
    return;
  }

  const canvas = document.getElementById('cosmos');
  if (!canvas) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- renderer / scene / camera ----
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x06060c, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06060c, 0.035);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 14);

  // ---- holon rings ----
  // Each ring has more points (span widens) and varies vertically (depth deepens)
  const ringGroup = new THREE.Group();
  scene.add(ringGroup);

  const ringConfigs = [
    { radius: 2.2, count: 60,  color: 0xf4c971, size: 0.055 },
    { radius: 3.5, count: 140, color: 0xe6a25c, size: 0.05 },
    { radius: 4.9, count: 260, color: 0xd08a6a, size: 0.045 },
    { radius: 6.4, count: 420, color: 0xb1739a, size: 0.04 },
    { radius: 8.0, count: 620, color: 0x8b6fd4, size: 0.035 },
    { radius: 9.8, count: 860, color: 0x7ad3c0, size: 0.03 },
  ];

  const rings = [];

  ringConfigs.forEach((cfg, idx) => {
    const positions = new Float32Array(cfg.count * 3);
    const aRand = new Float32Array(cfg.count);
    for (let i = 0; i < cfg.count; i++) {
      const angle = (i / cfg.count) * Math.PI * 2 + Math.random() * 0.08;
      const jitterR = cfg.radius + (Math.random() - 0.5) * 0.3;
      const jitterY = (Math.random() - 0.5) * 0.4;
      positions[i * 3]     = Math.cos(angle) * jitterR;
      positions[i * 3 + 1] = jitterY;
      positions[i * 3 + 2] = Math.sin(angle) * jitterR;
      aRand[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: cfg.size * 22 },
        uColor: { value: new THREE.Color(cfg.color) },
        uPixelRatio: { value: renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute float aRand;
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vRand;
        varying float vDist;
        void main() {
          vRand = aRand;
          vec3 p = position;
          // gentle vertical oscillation
          p.y += sin(uTime * 0.3 + aRand * 6.28) * 0.15;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (1.0 + 0.3 * sin(uTime * 2.0 + aRand * 10.0)) * (10.0 / vDist);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vRand;
        varying float vDist;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float alpha = smoothstep(0.5, 0.0, d);
          alpha *= 0.7 + 0.3 * vRand;
          // slight color bloom for close particles
          vec3 col = uColor * (1.0 + 0.4 * (1.0 - smoothstep(5.0, 20.0, vDist)));
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const pts = new THREE.Points(geo, mat);
    pts.userData = {
      baseRotationSpeed: (0.025 + idx * 0.006) * (idx % 2 === 0 ? 1 : -1),
      radius: cfg.radius,
    };
    ringGroup.add(pts);
    rings.push(pts);

    // ring outline (subtle)
    const ringGeo = new THREE.RingGeometry(cfg.radius - 0.005, cfg.radius + 0.005, 256);
    const ringMat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringGroup.add(ringMesh);
  });

  // ---- central core ----
  const coreGeo = new THREE.SphereGeometry(0.2, 32, 32);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vNormal;
      void main() {
        float fres = pow(1.0 - dot(vNormal, vec3(0, 0, 1)), 2.0);
        vec3 col = mix(vec3(1.0, 0.85, 0.52), vec3(1.0, 0.95, 0.8), fres);
        float pulse = 0.8 + 0.2 * sin(uTime * 2.0);
        gl_FragColor = vec4(col * pulse, 1.0);
      }
    `,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  scene.add(core);

  // Core halo
  const haloGeo = new THREE.SphereGeometry(0.8, 32, 32);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vNormal;
      void main() {
        float fres = pow(1.0 - abs(dot(vNormal, vec3(0, 0, 1))), 3.0);
        vec3 col = vec3(0.96, 0.78, 0.45);
        float pulse = 0.5 + 0.2 * sin(uTime * 1.2);
        gl_FragColor = vec4(col, fres * pulse * 0.6);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  scene.add(halo);

  // ---- starfield backdrop ----
  const starCount = 1200;
  const starPositions = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    // distribute on outer shell
    const r = 18 + Math.random() * 12;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPositions[i * 3 + 2] = r * Math.cos(phi);
    starSizes[i] = Math.random();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute('aRand', new THREE.BufferAttribute(starSizes, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute float aRand;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vRand;
      void main() {
        vRand = aRand;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.0 + 2.0 * aRand) * uPixelRatio;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying float vRand;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float twinkle = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 1.2 + vRand * 25.0));
        float a = smoothstep(0.5, 0.0, d) * twinkle * (0.3 + 0.7 * vRand);
        gl_FragColor = vec4(0.95, 0.88, 0.78, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // ---- resize ----
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

    // adjust camera distance based on aspect so the rings always fit
    if (w < 800) camera.position.z = 16;
    else camera.position.z = 14;

    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- mouse parallax ----
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth - 0.5) * 2;
    target.y = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // scroll-tilt: tilts the whole ring group as you scroll down
  let scrollY = 0;
  window.addEventListener('scroll', () => {
    scrollY = window.scrollY;
  }, { passive: true });

  // ---- animate ----
  const clock = new THREE.Clock();
  function tick() {
    const t = clock.getElapsedTime();
    const dt = clock.getDelta();

    // smooth mouse lerp
    current.x += (target.x - current.x) * 0.04;
    current.y += (target.y - current.y) * 0.04;

    // scroll-based tilt
    const tilt = Math.min(scrollY / 800, 1);

    // ring rotation & breathing
    ringGroup.rotation.x = Math.PI * 0.15 + current.y * 0.15 + tilt * 0.4;
    ringGroup.rotation.z = current.x * 0.1;

    rings.forEach((ring, i) => {
      ring.rotation.y += ring.userData.baseRotationSpeed * 0.01 * (reduceMotion ? 0 : 1);
      if (ring.material.uniforms) {
        ring.material.uniforms.uTime.value = t;
      }
    });

    // core pulse
    coreMat.uniforms.uTime.value = t;
    haloMat.uniforms.uTime.value = t;
    core.scale.setScalar(1 + 0.05 * Math.sin(t * 2));
    halo.scale.setScalar(1 + 0.08 * Math.sin(t * 1.2));

    // stars twinkle + slow drift
    starMat.uniforms.uTime.value = t;
    stars.rotation.y = t * 0.005;
    stars.rotation.x = -tilt * 0.2;

    // subtle camera breath
    camera.position.y = current.y * -0.6;
    camera.position.x = current.x * 0.6;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
})();
