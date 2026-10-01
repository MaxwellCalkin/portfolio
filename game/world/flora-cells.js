import { FACES } from './terrain-builder.js';
import { mulberry32, smoothstep } from './noise.js';
import { dirToSiteLocal } from './planet-shape.js';

/**
 * Deterministic flora cell generation (pure JS, runs in terrain workers).
 *
 * Cells live on a gnomonic cube: dir = normalize(n + u*U + v*V), with an
 * n x n grid per face. Each (cell, layer) pair has its own seeded RNG, so a
 * layer can be generated later (when the player gets close enough to see
 * it) and still produce exactly the same instances.
 *
 * Instance record (11 floats): planet-local position xyz, quaternion xyzw,
 * uniform scale, linear RGB tint.
 */
export const CELL_SIZE = 32;
export const STRIDE = 11;
const TAU = Math.PI * 2;

export function gnomonicDir(face, u, v, out = [0, 0, 0]) {
  const F = FACES[face];
  out[0] = F.n[0] + F.u[0] * u + F.v[0] * v; out[1] = F.n[1] + F.u[1] * u + F.v[1] * v; out[2] = F.n[2] + F.u[2] * u + F.v[2] * v;
  const l = Math.hypot(out[0], out[1], out[2]); out[0] /= l; out[1] /= l; out[2] /= l; return out;
}
export function cellOf(dir, n) {
  const ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
  const face = ax >= ay && ax >= az ? (dir[0] > 0 ? 0 : 1) : ay >= az ? (dir[1] > 0 ? 2 : 3) : (dir[2] > 0 ? 4 : 5);
  const F = FACES[face], dn = dir[0] * F.n[0] + dir[1] * F.n[1] + dir[2] * F.n[2];
  const u = (dir[0] * F.u[0] + dir[1] * F.u[1] + dir[2] * F.u[2]) / dn, v = (dir[0] * F.v[0] + dir[1] * F.v[1] + dir[2] * F.v[2]) / dn;
  return { face, i: Math.min(n - 1, Math.max(0, Math.floor((u + 1) / 2 * n))), j: Math.min(n - 1, Math.max(0, Math.floor((v + 1) / 2 * n))) };
}
export function gridSize(radius) { return Math.ceil(2 * radius / CELL_SIZE); }
export function cellCenter(face, i, j, n, radius) {
  const d = gnomonicDir(face, -1 + (i + 0.5) * 2 / n, -1 + (j + 0.5) * 2 / n);
  return [d[0] * radius, d[1] * radius, d[2] * radius];
}
function hashCell(seed, face, i, j, layer) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(face + 1, 0xc2b2ae35) ^ Math.imul(i + 7, 0x27d4eb2f) ^ Math.imul(j + 13, 0x165667b1) ^ Math.imul(layer + 3, 0xd3a2646c);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); return (h ^ (h >>> 15)) >>> 0;
}

/* Minimal quaternion helpers (x, y, z, w). */
function quatFromBasis(r, u, b, out) {
  // Columns: right, up, back (= -forward). Standard rotation-matrix -> quaternion.
  const m00 = r[0], m01 = u[0], m02 = b[0], m10 = r[1], m11 = u[1], m12 = b[1], m20 = r[2], m21 = u[2], m22 = b[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); out[3] = 0.25 / s; out[0] = (m21 - m12) * s; out[1] = (m02 - m20) * s; out[2] = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s; }
  return out;
}
function quatMulYaw(q, yaw, out) {
  // q * rotationY(yaw)
  const s = Math.sin(yaw / 2), c = Math.cos(yaw / 2), x = q[0], y = q[1], z = q[2], w = q[3];
  out[0] = x * c - z * s; out[1] = y * c + w * s; out[2] = z * c + x * s; out[3] = w * c - y * s;
  return out;
}

/**
 * @param shape planet shape
 * @param ctx { seed, radius, recipe, exclusions:{frame, plateauCos, zones:[{x,z,r}]}, colliders:{asset:{radius,height}}, densityScale }
 * @param layerIndices which recipe layers to generate
 */
