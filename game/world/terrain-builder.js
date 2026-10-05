/**
 * Cube-sphere terrain chunk generation. Pure JS (no three.js) so it can run in
 * workers. A chunk is an (N+1)^2 vertex grid over one quadtree node of one cube
 * face, projected onto the sphere, plus a skirt that hides LOD cracks.
 *
 * Positions are stored relative to the chunk origin (a point on the base
 * sphere) so Float32 precision stays sub-millimeter even 60 km from the system
 * origin.
 */

// Face axes satisfy U x V = normal, so grid triangles wind counter-clockwise
// when seen from outside the planet.
export const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** Cube point (u, v in [-1, 1]) on face f to a unit sphere direction (spherified cube). */
export function cubeToSphere(face, u, v, out = [0, 0, 0]) {
  const F = FACES[face];
  const x = F.n[0] + F.u[0] * u + F.v[0] * v;
  const y = F.n[1] + F.u[1] * u + F.v[1] * v;
  const z = F.n[2] + F.u[2] * u + F.v[2] * v;
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out[0] = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + y2 * z2 / 3));
  out[1] = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + z2 * x2 / 3));
  out[2] = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + x2 * y2 / 3));
  const l = Math.hypot(out[0], out[1], out[2]);
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

const indexCache = new Map();
/** Shared index buffer for a chunk resolution: grid + double-sided skirts. */
export function chunkIndices(N) {
  if (indexCache.has(N)) return indexCache.get(N);
  const S = N + 1, grid = S * S, list = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * S + i, b = a + 1, c = a + S + 1, d = a + S;
    // Alternate the diagonal for a more isotropic look.
    if ((i + j) & 1) list.push(a, b, d, b, c, d); else list.push(a, b, c, a, c, d);
  }
  const edgeVertex = (e, k) => (e === 0 ? k : e === 1 ? k * S + N : e === 2 ? N * S + k : k * S);
  for (let e = 0; e < 4; e++) for (let k = 0; k < N; k++) {
    const a = edgeVertex(e, k), b = edgeVertex(e, k + 1), sa = grid + e * S + k, sb = sa + 1;
    list.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
  }
  const indices = new Uint16Array(list);
  indexCache.set(N, indices);
  return indices;
}

/**
 * Builds one chunk.
 * @param shape planet shape (createPlanetShape)
 * @param {{face:number, level:number, ix:number, iy:number, N:number}} node
 */
