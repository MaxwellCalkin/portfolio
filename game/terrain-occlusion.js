import { Vector3 } from 'three';

const EPSILON = 1e-7;
const boundsCache = new WeakMap();
const point = new Vector3();

/** Conservative radial and slope bounds of the actual, unscaled terrain mesh. */
function boundsFor(surface) {
  const geometry = surface.geometry;
  if (geometry?.attributes?.position) {
    const position = geometry.attributes.position, cached = boundsCache.get(geometry);
    if (cached && cached.version === position.version) return cached;
    let outer = 0, inner = Infinity, minimumCosine = 1;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), normal = new Vector3();
    for (let i = 0; i < position.count; i++) {
      a.fromBufferAttribute(position, i); const radius = a.length();
      outer = Math.max(outer, radius); inner = Math.min(inner, radius);
    }
    const indices = geometry.index, count = indices?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, indices ? indices.getX(i) : i);
      b.fromBufferAttribute(position, indices ? indices.getX(i + 1) : i + 1);
      c.fromBufferAttribute(position, indices ? indices.getX(i + 2) : i + 2);
      normal.crossVectors(b.clone().sub(a), c.clone().sub(a));
      if (normal.lengthSq() < 1e-18) continue;
      normal.normalize();
      for (const vertex of [a, b, c]) minimumCosine = Math.min(minimumCosine, Math.abs(normal.dot(vertex) / vertex.length()));
    }
    // A planar triangle's radial intersection lies no closer than its plane.
    inner *= minimumCosine;
    const tangent = Math.sqrt(Math.max(0, 1 - minimumCosine * minimumCosine)) / Math.max(1e-8, minimumCosine);
    const lipschitz = Math.sqrt(1 + (outer / Math.max(inner, 1e-8) * tangent) ** 2) * 1.00001;
    const result = { outer, inner, lipschitz, version: position.version };
    boundsCache.set(geometry, result); return result;
  }
  // Analytic test worlds can provide explicit bounds for non-spherical relief.
  return { outer: surface.boundingRadius ?? surface.radius,
    inner: surface.minimumRadius ?? surface.radius,
    lipschitz: surface.altitudeLipschitz ?? 2 };
}

/** Clip to a conservative containing sphere before querying expensive terrain. */
function sphereInterval(start, delta, center, radius, endT) {
  const offset = start.clone().sub(center), a = delta.lengthSq();
  if (a <= 1e-24) return offset.lengthSq() <= radius * radius ? [0, 0] : null;
  const b = offset.dot(delta), c = offset.lengthSq() - radius * radius;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  const low = Math.max(0, (-b - root) / a), high = Math.min(endT, (-b + root) / a);
  return low <= high ? [low, high] : null;
}

/**
 * Earliest world-space terrain contact, including starts inside and through-globe
 * chords whose endpoints are both outside. Uses the actual rendered triangle
 * sampler. Conservative altitude advances cannot hop a narrow ridge; bounded
 * subdivisions also cover generic radial samplers. Inputs are never mutated.
 *
 * Surfaces with no geometry are assumed to be spheres unless they provide a
 * conservative boundingRadius and altitudeLipschitz for their custom sampler.
 */
export function earliestTerrainHit(start, end, surfacesIterable, clearance = 0) {
  const surfaces = surfacesIterable instanceof Map ? surfacesIterable.values() : surfacesIterable;
  const delta = end.clone().sub(start), length = delta.length();
  let earliest = null;
  for (const surface of surfaces ?? []) {
    if (!surface?.altitudeAt || !surface.center) continue;
    // Reject distant shots using the already-computed render bound before the
    // one-time slope scan. Firing in space must not scan all five globe meshes.
    const meshBound = surface.geometry?.boundingSphere;
    const roughOuter = meshBound ? meshBound.radius + meshBound.center.length() : (surface.boundingRadius ?? surface.radius);
    const roughInterval = Number.isFinite(roughOuter) ? sphereInterval(start, delta, surface.center,
      roughOuter + Math.max(0, clearance) + EPSILON, earliest?.t ?? 1) : [0, earliest?.t ?? 1];
    if (!roughInterval) continue;
    const bounds = boundsFor(surface), outer = bounds.outer + Math.max(0, clearance) + EPSILON;
    const interval = Number.isFinite(outer) ? sphereInterval(start, delta, surface.center, outer, earliest?.t ?? 1) : roughInterval;
    if (!interval) continue;
    const [begin, finish] = interval;
    const sample = t => surface.altitudeAt(point.copy(start).addScaledVector(delta, t)) - clearance;
    let t = begin, altitude = sample(t), previous = t;
    if (altitude <= EPSILON) {
      earliest = { t, point: start.clone().addScaledVector(delta, t), surface }; continue;
    }
    if (length <= 1e-12) continue;
    const maxStep = Math.min(.75, Math.max(.02, (surface.radius || 1) * .05));
    while (t < finish) {
      // The Lipschitz bound makes this a conservative advancement, including
      // triangle boundaries, poles, grazing shots, and sub-centimeter ridges.
      const advance = Math.min(maxStep, altitude / Math.max(1, bounds.lipschitz) * .95);
      previous = t; t = Math.min(finish, t + Math.max(1e-10, advance / length));
      altitude = sample(t);
      if (altitude <= EPSILON) {
        if (altitude < 0) {
          let low = previous, high = t;
          for (let i = 0; i < 26; i++) {
            const middle = (low + high) * .5;
            if (sample(middle) <= 0) high = middle; else low = middle;
          }
          t = high;
        }
        earliest = { t, point: start.clone().addScaledVector(delta, t), surface }; break;
      }
    }
  }
  return earliest;
}