export function buildFloraCell(shape, ctx, face, i, j, layerIndices) {
  const R = ctx.radius, n = gridSize(R), sea = shape.seaLevel;
  const du = 2 / n, u0 = -1 + i * du, v0 = -1 + j * du;
  const d00 = gnomonicDir(face, u0, v0), d10 = gnomonicDir(face, u0 + du, v0), d01 = gnomonicDir(face, u0, v0 + du);
  const ax = (d10[0] - d00[0]) * R, ay = (d10[1] - d00[1]) * R, az = (d10[2] - d00[2]) * R;
  const bx = (d01[0] - d00[0]) * R, by = (d01[1] - d00[1]) * R, bz = (d01[2] - d00[2]) * R;
  const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  const ex = ctx.exclusions;
  const dir = [0, 0, 0], color = [0, 0, 0], q = [0, 0, 0, 1], q2 = [0, 0, 0, 1];
  const tA = [0, 0, 0], tB = [0, 0, 0], nrm = [0, 0, 0], al = [0, 0, 0], fw = [0, 0, 0], rt = [0, 0, 0], bk = [0, 0, 0], sd = [0, 0, 0];
  const eps = 1.2 / R;
  const out = { layers: {}, colliders: [] };
  const cellNearSite = ex && (gnomonicDir(face, u0 + du / 2, v0 + du / 2, sd), sd[0] * ex.frame.up[0] + sd[1] * ex.frame.up[1] + sd[2] * ex.frame.up[2]) > ex.plateauCos;
  for (const li of layerIndices) {
    const layer = ctx.recipe[li];
    const random = mulberry32(hashCell(ctx.seed, face, i, j, li));
    const expected = layer.density * ctx.densityScale * area / 1000;
    const count = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
    const data = [];
    for (let k = 0; k < count; k++) {
      gnomonicDir(face, u0 + random() * du, v0 + random() * du, dir);
      const r1 = random(), r2 = random(), r3 = random(), r4 = random(), r5 = random();
      const h = shape.heightAt(dir[0], dir[1], dir[2]);
      if (sea !== null && h < sea + layer.minAboveSea) continue;
      if (layer.maxHeight !== undefined && h > layer.maxHeight) continue;
      if (layer.minHeight !== undefined && h < layer.minHeight) continue;
      // Tangent basis and (for non-grass layers) the true surface normal.
      tA[0] = -dir[2]; tA[1] = 0; tA[2] = dir[0];
      let tl = Math.hypot(tA[0], tA[2]); if (tl < 1e-6) { tA[0] = 1; tA[2] = 0; tl = 1; }
      tA[0] /= tl; tA[2] /= tl;
      tB[0] = dir[1] * tA[2] - dir[2] * tA[1]; tB[1] = dir[2] * tA[0] - dir[0] * tA[2]; tB[2] = dir[0] * tA[1] - dir[1] * tA[0];
      let slope = 0.04;
      nrm[0] = dir[0]; nrm[1] = dir[1]; nrm[2] = dir[2];
      if (!layer.ground) {
        const pa = [dir[0] + tA[0] * eps, dir[1] + tA[1] * eps, dir[2] + tA[2] * eps], pb = [dir[0] + tB[0] * eps, dir[1] + tB[1] * eps, dir[2] + tB[2] * eps];
        const la = Math.hypot(...pa), lb = Math.hypot(...pb);
        const ha = shape.heightAt(pa[0] / la, pa[1] / la, pa[2] / la), hb = shape.heightAt(pb[0] / lb, pb[1] / lb, pb[2] / lb);
        const step = eps * R;
        nrm[0] = dir[0] * step - tA[0] * (ha - h) - tB[0] * (hb - h); nrm[1] = dir[1] * step - tA[1] * (ha - h) - tB[1] * (hb - h); nrm[2] = dir[2] * step - tA[2] * (ha - h) - tB[2] * (hb - h);
        const nl = Math.hypot(nrm[0], nrm[1], nrm[2]); nrm[0] /= nl; nrm[1] /= nl; nrm[2] /= nl;
        slope = 1 - (nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2]);
        if (slope > layer.slopeMax) continue;
      }
      const veg = shape.vegetationAt(dir[0], dir[1], dir[2], h, slope);
      if (veg < layer.veg[0] || veg > layer.veg[1]) continue;
      if (r1 > smoothstep(layer.veg[0], Math.min(1, layer.veg[0] + 0.3), veg) + 0.15) continue;
      if (layer.cluster) {
        const f = layer.cluster[0] / 1000 * R;
        const c = Math.sin(dir[0] * f + li) * Math.sin(dir[1] * f * 1.3 + 2.1) * Math.sin(dir[2] * f * 0.9 + 4.2);
        if (c < layer.cluster[1] + (r2 - 0.5) * 0.25) continue;
      }
      if (cellNearSite) {
        const [x, z] = dirToSiteLocal(ex.frame, R, dir);
        let blocked = false;
        const big = layer.collider || layer.view > 100;
        for (const e of ex.zones) { const r = big ? e.r : e.r * 0.55; if ((x - e.x) ** 2 + (z - e.z) ** 2 < r * r) { blocked = true; break; } }
        if (blocked) continue;
        if (layer.avoidPaths && shape.pathMask(dir[0], dir[1], dir[2]) > 0.05) continue;
      }
      const scale = layer.scale[0] + (layer.scale[1] - layer.scale[0]) * r3 * (0.75 + 0.25 * veg);
      // Orientation: radial up, partially tilted onto the slope for rocks.
      const t = layer.tilt || 0;
      al[0] = dir[0] + (nrm[0] - dir[0]) * t; al[1] = dir[1] + (nrm[1] - dir[1]) * t; al[2] = dir[2] + (nrm[2] - dir[2]) * t;
      const all = Math.hypot(al[0], al[1], al[2]); al[0] /= all; al[1] /= all; al[2] /= all;
      const dd = tA[0] * al[0] + tA[1] * al[1] + tA[2] * al[2];
      fw[0] = tA[0] - al[0] * dd; fw[1] = tA[1] - al[1] * dd; fw[2] = tA[2] - al[2] * dd;
      const fl = Math.hypot(fw[0], fw[1], fw[2]); fw[0] /= fl; fw[1] /= fl; fw[2] /= fl;
      rt[0] = al[1] * fw[2] - al[2] * fw[1]; rt[1] = al[2] * fw[0] - al[0] * fw[2]; rt[2] = al[0] * fw[1] - al[1] * fw[0];
      bk[0] = -fw[0]; bk[1] = -fw[1]; bk[2] = -fw[2];
      quatFromBasis(rt, al, bk, q); quatMulYaw(q, r4 * TAU, q2);
      const ground = sea !== null ? Math.max(h, sea) : h;
      const sink = layer.collider ? 0.15 * scale : 0.04;
      const px = dir[0] * (R + ground - sink), py = dir[1] * (R + ground - sink), pz = dir[2] * (R + ground - sink);
      if (layer.ground) {
        shape.colorAt(dir[0], dir[1], dir[2], h, slope, color, 0);
        const kk = 1.12 + r5 * 0.25; color[0] *= kk; color[1] *= kk * 1.04; color[2] *= kk;
      } else { const kk = 0.82 + r5 * 0.36; color[0] = kk; color[1] = kk; color[2] = kk; }
      data.push(px, py, pz, q2[0], q2[1], q2[2], q2[3], scale, color[0], color[1], color[2]);
      if (layer.collider) {
        const meta = ctx.colliders?.[layer.asset];
        out.colliders.push({ x: px, y: py, z: pz, radius: (meta?.radius ?? 0.5) * scale, height: (meta?.height ?? 3) * scale, layer: li });
      }
    }
    out.layers[li] = new Float64Array(data);
  }
  return out;
}
