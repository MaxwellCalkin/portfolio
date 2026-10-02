/**
 * Swept sphere test: the fraction t in [0, 1] along start->end where a
 * moving point first touches the sphere, 0 if it starts inside, or null.
 * Used for bolts so fast projectiles never tunnel through targets.
 */
export function segmentSphereHitTime(start, end, center, radius) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const ox = start.x - center.x, oy = start.y - center.y, oz = start.z - center.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return null;
  const b = ox * dx + oy * dy + oz * dz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : null;
}