export function buildChunk(shape, { face, level, ix, iy, N }) {
  const R = shape.radius, sea = shape.seaLevel;
  const S = N + 1, B = N + 3; // B: grid with a one-vertex border for normals
  const size = 2 / (1 << level), u0 = -1 + ix * size, v0 = -1 + iy * size;
  const dir = [0, 0, 0];
  // Center of the node on the base sphere is the local origin.
  cubeToSphere(face, u0 + size / 2, v0 + size / 2, dir);
  const ox = dir[0] * R, oy = dir[1] * R, oz = dir[2] * R;

  // Heights and directions on the bordered grid.
  const dirs = new Float64Array(B * B * 3), heights = new Float64Array(B * B), px = new Float64Array(B * B * 3), rawP = new Float64Array(B * B * 3);
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    const u = u0 + (i - 1) / N * size, v = v0 + (j - 1) / N * size;
    cubeToSphere(face, u, v, dir);
    const k = j * B + i, h = shape.heightAt(dir[0], dir[1], dir[2]);
    heights[k] = h;
    const shown = sea !== null ? Math.max(h, sea) : h;
    dirs[k * 3] = dir[0]; dirs[k * 3 + 1] = dir[1]; dirs[k * 3 + 2] = dir[2];
    px[k * 3] = dir[0] * (R + shown); px[k * 3 + 1] = dir[1] * (R + shown); px[k * 3 + 2] = dir[2] * (R + shown);
    rawP[k * 3] = dir[0] * (R + h); rawP[k * 3 + 1] = dir[1] * (R + h); rawP[k * 3 + 2] = dir[2] * (R + h);
  }
  const count = S * S + 4 * S;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), colors = new Float32Array(count * 3), aux = new Float32Array(count * 2);
  let minR = Infinity, maxR = -Infinity, bound = 0, minH = Infinity, maxH = -Infinity;
  const cross = (P, k, out) => {
    // Central differences on the bordered grid.
    const l = (k - 1) * 3, r = (k + 1) * 3, d = (k - B) * 3, u = (k + B) * 3;
    const ax = P[r] - P[l], ay = P[r + 1] - P[l + 1], az = P[r + 2] - P[l + 2];
    const bx = P[u] - P[d], by = P[u + 1] - P[d + 1], bz = P[u + 2] - P[d + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1; out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
  };
  const shownNormal = [0, 0, 0], rawNormal = [0, 0, 0];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const k = (j + 1) * B + (i + 1), v = j * S + i, h = heights[k];
    const dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    positions[v * 3] = px[k * 3] - ox; positions[v * 3 + 1] = px[k * 3 + 1] - oy; positions[v * 3 + 2] = px[k * 3 + 2] - oz;
    cross(px, k, shownNormal); cross(rawP, k, rawNormal);
    // Make sure normals point outward.
    if (shownNormal[0] * dx + shownNormal[1] * dy + shownNormal[2] * dz < 0) { shownNormal[0] *= -1; shownNormal[1] *= -1; shownNormal[2] *= -1; }
    if (rawNormal[0] * dx + rawNormal[1] * dy + rawNormal[2] * dz < 0) { rawNormal[0] *= -1; rawNormal[1] *= -1; rawNormal[2] *= -1; }
    const depth = sea !== null ? Math.max(0, sea - h) : 0;
    if (depth > 0) { normals[v * 3] = dx; normals[v * 3 + 1] = dy; normals[v * 3 + 2] = dz; }
    else { normals[v * 3] = shownNormal[0]; normals[v * 3 + 1] = shownNormal[1]; normals[v * 3 + 2] = shownNormal[2]; }
    const slope = 1 - (rawNormal[0] * dx + rawNormal[1] * dy + rawNormal[2] * dz);
    const glow = shape.colorAt(dx, dy, dz, h, slope, colors, v * 3);
    aux[v * 2] = depth; aux[v * 2 + 1] = glow;
    const r = Math.hypot(px[k * 3], px[k * 3 + 1], px[k * 3 + 2]);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minH = Math.min(minH, h); maxH = Math.max(maxH, h);
    bound = Math.max(bound, Math.hypot(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
  }
  // Skirts: duplicate border vertices, dropped toward the center.
  const arc = R * (Math.PI / 2) / (1 << level);
  const skirt = Math.min(60, 1.5 + arc * 0.05 + (maxR - minR) * 0.15);
  const edgeVertex = (e, k) => (e === 0 ? k : e === 1 ? k * S + N : e === 2 ? N * S + k : k * S);
  for (let e = 0; e < 4; e++) for (let k = 0; k < S; k++) {
    const src = edgeVertex(e, k), dst = S * S + e * S + k;
    const wx = positions[src * 3] + ox, wy = positions[src * 3 + 1] + oy, wz = positions[src * 3 + 2] + oz;
    const r = Math.hypot(wx, wy, wz), f = (r - skirt) / r;
    positions[dst * 3] = wx * f - ox; positions[dst * 3 + 1] = wy * f - oy; positions[dst * 3 + 2] = wz * f - oz;
    for (let c = 0; c < 3; c++) { normals[dst * 3 + c] = normals[src * 3 + c]; colors[dst * 3 + c] = colors[src * 3 + c]; }
    aux[dst * 2] = aux[src * 2]; aux[dst * 2 + 1] = aux[src * 2 + 1];
  }
  return { positions, normals, colors, aux, origin: [ox, oy, oz], minR, maxR, minH, maxH, bound: bound + skirt, arc };
}
