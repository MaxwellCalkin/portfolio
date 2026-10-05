import { createSimplex3, fbm, ridged, smoothstep, clamp, lerp } from './noise.js';

/**
 * Analytic planet relief and surface coloring.
 *
 * Every function takes a UNIT direction from the planet center and returns
 * meters relative to the base radius. The same module runs in the terrain
 * workers (mesh generation) and on the main thread (physics, prop placement),
 * so walking, landing and rendering agree.
 *
 * Plain JS only: no three.js, no DOM.
 */

const hex = value => {
  const n = parseInt(String(value).replace('#', ''), 16);
  // sRGB -> linear, so vertex colors match three.js material color management.
  const toLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return [toLinear((n >> 16) & 255), toLinear((n >> 8) & 255), toLinear(n & 255)];
};
const mix3 = (out, a, b, t) => { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; return out; };

/** Orthonormal tangent frame at a unit direction, stable everywhere. */
export function tangentFrame(up, hint = [0, 1, 0]) {
  let fx = hint[0], fy = hint[1], fz = hint[2];
  const d = fx * up[0] + fy * up[1] + fz * up[2];
  fx -= up[0] * d; fy -= up[1] * d; fz -= up[2] * d;
  let l = Math.hypot(fx, fy, fz);
  if (l < 1e-6) { fx = 1; fy = 0; fz = 0; const d2 = up[0]; fx -= up[0] * d2; fy -= up[1] * d2; fz -= up[2] * d2; l = Math.hypot(fx, fy, fz); }
  const forward = [fx / l, fy / l, fz / l];
  // right = forward x up
  const right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
  return { up: [...up], forward, right };
}

/**
 * Converts site-local tangent coordinates (meters; +x right, -z forward, like
 * three.js) into a unit direction by walking along great circles.
 */
export function siteLocalToDir(frame, radius, x, z) {
  const dist = Math.hypot(x, z);
  if (dist < 1e-9) return [...frame.up];
  const angle = dist / radius, s = Math.sin(angle) / dist, c = Math.cos(angle);
  const tx = frame.right[0] * x - frame.forward[0] * z, ty = frame.right[1] * x - frame.forward[1] * z, tz = frame.right[2] * x - frame.forward[2] * z;
  const v = [frame.up[0] * c + tx * s, frame.up[1] * c + ty * s, frame.up[2] * c + tz * s];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Inverse of siteLocalToDir (azimuthal equidistant). */
export function dirToSiteLocal(frame, radius, dir) {
  const c = clamp(dir[0] * frame.up[0] + dir[1] * frame.up[1] + dir[2] * frame.up[2], -1, 1);
  const tx = dir[0] - frame.up[0] * c, ty = dir[1] - frame.up[1] * c, tz = dir[2] - frame.up[2] * c;
  const s = Math.hypot(tx, ty, tz);
  if (s < 1e-12) return [0, 0];
  const k = Math.atan2(s, c) * radius / s;
  return [(tx * frame.right[0] + ty * frame.right[1] + tz * frame.right[2]) * k, -(tx * frame.forward[0] + ty * frame.forward[1] + tz * frame.forward[2]) * k];
}

export function createPlanetShape(spec) {
  const R = spec.radius, kind = spec.terrain.kind, seed = spec.seed | 0;
  const seaLevel = spec.terrain.seaLevel ?? null;
  const n1 = createSimplex3(seed + 1), n2 = createSimplex3(seed + 2), n3 = createSimplex3(seed + 3);
  const n4 = createSimplex3(seed + 4), n5 = createSimplex3(seed + 5), n6 = createSimplex3(seed + 6);
  const P = {};
  for (const [key, value] of Object.entries(spec.palette)) P[key] = hex(value);
  // Distances in "unit sphere" noise space: 1 unit = R meters.
  const perMeter = 1 / R;

  /* ---------------------------------------------------------------- relief */
  function warp(x, y, z, f, a) {
    return [x + n5(x * f, y * f, z * f) * a, y + n5(x * f + 31.7, y * f - 12.1, z * f + 7.3) * a, z + n5(x * f - 19.3, y * f + 3.9, z * f - 27.5) * a];
  }
  function archipelago(x, y, z) {
    const [wx, wy, wz] = warp(x, y, z, 2.2, 0.16);
    const land = fbm(n1, wx * 1.45, wy * 1.45, wz * 1.45, 4) - 0.02;
    const detail = fbm(n6, x * 140, y * 140, z * 140, 3) * 1.6 + n6(x * 620, y * 620, z * 620) * 0.35;
    if (land < 0) {
      const shelf = smoothstep(0, -0.035, land);
      return lerp(0.6, -7, shelf) + Math.max(-95, (land + 0.035) * 320) * smoothstep(-0.03, -0.06, land) + detail * 0.4;
    }
    const coast = smoothstep(0.0, 0.07, land);
    const hills = (fbm(n3, x * 16, y * 16, z * 16, 4) * 0.5 + 0.5) * 42 * smoothstep(0.02, 0.18, land);
    const ridge = Math.pow(ridged(n4, x * 6.5, y * 6.5, z * 6.5, 4), 1.6) * 150 * smoothstep(0.1, 0.38, land);
    return 0.6 + coast * 9 + hills + ridge + detail * coast;
  }
  function canyons(x, y, z) {
    const [wx, wy, wz] = warp(x, y, z, 1.6, 0.12);
    const base = fbm(n1, wx * 1.9, wy * 1.9, wz * 1.9, 4) * 0.5 + 0.5;
    const raw = Math.pow(base, 1.15) * 330 + fbm(n2, x * 10, y * 10, z * 10, 4) * 34;
    const step = 26, t = Math.max(0, raw) / step, fl = Math.floor(t), fr = t - fl;
    let h = (fl + smoothstep(0.74, 0.96, fr)) * step;
    h += fbm(n3, x * 70, y * 70, z * 70, 3) * 2.2;
    // Winding slot canyons carve the plateaus.
    const v = Math.abs(n4(wx * 3.4, wy * 3.4, wz * 3.4) + n6(x * 9, y * 9, z * 9) * 0.12);
    const canyon = 1 - smoothstep(0.015, 0.075, v);
    h -= canyon * (h * 0.8 + 12);
    return h;
  }
  function crystal(x, y, z) {
    const [wx, wy, wz] = warp(x, y, z, 2.0, 0.14);
    const hills = fbm(n1, wx * 3.2, wy * 3.2, wz * 3.2, 5) * 68;
    const mask = smoothstep(-0.15, 0.35, fbm(n3, x * 1.6, y * 1.6, z * 1.6, 3));
    const ridgeLine = Math.pow(ridged(n2, wx * 7.5, wy * 7.5, wz * 7.5, 5), 2.2) * 150 * mask;
    const terrace = Math.round((hills + ridgeLine) / 18) * 18;
    const h = lerp(hills + ridgeLine, terrace, 0.22);
    return h + fbm(n6, x * 150, y * 150, z * 150, 2) * 1.1;
  }
  function ocean(x, y, z) {
    const [wx, wy, wz] = warp(x, y, z, 1.8, 0.2);
    const land = fbm(n1, wx * 1.25, wy * 1.25, wz * 1.25, 5) - 0.1;
    const detail = fbm(n6, x * 120, y * 120, z * 120, 3) * 1.4;
    if (land < 0) {
      // Sea stacks: tall rocky pillars just offshore.
      const stack = smoothstep(0.62, 0.7, n4(x * 55, y * 55, z * 55)) * smoothstep(-0.07, -0.01, land);
      const floor = lerp(-3, -150, smoothstep(0, -0.09, land));
      return lerp(floor, 46 + n3(x * 80, y * 80, z * 80) * 14, stack) + detail * 0.5;
    }
    const cliff = smoothstep(0.0, 0.028, land);
    const plateau = 54 + fbm(n2, x * 5, y * 5, z * 5, 3) * 30 + Math.pow(ridged(n3, x * 9, y * 9, z * 9, 4), 1.7) * 90 * smoothstep(0.08, 0.3, land);
    return 0.8 + cliff * plateau + detail * cliff;
  }
  function dunes(x, y, z) {
    const [wx, wy, wz] = warp(x, y, z, 2.4, 0.08);
    const swell = fbm(n2, x * 2.4, y * 2.4, z * 2.4, 4) * 46 + 46;
    const crest = Math.pow(1 - Math.abs(n1(wx * 7, wy * 30, wz * 7)), 2.6);
    const dune = crest * 17 * (0.55 + 0.45 * fbm(n3, x * 4, y * 4, z * 4, 2));
    const butteMask = smoothstep(0.5, 0.58, n4(x * 3.3, y * 3.3, z * 3.3));
    const butte = butteMask * (64 + Math.floor((fbm(n5, x * 12, y * 12, z * 12, 2) * 0.5 + 0.5) * 3) * 14);
    return Math.max(swell + dune, butte > 0 ? swell + butte : 0) + n6(x * 300, y * 300, z * 300) * 0.25;
  }
  const relief = { archipelago, canyons, crystal, ocean, dunes }[kind] || crystal;

  /* ------------------------------------------------------------ site shaping */
  const sites = (spec.sites || []).map(site => ({ ...site, cosMax: Math.cos(Math.min(Math.PI, (site.radius + site.falloff) / R)) }));
  const paths = (spec.paths || []).map(path => ({ ...path, frame: path.frame, cosMax: Math.cos(Math.min(Math.PI, path.extent / R)) }));
  let mainSiteHeight = null;

  function naturalHeight(x, y, z) { return relief(x, y, z) * (spec.terrain.relief ?? 1); }

  /** Final relief including flattened landmark plateaus. */
  function heightAt(x, y, z) {
    let h = naturalHeight(x, y, z);
    for (const site of sites) {
      const c = x * site.dir[0] + y * site.dir[1] + z * site.dir[2];
      if (c < site.cosMax) continue;
      const dist = Math.acos(clamp(c, -1, 1)) * R;
      const w = 1 - smoothstep(site.radius, site.radius + site.falloff, dist);
      if (w <= 0) continue;
      let target = site.height;
      if (target == null) target = site.resolvedHeight ?? (site.resolvedHeight = naturalHeight(site.dir[0], site.dir[1], site.dir[2]));
      // A gentle mound keeps plateaus from reading as perfectly flat discs.
      const mound = (site.mound || 0) * (1 - smoothstep(0, site.radius, dist));
      h = lerp(h, target + mound, w * w * (3 - 2 * w));
    }
    return h;
  }

  /** Path mask in [0,1] for decorative trails painted between landmarks. */
  function pathMask(x, y, z) {
    let best = 0;
    for (const path of paths) {
      const c = x * path.frame.up[0] + y * path.frame.up[1] + z * path.frame.up[2];
      if (c < path.cosMax) continue;
      const [lx, lz] = dirToSiteLocal(path.frame, R, [x, y, z]);
      const wobble = 0.85 + 0.3 * (n6(lx * 0.21, 0.5, lz * 0.21) * 0.5 + 0.5);
      for (const pts of path.polylines) {
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
          const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
          const t = clamp(((lx - ax) * dx + (lz - az) * dz) / len2, 0, 1);
          const d = Math.hypot(lx - ax - dx * t, lz - az - dz * t);
          const edge = path.width * wobble;
          best = Math.max(best, 1 - smoothstep(edge * 0.5, edge, d));
        }
      }
    }
    return best;
  }

  /* ----------------------------------------------------------------- colour */
  const c1 = [0, 0, 0], c2 = [0, 0, 0];
  /**
   * Writes linear RGB into out[o..o+2] and returns the glow mask.
   * slope = 1 - dot(surfaceNormal, radialUp) (0 = flat, 1 = vertical).
   */
  function colorAt(x, y, z, h, slope, out, o) {
    const patch = n2(x * 38, y * 38, z * 38) * 0.5 + 0.5;
    const speck = n5(x * 260, y * 260, z * 260) * 0.5 + 0.5;
    // Mid-scale patches (tens of meters) keep wide plateaus from reading flat.
    const mid = n3(x * 150 + 3.1, y * 150, z * 150 - 1.7) * 0.5 + 0.5;
    const rockiness = smoothstep(0.1, 0.26, slope + (speck - 0.5) * 0.06);
    let glow = 0;
    mix3(c1, P.grassA, P.grassB, smoothstep(0.25, 0.75, patch * 0.6 + mid * 0.4));
    mix3(c1, c1, P.grassC, Math.max(smoothstep(0.62, 0.9, speck) * 0.55, smoothstep(0.62, 0.85, mid) * 0.45));
    switch (kind) {
      case 'archipelago':
      case 'ocean': {
        const beach = 1 - smoothstep(1.4, 3.8, h + (speck - 0.5) * 1.6);
        mix3(c1, c1, P.sand, beach);
        mix3(c2, P.rockB, P.rockA, smoothstep(30, 120, h) * 0.6 + patch * 0.4);
        mix3(c1, c1, c2, rockiness);
        if (kind === 'ocean') mix3(c1, c1, P.cliff, smoothstep(0.35, 0.6, slope) * 0.8);
        if (h < 0) mix3(c1, P.seabedShallow, P.seabedDeep, smoothstep(0, -40, h));
        glow = smoothstep(0.78, 0.86, n4(x * 90, y * 90, z * 90)) * (1 - rockiness) * smoothstep(2, 6, h);
        break;
      }
      case 'canyons': {
        const band = (h / 26) % 3;
        const strata = band < 1 ? P.strataA : band < 2 ? P.strataB : P.strataC;
        mix3(c2, strata, P.rockA, smoothstep(0.3, 0.7, n3(x * 30, y * 300, z * 30) * 0.5 + 0.5) * 0.35);
        mix3(c1, c1, P.dirt, Math.max(smoothstep(0.4, 0.8, patch) * 0.6, smoothstep(0.58, 0.82, mid) * 0.55));
        mix3(c1, c1, P.strataC, smoothstep(0.3, 0.12, mid) * 0.22);
        mix3(c1, c1, c2, rockiness);
        mix3(c1, c1, P.sand, smoothstep(6, 0, h) * 0.7);
        break;
      }
      case 'crystal': {
        mix3(c2, P.rockB, P.rockA, patch);
        mix3(c1, c1, P.dirt, smoothstep(0.6, 0.85, mid) * 0.5);
        mix3(c1, c1, c2, rockiness);
        mix3(c1, c1, P.cliff, smoothstep(0.4, 0.7, slope));
        glow = smoothstep(0.72, 0.8, Math.abs(n4(x * 70, y * 70, z * 70))) * (1 - rockiness);
        break;
      }
      case 'dunes':
      default: {
        mix3(c1, P.sand, P.dirt, Math.max(smoothstep(0.55, 0.95, patch) * 0.5, smoothstep(0.6, 0.85, mid) * 0.4));
        // Wind ripples: faint bands across the sand.
        mix3(c1, c1, P.grassC, (Math.sin((x * 0.8 + z * 0.6) * R * 0.14 + n6(x * 40, y * 40, z * 40) * 5) * 0.5 + 0.5) * 0.1 * (1 - rockiness));
        const scrub = smoothstep(0.6, 0.85, n3(x * 60, y * 60, z * 60) * 0.5 + 0.5) * (1 - smoothstep(0.05, 0.15, slope));
        mix3(c1, c1, P.grassA, scrub * 0.6);
        mix3(c2, P.rockA, P.rockB, smoothstep(70, 110, h));
        mix3(c1, c1, c2, rockiness);
        mix3(c1, c1, P.cliff, smoothstep(0.4, 0.75, slope) * 0.7);
        break;
      }
    }
    if (paths.length) {
      const pm = pathMask(x, y, z);
      if (pm > 0) mix3(c1, c1, P.path, pm * 0.7);
    }
    // Subtle high-frequency painterly value variation.
    const v = 0.92 + speck * 0.16;
    out[o] = c1[0] * v; out[o + 1] = c1[1] * v; out[o + 2] = c1[2] * v;
    return glow;
  }

  /** Vegetation suitability in [0,1] for scattering props (main thread). */
  function vegetationAt(x, y, z, h, slope) {
    if (seaLevel !== null && h < seaLevel + 1.2) return 0;
    const patch = n2(x * 38, y * 38, z * 38) * 0.5 + 0.5;
    const flat = 1 - smoothstep(0.08, 0.2, slope);
    const mid = n3(x * 150 + 3.1, y * 150, z * 150 - 1.7) * 0.5 + 0.5;
    if (kind === 'dunes') return flat * Math.max(smoothstep(0.6, 0.85, n3(x * 60, y * 60, z * 60) * 0.5 + 0.5), smoothstep(0.55, 0.85, mid) * 0.7);
    if (kind === 'canyons') return flat * (0.2 + 0.8 * smoothstep(0.3, 0.8, patch * 0.5 + mid * 0.5));
    return flat * (0.35 + 0.65 * smoothstep(0.2, 0.7, patch * 0.6 + mid * 0.4));
  }

  function siteFrame(dir, hint) { return tangentFrame(dir, hint); }

  return {
    id: spec.id, radius: R, seaLevel, kind, heightAt, naturalHeight, colorAt, vegetationAt, pathMask, siteFrame,
    perMeter,
    /** Meters of water above the ground at this direction (0 on land). */
    waterDepthAt(x, y, z, h = heightAt(x, y, z)) { return seaLevel === null ? 0 : Math.max(0, seaLevel - h); },
    /** Ground radius (distance from center) used for walking: water counts as its surface. */
    surfaceRadius(x, y, z) { const h = heightAt(x, y, z); return R + (seaLevel !== null ? Math.max(h, seaLevel) : h); },
    get mainSiteHeight() { return mainSiteHeight; },
  };
}
