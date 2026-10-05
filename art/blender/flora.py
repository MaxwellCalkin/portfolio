"""
The Unfolding: stylized flora, rock and crystal prop library.

Builds every asset as its own top-level object (object name = glTF node name), origin at the
base center on the ground (z = 0), facing -Y, then exports

    public/models/flora.raw.glb   (Blender glTF export)
    public/models/flora.glb       (gltfpack -cc -kn -km -vpf -kv: meshopt, names kept)
    public/models/flora.json      (manifest: triangles, height, footprint, collider, slots,
                                   far = name of the far-LOD node or null, farTriangles)

The big assets also get a far LOD, exported in the same file as '<name>_far' (same origin,
facing and material slots, at most a quarter of the near triangles; see "Far LODs" below).

-vpf keeps positions as floats: every named node then holds its mesh directly, in meters,
with no hidden dequantization child transform, which is what instancing code wants (it costs
about 10 KB). -kv keeps COLOR_0 on primitives whose vertex colors are constant (gltfpack
drops it otherwise, and a vertexColors material then reads black). Pass
--pack-args "-cc -kn -km -kv" for the fully quantized variant.

Shading conventions used by every asset (see also common.py):
  * COLOR_0 = grayscale AO x gradient (white = full color): enable vertexColors on the
    replacement materials.
  * Leaf, LeafAlt and Petal are single planes in places (fronds, leaf plates, petals) and are
    exported doubleSided. Their normals are authored (soft, up-biased) for that.
  * Grass is exported single-sided on purpose: blades face outward and carry terrain-like
    (up) normals, so tufts light like the ground they stand on. Rendering it DoubleSide is
    fine only if the back-face normal flip is disabled; otherwise back faces go dark.

Run headless (deterministic: every asset has its own seeded RNG):

    /home/claude/blender/.venv/bin/python art/blender/flora.py
    ... flora.py --only tree_round,rock_boulder --out /tmp/qa.raw.glb --no-manifest

Art direction and the material-slot contract live in art/STYLE.md.
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402  (needs the path above)

import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

TAU = math.tau
UP = Vector((0.0, 0.0, 1.0))

ASSETS = []


def asset(name, kind, budget, notes=''):
    """Register a builder. The builder gets a seeded RNG and returns (object, extras)."""
    def deco(fn):
        ASSETS.append(dict(name=name, kind=kind, budget=budget, notes=notes, fn=fn))
        return fn
    return deco


def polar(r, a, z=0.0):
    return Vector((r * math.cos(a), r * math.sin(a), z))


def yaw_dirs(a):
    """(outward, side) horizontal unit vectors for azimuth a. A strip built with `side`
    faces `outward`."""
    return Vector((math.cos(a), math.sin(a), 0.0)), Vector((-math.sin(a), math.cos(a), 0.0))


def dome_normals(center, up_bias=0.0):
    """Normals from a point (usually below the plant) -> soft, unified foliage shading."""
    c = Vector(center)

    def fn(co, n):
        d = (co - c).normalized()
        return (d + UP * up_bias).normalized()
    return fn


# ----------------------------------------------------------------------------
# Grasses
# ----------------------------------------------------------------------------

# 'terrain': single-sided blades with up normals (light like the ground; default).
# 'double': DoubleSide-safe variant with mostly horizontal normals (no black back faces in
# stock three.js, but darker than the ground).
GRASS_MODE = 'terrain'
GRASS_UP = 0.2  # upward normal bias for the 'double' variant


def blade(bm, base, yaw, height, lean, width, droop=0.0, twist=0.0, mid=0.5, taper=0.72,
          up_bias=None):
    """One curved, tapered blade = 3 triangles (quad + tip). Its front faces outward (`yaw`).

    GRASS_MODE 'terrain': normals point nearly straight up, so the blade lights like the
    ground. 'double': normals point mostly along the facing; three.js negates normals on back
    faces of DoubleSide materials, and a mostly horizontal normal keeps those lit.
    """
    out, side = yaw_dirs(yaw)
    reach = lean * height
    p0 = base
    p1 = base + out * (reach * mid * mid * 0.9) + UP * (height * mid * (1.0 - 0.15 * droop))
    p2 = base + out * reach + UP * (height * (1.0 - droop))
    s0 = side
    s1 = (side * math.cos(twist) + UP.cross(side) * math.sin(twist)).normalized()
    layer = bm.verts.layers.float_vector.get('nrm')  # created up front by new_bm()
    _, pairs = C.strip([p0, p1, p2], [width, width * taper, 0.0], [s0, s1, s1], tip=True, bm=bm)
    k = GRASS_UP if up_bias is None else up_bias
    for i, (l, r) in enumerate(pairs):
        if GRASS_MODE == 'terrain':  # single-sided: light like the ground (normals ~ up)
            n = (UP + out * (0.32 - 0.08 * i)).normalized()
        else:                         # double-sided: mostly horizontal so back faces stay lit
            n = (out + UP * (k * (0.6 + 0.6 * i))).normalized()
        l[layer] = n
        r[layer] = n


def new_bm():
    """bmesh with the `nrm` intent layer (layers must exist before verts are created)."""
    bm = bmesh.new()
    bm.verts.layers.float_vector.new('nrm')
    return bm


def tuft(rng, n, heights, widths, leans, spread, droops=(0.0, 0.0), twist=0.35,
         order_bias=0.6, sink=0.03):
    """A clump of blades fanning out from the center; inner blades taller and straighter."""
    bm = new_bm()
    base_yaw = rng.uniform(0, TAU)
    for i in range(n):
        yaw = base_yaw + i * TAU * 0.618034 + rng.uniform(-0.25, 0.25)  # golden-angle spread
        inner = rng.random() ** order_bias
        h = C.lerp(heights[0], heights[1], inner) * rng.uniform(0.9, 1.08)
        lean = C.lerp(leans[1], leans[0], inner) * rng.uniform(0.85, 1.15)
        w = rng.uniform(*widths)
        r0 = rng.uniform(0.15, 1.0) * spread
        off = polar(r0, yaw + rng.uniform(-0.5, 0.5), -sink)
        blade(bm, off, yaw, h, lean, w, droop=rng.uniform(*droops),
              twist=rng.uniform(-twist, twist), mid=rng.uniform(0.45, 0.58))
    return bm


def finish_grass(ob, height, root=0.45):
    """Grass shading: dark root -> full-color tip (normals were set per blade)."""
    C.set_shade(ob, C.gradient(0.0, height * 0.85, root, 1.0, curve=0.8))
    C.set_ao_weight(ob, 0.0)


@asset('grass_tuft', 'grass', 24,
       notes='8 curved tapered blades, dark root to full-color tip. Grass is single-sided with terrain (up) normals so it lights like the ground; DoubleSide only with the back-face normal flip disabled.')
def grass_tuft(rng):
    bm = tuft(rng, 8, heights=(0.28, 0.46), widths=(0.026, 0.034), leans=(0.22, 0.62),
              spread=0.05, droops=(0.0, 0.12))
    ob = C.mesh_object('_grass', bm, 'Grass')
    finish_grass(ob, 0.46)
    ob = C.join([ob], 'grass_tuft')
    return ob, dict(collider=None)


@asset('grass_tall', 'grass', 36, notes='12 lush blades. Same Grass setup as grass_tuft.')
def grass_tall(rng):
    bm = tuft(rng, 12, heights=(0.5, 0.92), widths=(0.032, 0.046), leans=(0.18, 0.62),
              spread=0.08, droops=(0.02, 0.22))
    ob = C.mesh_object('_grass', bm, 'Grass')
    finish_grass(ob, 0.92)
    ob = C.join([ob], 'grass_tall')
    return ob, dict(collider=None)


@asset('dune_grass', 'grass', 20,
       notes='6 wiry splayed blades + 2 dry stubs. Same Grass setup as grass_tuft.')
def dune_grass(rng):
    bm = tuft(rng, 6, heights=(0.42, 0.66), widths=(0.012, 0.017), leans=(0.3, 0.85),
              spread=0.05, droops=(0.08, 0.3), twist=0.2)
    # two short single-triangle stubs (old dry stalks) for a ragged base
    for k in range(2):
        a = rng.uniform(0, TAU)
        out, side = yaw_dirs(a)
        base = polar(0.03, a, -0.02)
        tip = base + out * rng.uniform(0.08, 0.14) + UP * rng.uniform(0.14, 0.2)
        v = [bm.verts.new(base - side * 0.014), bm.verts.new(base + side * 0.014), bm.verts.new(tip)]
        bm.faces.new(v)
    ob = C.mesh_object('_grass', bm, 'Grass')
    finish_grass(ob, 0.5, root=0.42)
    ob = C.join([ob], 'dune_grass')
    return ob, dict(collider=None)


@asset('reed_clump', 'grass', 60,
       notes='8 reed leaves (Grass, same setup as grass_tuft) and 2 cattails with Bark heads.')
def reed_clump(rng):
    leaves = tuft(rng, 8, heights=(0.75, 1.15), widths=(0.03, 0.04), leans=(0.12, 0.42),
                  spread=0.09, droops=(0.05, 0.25), twist=0.5, order_bias=0.8)
    grass = C.mesh_object('_reeds', leaves, 'Grass')
    finish_grass(grass, 1.15, root=0.4)
    parts = [grass]
    yaw = rng.uniform(0, TAU)
    for k, h in enumerate((1.32, 1.08)):
        if k:
            yaw += math.pi * rng.uniform(0.7, 1.3)  # second cattail on the other side
        out, _ = yaw_dirs(yaw)
        lean = rng.uniform(0.04, 0.09) * h
        base = polar(0.04, yaw, -0.03)
        top = base + out * lean + UP * h                     # spike tip
        head_lo = base + out * (lean * 0.72) + UP * (h * 0.74)
        head_hi = base + out * (lean * 0.93) + UP * (h * 0.94)
        stem_bm, _ = C.tube([base, head_lo], [0.012, 0.011], sides=3, cap_start=False,
                            cap_end=False, phase=rng.uniform(0, TAU))
        stem = C.mesh_object(f'_stem{k}', stem_bm, 'Grass')
        C.set_shade(stem, C.gradient(0.0, h * 0.7, 0.42, 0.95))
        C.set_ao_weight(stem, 0.0)
        mid = head_lo.lerp(head_hi, 0.5)
        span = head_hi - head_lo
        head_bm, _ = C.tube([head_lo + span * 0.1, head_hi - span * 0.08], [0.034, 0.033],
                            sides=3, start_tip=head_lo - span * 0.04, end_tip=top,
                            phase=rng.uniform(0, TAU))
        head = C.mesh_object(f'_head{k}', head_bm, 'Bark')
        C.set_normals(head, C.radial_normals(mid, 0.55))
        C.set_ao_weight(head, 0.0)
        parts += [stem, head]
    ob = C.join(parts, 'reed_clump')
    return ob, dict(collider=None)


# ----------------------------------------------------------------------------
# Shared plant parts
# ----------------------------------------------------------------------------

def leaf_blade(bm, base, yaw, length, width, rise=0.35, droop=0.3):
    """Pointed leaf arching out along azimuth `yaw`: narrow base, wide middle, tip (3 tris).
    Front face points up."""
    out, _ = yaw_dirs(yaw)
    side = out.cross(UP)  # strip(side) x forward = up
    p0 = base
    p1 = base + out * (length * 0.45) + UP * (length * rise)
    p2 = base + out * (length * 0.95) + UP * (length * (rise - droop))
    _, pairs = C.strip([p0, p1, p2], [width * 0.22, width, 0.0], side, tip=True, bm=bm)
    return pairs


def frond_spine(base, yaw, length, rise, droop, curl=0.0):
    """Bezier control points of a frond's rachis arching out along azimuth `yaw`."""
    out, _ = yaw_dirs(yaw)
    return (base, base + out * (length * 0.15) + UP * (length * rise),
            base + out * (length * 0.6) + UP * (length * (rise + 0.05 - curl)),
            base + out * length + UP * (length * (rise * 0.4 - droop)))


def frond_width(width, t, base_taper=0.0):
    """Leaflet half-width at spine parameter t (0 base .. 1 tip)."""
    return width * math.sin(math.pi * min(1.0, t * 0.92 + 0.04)) ** 0.8 * C.smoothstep(0.0, base_taper, t)


def comb_frond(bm, base, yaw, length, width, rise, droop, segs, fold=0.42, sweep=1.1, curl=0.0,
               base_taper=0.0):
    """Pinnate 'comb' frond: one swept-forward triangle leaflet per side per spine segment.

    Leaflets share the spine vertices, so the frond is continuous along the rachis while each
    leaflet keeps its own silhouette (fern / palm read). `sweep` > 1 pushes leaflet tips past
    the next spine vertex; `fold` droops them into a V. Front faces point up. 2 * segs tris.
    """
    out, left = yaw_dirs(yaw)
    spine = C.bezier_points(*frond_spine(base, yaw, length, rise, droop, curl), segs + 1)
    sv = [bm.verts.new(p) for p in spine]
    for i in range(segs):
        t = (i + 1) / segs
        w = frond_width(width, t, base_taper)
        tip_c = spine[i].lerp(spine[i + 1], sweep)
        facing = (out * 0.6 + UP).normalized()
        for sgn in (1.0, -1.0):
            tip = bm.verts.new(tip_c + left * (w * sgn) - UP * (w * fold))
            f = bm.faces.new((sv[i], sv[i + 1], tip) if sgn > 0 else (sv[i + 1], sv[i], tip))
            f.normal_update()
            if f.normal.dot(facing) < 0.0:  # rising part of the spine: keep fronts facing out
                f.normal_flip()
    return spine


def lobe_dirs(n, rng, zmin=-0.3):
    """n well-spread unit directions above z = zmin (Fibonacci sphere, lightly jittered)."""
    golden = math.pi * (3.0 - math.sqrt(5.0))
    out, k = [], 0
    while len(out) < n and k < n * 8:
        z = 1.0 - 2.0 * (k + 0.5) / (n * 2.2)
        k += 1
        if z < zmin:
            continue
        r = math.sqrt(max(0.0, 1.0 - z * z))
        a = k * golden + rng.uniform(-0.3, 0.3)
        out.append(Vector((r * math.cos(a), r * math.sin(a), z)).normalized())
    return out


def mass_blobs(bm, c, R, rng, squash=0.8, lobes=7, lobe_r=(0.4, 0.52), lobe_d=(0.6, 0.74),
               subdivisions=3):
    """Add one foliage mass's blobs to bm: a core ellipsoid plus `lobes` leaf-cluster lobes."""
    c = Vector(c)
    C.blob(c, (R * 0.86, R * 0.86, R * 0.86 * squash), subdivisions=subdivisions, lump=0.0, bm=bm)
    for d in lobe_dirs(lobes, rng):
        r = R * rng.uniform(*lobe_r)
        p = c + Vector((d.x, d.y, d.z * squash)) * (R * rng.uniform(*lobe_d))
        C.blob(p, (r, r, r * 0.92), subdivisions=subdivisions, lump=0.0, bm=bm)


def foliage_mass(name, c, R, rng, target, squash=0.8, lobes=7, lobe_r=(0.4, 0.52),
                 lobe_d=(0.6, 0.74), smooth=12, slot='Leaf', ground=None, min_tris=24):
    """One soft, chunky foliage mass, closed and single-sided-safe.

    A core ellipsoid plus `lobes` protruding leaf-cluster lobes are voxel-unioned into one
    watertight surface, smoothed so the lobes meet in soft fillets (lightly lumpy silhouette)
    and collapse-decimated to about `target` triangles. ground = (z, softness) flattens the
    part below z (masses that sit on the ground). Returns the object.
    """
    bm = bmesh.new()
    mass_blobs(bm, c, R, rng, squash, lobes, lobe_r, lobe_d)
    ob = C.mesh_object(name, bm, slot)
    C.remesh(ob, R * 0.07)
    if smooth:
        C.modifier(ob, 'SMOOTH', factor=0.6, iterations=smooth)
    if ground is not None:
        zc, soft = ground
        for v in ob.data.vertices:
            if v.co.z < zc:
                v.co.z = zc + (v.co.z - zc) * soft
    C.decimate(ob, target_tris=max(min_tris, int(target)))
    return ob


def fit_masses(masses, budget, seed, wood=(), start=1.35, min_tris=24):
    """Build foliage masses that share `budget` (minus wood) triangles by area (R^2).

    masses: [dict(c, R, slot, ...foliage_mass kwargs)]. Faces hidden inside other masses are
    removed before counting, and the per-mass targets are refit until everything fits.
    Every attempt re-seeds identically, so the result is deterministic.
    """
    import random
    wood_tris = sum(C.tri_count(w) for w in wood)
    areas = [m['R'] ** 2 for m in masses]
    scale = (budget - wood_tris) / sum(areas) * start
    for _ in range(30):
        rng = random.Random(seed)
        objs = []
        for k, (m, area) in enumerate(zip(masses, areas)):
            opts = {key: val for key, val in m.items() if key not in ('c', 'R')}
            objs.append(foliage_mass(f'_mass{k}', m['c'], m['R'], rng, area * scale,
                                     min_tris=min_tris, **opts))
        C.remove_hidden_faces(objs)
        total = sum(C.tri_count(o) for o in objs) + wood_tris
        if total <= budget:
            return objs
        for o in objs:
            C.delete(o)
        scale *= budget / total * 0.98
    raise RuntimeError('fit_masses: could not fit budget')


def soften_masses(objs, masses, canopy_c, mix=(0.72, 0.2, 0.08), up=0.15, top=None):
    """Outward spherical normals (mostly from each mass center, partly from the canopy
    center, a touch of the real surface) and a vertical shade gradient (z0, z1)."""
    cc = Vector(canopy_c)
    a, b, g = mix
    for ob, m in zip(objs, masses):
        c = Vector(m['c'])
        C.set_normals(ob, lambda co, n, c=c: (co - c).normalized() * a + (co - cc).normalized() * b
                      + n * g + UP * up)
        if top is not None:
            C.set_shade(ob, C.gradient(top[0], top[1], 0.78, 1.0))


def bulb_shape(top, length, radius, sides=5, slot='Glow'):
    """Hanging teardrop (pole at the top, widest at 40%, rounded pointed bottom)."""
    prof = [(0.0, -length), (radius * 0.8, -length * 0.68), (radius * 0.95, -length * 0.32),
            (0.0, 0.0)]
    bm, _ = C.lathe(prof, sides=sides, center=top)
    ob = C.mesh_object('_bulb', bm, slot)
    C.set_normals(ob, C.radial_normals(Vector(top) - Vector((0, 0, length * 0.45)), 0.85))
    return ob


# ----------------------------------------------------------------------------
# Small plants
# ----------------------------------------------------------------------------

@asset('flower_a', 'plant', 90,
       notes='Stem, 3 leaves, 6-petal cupped bloom facing -Y and up with a Glow bead, closed bud. '
             'Petals and leaves are single planes: render Leaf/Petal DoubleSide.')
def flower_a(rng):
    parts = []
    top = Vector((0.0, -0.06, 0.45))
    pts = C.bezier_points(Vector((0, 0, -0.02)), Vector((0.025, 0.0, 0.16)),
                          Vector((-0.02, -0.02, 0.32)), top, 5)
    bm, _ = C.tube(pts, [0.011, 0.0105, 0.01, 0.0095, 0.009], sides=3, cap_start=False,
                   cap_end=False)
    stem = C.mesh_object('_stem', bm, 'Leaf')
    C.set_shade(stem, C.gradient(0.0, 0.35, 0.55, 1.0))
    parts.append(stem)

    bm = new_bm()
    a0 = rng.uniform(0, TAU)
    for k, (z, L, w) in enumerate([(0.0, 0.15, 0.03), (0.03, 0.13, 0.027), (0.1, 0.1, 0.022)]):
        leaf_blade(bm, Vector((0, 0, z)), a0 + k * 2.3, L, w, rise=0.3, droop=0.32)
    leaves = C.mesh_object('_leaves', bm, 'Leaf')
    C.set_normals(leaves, dome_normals((0, 0, -0.25), 0.4))
    C.set_shade(leaves, C.gradient(0.0, 0.08, 0.62, 1.0))
    parts.append(leaves)

    # bloom: two layers of three petals, cupped, facing toward -Y and up
    f = Vector((0.0, -0.55, 1.0)).normalized()
    u, v = C.basis(f)
    c = top + f * 0.004
    bm = new_bm()
    phase = rng.uniform(0, TAU)
    for k in range(6):
        ang = phase + k * TAU / 6
        d = u * math.cos(ang) + v * math.sin(ang)
        s = d.cross(f)
        inner = k % 2 == 1
        L = 0.1 if not inner else 0.088
        rise = math.radians(46 if inner else 30)
        tip_rise = math.radians(14 if inner else 2)

        def at(t, r):
            return c + d * (L * t * math.cos(r)) + f * (L * t * math.sin(r) + (0.006 if inner else 0.0))
        B = bm.verts.new(c + d * 0.006 + f * (0.006 if inner else 0.0))
        p1, p2 = at(0.42, rise), at(0.8, C.lerp(rise, tip_rise, 0.6))
        w1, w2 = (0.034, 0.03) if not inner else (0.03, 0.026)
        L1, R1 = bm.verts.new(p1 - s * w1), bm.verts.new(p1 + s * w1)
        L2, R2 = bm.verts.new(p2 - s * w2), bm.verts.new(p2 + s * w2)
        T = bm.verts.new(at(1.0, tip_rise))
        bm.faces.new((B, R1, L1))
        bm.faces.new((L1, R1, R2, L2))
        bm.faces.new((L2, R2, T))
    petals = C.mesh_object('_petals', bm, 'Petal')
    C.set_normals(petals, lambda co, n: (f * 0.8 + (co - c).normalized() * 0.6).normalized())
    C.set_shade(petals, lambda co: C.lerp(0.72, 1.0, C.smoothstep(0.0, 0.06, (co - c).length)))
    parts.append(petals)

    bm, _ = C.lathe([(0.0, -0.004), (0.022, 0.008), (0.0, 0.026)], sides=5)
    bead = C.mesh_object('_center', bm, 'Glow')
    C.transform(bead, C.align_z(f, c))
    C.set_normals(bead, C.radial_normals(c + f * 0.004, 1.0))
    parts.append(bead)

    bm = new_bm()
    for k in range(3):
        ang = phase + 0.5 + k * TAU / 3
        d = u * math.cos(ang) + v * math.sin(ang)
        s = d.cross(f)
        b0 = c - f * 0.01
        verts = [bm.verts.new(b0 - s * 0.012), bm.verts.new(b0 + s * 0.012),
                 bm.verts.new(b0 + d * 0.045 - f * 0.03)]
        bm.faces.new((verts[1], verts[0], verts[2]))
    sepals = C.mesh_object('_sepals', bm, 'Leaf')
    parts.append(sepals)

    # a closed bud on a short side stem
    s0 = pts[2]
    s1 = s0 + Vector((0.07, 0.04, 0.09))
    bm, _ = C.tube([s0, s1], [0.007, 0.006], sides=3, cap_start=False, cap_end=False)
    bud_stem = C.mesh_object('_budstem', bm, 'Leaf')
    parts.append(bud_stem)
    bd = (s1 - s0).normalized()
    bm, _ = C.tube([s1 + bd * 0.014, s1 + bd * 0.04], [0.017, 0.019], sides=3,
                   start_tip=s1 - bd * 0.004, end_tip=s1 + bd * 0.078)
    bud = C.mesh_object('_bud', bm, 'Petal')
    C.set_normals(bud, lambda co, n: ((co - (s1 + bd * 0.025)).normalized() + UP * 0.6).normalized())
    C.set_ao_weight(bud, 0.0)
    parts.append(bud)

    ob = C.join(parts, 'flower_a')
    return ob, dict(collider=None, finalize=dict(ao=dict(distance=0.12, samples=32, floor=0.55)))


@asset('fern_a', 'plant', 120,
       notes='6 arching pinnate fronds (single planes): render Leaf DoubleSide.')
def fern_a(rng):
    bm = new_bm()
    a0 = rng.uniform(0, TAU)
    for k in range(6):
        yaw = a0 + k * TAU / 6 + rng.uniform(-0.2, 0.2)
        comb_frond(bm, polar(0.05, yaw, -0.01), yaw, rng.uniform(0.8, 0.95),
                   rng.uniform(0.14, 0.16), rise=rng.uniform(0.98, 1.15),
                   droop=rng.uniform(0.45, 0.62), segs=10, fold=0.4, sweep=1.15, base_taper=0.5)
    ob = C.mesh_object('_fronds', bm, 'Leaf')

    def outward(co, n):  # out + up: DoubleSide back faces of far fronds stay teal, not black
        h = Vector((co.x, co.y, 0.0))
        return (h.normalized() if h.length > 1e-4 else Vector((1.0, 0.0, 0.0))) + UP * 0.9
    C.set_normals(ob, outward)
    C.set_shade(ob, lambda co: C.lerp(0.78, 1.0, C.smoothstep(0.0, 0.3, math.hypot(co.x, co.y))))
    ob = C.join([ob], 'fern_a')
    return ob, dict(collider=None, finalize=dict(ao=dict(distance=0.14, samples=32, floor=0.72)))


@asset('glow_bulb', 'plant', 160,
       notes='Lantern plant for bioluminescent nights: 3 arching stems with hanging Glow bulbs '
             'under star hoods, 3 basal leaves (Leaf DoubleSide).')
def glow_bulb(rng):
    parts = []
    a0 = rng.uniform(0, TAU)
    for k, h in enumerate((1.2, 0.98, 0.78)):
        yaw = a0 + k * TAU / 3 + rng.uniform(-0.3, 0.3)
        out, _ = yaw_dirs(yaw)
        base = polar(0.04, yaw, -0.03)
        reach = h * rng.uniform(0.32, 0.38)
        P0 = base
        P1 = base + out * (h * 0.02) + UP * (h * 0.8)
        P2 = base + out * (reach * 0.72) + UP * (h * 1.06)
        P3 = base + out * reach + UP * (h * 0.97)
        pts = C.bezier_points(P0, P1, P2, P3, 5)
        bm, _ = C.tube(pts, [0.03, 0.024, 0.02, 0.017, 0.016], sides=3, cap_start=False,
                       cap_end=False, phase=rng.uniform(0, TAU))
        stem = C.mesh_object(f'_stem{k}', bm, 'Leaf')
        C.set_shade(stem, C.gradient(0.0, h * 0.6, 0.6, 1.0))
        parts.append(stem)
        tip = pts[-1]
        blen = 0.3 * (h / 1.2) ** 0.5
        parts.append(bulb_shape(tip - UP * 0.02, blen, blen * 0.44, sides=5))
        bm, _ = C.lathe([(blen * 0.38, -0.05), (0.0, 0.03)], sides=5, cap_bottom=False,
                        center=tip, phase=rng.uniform(0, TAU))
        hood = C.mesh_object(f'_hood{k}', bm, 'Leaf')
        C.set_normals(hood, C.radial_normals(tip - UP * 0.05, 0.9))
        parts.append(hood)
    bm = new_bm()
    for k in range(3):
        yaw = a0 + 1.0 + k * TAU / 3 + rng.uniform(-0.3, 0.3)
        leaf_blade(bm, polar(0.02, yaw, -0.01), yaw, rng.uniform(0.3, 0.38), 0.07, rise=0.28,
                   droop=0.3)
    leaves = C.mesh_object('_leaves', bm, 'Leaf')
    C.set_normals(leaves, dome_normals((0, 0, -0.3), 0.5))
    C.set_shade(leaves, C.gradient(0.0, 0.1, 0.65, 1.0))
    parts.append(leaves)
    ob = C.join(parts, 'glow_bulb')
    return ob, dict(collider=None, finalize=dict(ao=dict(distance=0.2, samples=32, floor=0.6)))


@asset('bush_round', 'bush', 260,
       notes='3 soft clumped foliage masses + 1 LeafAlt highlight lobe; closed meshes '
             '(single-sided safe). Walk-through, no collider.')
def bush_round(rng):
    masses = [
        dict(c=(0.0, 0.02, 0.72), R=0.7, squash=0.82, lobes=7, ground=(0.06, 0.25)),
        dict(c=(0.62, -0.3, 0.46), R=0.52, squash=0.85, lobes=5, ground=(0.04, 0.25)),
        dict(c=(-0.58, -0.22, 0.48), R=0.5, squash=0.85, lobes=5, ground=(0.04, 0.25)),
        dict(c=(0.12, -0.24, 1.22), R=0.34, squash=0.85, lobes=3, lobe_d=(0.4, 0.5),
             slot='LeafAlt'),
    ]
    for m in masses:
        x, y, z = m['c']
        m['c'] = (x + rng.uniform(-0.04, 0.04), y + rng.uniform(-0.04, 0.04), z)
    seed = rng.random()
    objs = fit_masses(masses, 260, seed)
    soften_masses(objs, masses, (0.0, 0.0, 0.25), top=(0.0, 1.4))
    ob = C.join(objs, 'bush_round')
    zmin = min(v.co.z for v in ob.data.vertices)
    C.transform(ob, Matrix.Translation((0, 0, -zmin - 0.05)))  # bed the base 5 cm into the ground
    return ob, dict(collider=None, layout=dict(masses=masses, seed=seed, center=(0.0, 0.0, 0.25),
                                               top=(0.0, 1.4)),
                    finalize=dict(ao=dict(distance=0.5, samples=64, floor=0.5, smooth=1)))


def ribbed_column(name, pts, radii, ribs, rng, depth=0.2, tip_len=0.55, glow=True):
    """Ribbed succulent body along a path, closed by a rounded Glow crown at the end."""
    phase = rng.uniform(0, TAU)

    def rib(i, j, a):
        return 1.0 + depth * (0.5 + 0.5 * math.cos(ribs * (a - phase))) - depth * 0.5
    end_dir = (pts[-1] - pts[-2]).normalized()
    top = pts[-1] + end_dir * (radii[-1] * tip_len)
    bm, rings = C.tube(pts, radii, sides=ribs * 2, cap_start=False, end_tip=top, radial=rib,
                       phase=phase)
    for i in range(len(rings) - 1):  # crisp valleys: each rib shades as its own soft lobe
        for j in range(1, ribs * 2, 2):
            e = bm.edges.get((rings[i][j], rings[i + 1][j]))
            if e is not None:
                e.smooth = False
    ob = C.mesh_object(name, bm, 'Leaf')
    if glow:
        C.paint_faces(ob, lambda p: 'Glow' if (p.center - top).length < radii[-1] * 0.85 else None)
    return ob


@asset('cactus_alien', 'plant', 320,
       notes='Bulbous ribbed column with two curving arms, Glow crowns and areole studs. '
             'Collider covers the main column.')
def cactus_alien(rng):
    parts = []
    H = 2.5
    prof = [(-0.08, 0.36), (0.12, 0.44), (0.36, 0.46), (0.62, 0.4), (0.84, 0.31), (0.95, 0.21)]
    pts = [Vector((0, 0, H * z)) for z, _ in prof]
    parts.append(ribbed_column('_main', pts, [r for _, r in prof], 6, rng, depth=0.24))
    columns = [(pts, [r for _, r in prof])]
    arms = [  # (yaw, attach height, out, up, radius)
        (rng.uniform(0, TAU), 0.95, 0.62, 0.95, 0.24),
        (None, 0.6, 0.55, 0.62, 0.2),
    ]
    yaw0 = arms[0][0]
    for k, (yaw, zh, reach, rise, r) in enumerate(arms):
        yaw = yaw if yaw is not None else yaw0 + math.pi * rng.uniform(0.8, 1.15)
        out, _ = yaw_dirs(yaw)
        a = Vector((0, 0, zh)) + out * 0.18
        P = [a, a + out * (reach * 0.75), a + out * reach + UP * (rise * 0.35), a + out * reach + UP * rise]
        apts = C.bezier_points(*P, 4)
        radii = [r * 0.9, r * 1.05, r * 0.95, r * 0.72]
        parts.append(ribbed_column(f'_arm{k}', apts, radii, 5, rng, depth=0.24))
        columns.append((apts, radii))
    # areoles: small glowing studs on the main column's ridges
    studs = new_bm()
    for k in range(4):
        a = rng.uniform(0, TAU)
        z = rng.uniform(0.35, 1.9)
        rr = 0.42 * 1.12
        c = Vector((math.cos(a) * rr, math.sin(a) * rr, z))
        n = Vector((math.cos(a), math.sin(a), 0.25)).normalized()
        u, v = C.basis(n)
        ring = [studs.verts.new(c + (u * math.cos(TAU * m / 4) + v * math.sin(TAU * m / 4)) * 0.045 - n * 0.03) for m in range(4)]
        apex = studs.verts.new(c + n * 0.05)
        for m in range(4):
            f = studs.faces.new((ring[m], ring[(m + 1) % 4], apex))
            f.normal_update()
            if f.normal.dot(n) < 0:
                f.normal_flip()
    parts.append(C.mesh_object('_studs', studs, 'Glow'))
    for p in parts[:-1]:
        C.set_shade(p, C.gradient(0.0, H * 0.4, 0.75, 1.0))
    ob = C.join(parts, 'cactus_alien')
    return ob, dict(collider=dict(type='cylinder', radius=0.5, height=2.5),
                    layout=dict(columns=columns, H=H),
                    finalize=dict(ao=dict(distance=0.45, samples=48, floor=0.5)))


@asset('coral_fan', 'plant', 160,
       notes='Knobby finger coral fanning out in the X-Z plane (faces -Y), cupped toward -Y. '
             'Closed tubes; walk-through.')
def coral_fan(rng):
    parts = []

    def finger(a, d, length, r0, r1, sides, tip=True):
        b = a + d * length
        bm, _ = C.tube([a - d * (r0 * 0.6), b], [r0, r1], sides=sides, cap_start=False, cap_end=not tip,
                       end_tip=(b + d * (r1 * 0.6)) if tip else None, phase=rng.uniform(0, TAU))
        ob = C.mesh_object('_f', bm, 'Petal')
        return ob, b

    base = Vector((0, 0, -0.1))
    trunk, top = finger(base, Vector((0.02, 0, 1)).normalized(), 0.26, 0.1, 0.085, 6, tip=False)
    parts.append(trunk)
    for i, ang in enumerate((-0.62, 0.0, 0.6)):
        ang += rng.uniform(-0.08, 0.08)
        d = Vector((math.sin(ang), -0.12, math.cos(ang))).normalized()
        br, end = finger(top, d, rng.uniform(0.17, 0.21), 0.08, 0.07, 5, tip=False)
        parts.append(br)
        for j, sub in enumerate((-0.38, 0.34)):
            sa = ang + sub + rng.uniform(-0.1, 0.1)
            sd = Vector((math.sin(sa), -0.1 - 0.12 * abs(sa), math.cos(sa))).normalized()
            f, _ = finger(end, sd, rng.uniform(0.17, 0.24) * (0.8 if i != 1 else 1.0), 0.066, 0.058, 4)
            parts.append(f)
    for k in range(2):  # small side knobs on the trunk
        a = rng.uniform(0, TAU)
        d = Vector((math.cos(a) * 0.8, math.sin(a) * 0.3 - 0.2, 0.55)).normalized()
        p = base + Vector((0, 0, 0.12 + 0.07 * k))
        f, _ = finger(p, d, 0.12, 0.05, 0.045, 4)
        parts.append(f)
    ob = C.join(parts, 'coral_fan')
    C.transform(ob, Matrix.Scale(1.55, 4))  # authored at 0.6 m; ship at ~0.9 m
    return ob, dict(collider=None, finalize=dict(ao=dict(distance=0.28, samples=48, floor=0.5)))


# ----------------------------------------------------------------------------
# Trees
# ----------------------------------------------------------------------------

def flare_radial(amount, lobes=3, phase=0.0, rings=1):
    """radial() for tube(): buttress roots on the first `rings` rings."""
    def fn(i, j, a):
        if i >= rings:
            return 1.0
        k = 1.0 - i / rings
        return 1.0 + amount * k * max(0.0, math.cos(lobes * (a - phase))) ** 2
    return fn


@asset('tree_round', 'tree', 700,
       notes='Broadleaf tree: S-curved trunk with root flare and a fork, 5 soft clumped foliage '
             'masses + 3 LeafAlt highlight lobes (closed meshes). Collider = trunk.')
def tree_round(rng):
    wood = []
    trunk_pts = [Vector((0, 0, -0.2)), Vector((0.16, 0.05, 1.0)), Vector((-0.1, 0.02, 2.1)),
                 Vector((0.05, -0.04, 3.05)), Vector((0.12, -0.02, 3.7))]
    bm, _ = C.tube(trunk_pts, [0.66, 0.46, 0.4, 0.37, 0.32], sides=7, cap_start=False,
                   cap_end=True, radial=flare_radial(0.42, 3, rng.uniform(0, TAU), rings=1))
    wood.append(C.mesh_object('_trunk', bm, 'Bark'))
    fork = trunk_pts[-2]
    limbs = [
        (fork, Vector((1.05, 0.3, 4.55)), Vector((1.7, 0.5, 5.4)), 0.3, 6),
        (fork, Vector((-0.95, -0.3, 4.4)), Vector((-1.55, -0.45, 5.15)), 0.28, 6),
        (trunk_pts[-1], Vector((0.2, 0.45, 5.1)), Vector((0.3, 1.1, 5.9)), 0.24, 5),
    ]
    for k, (a, b, c, r, sides) in enumerate(limbs):
        pts = [a, a.lerp(b, 0.55) + Vector((0, 0, 0.12)), b, c]
        bm, _ = C.tube(pts, [r, r * 0.84, r * 0.68, r * 0.5], sides=sides, cap_start=False,
                       cap_end=True, phase=rng.uniform(0, TAU))
        wood.append(C.mesh_object(f'_limb{k}', bm, 'Bark'))
    for w in wood:
        C.triangulate(w)
    masses = [
        dict(c=(0.1, 0.05, 6.6), R=2.0, squash=0.78),
        dict(c=(1.75, 0.5, 5.55), R=1.5, squash=0.8),
        dict(c=(-1.6, -0.45, 5.3), R=1.45, squash=0.8),
        dict(c=(0.35, 1.55, 5.75), R=1.4, squash=0.8),
        dict(c=(-0.45, -1.55, 6.0), R=1.38, squash=0.8),
        dict(c=(0.6, -0.5, 7.85), R=0.95, squash=0.82, lobes=3, lobe_d=(0.4, 0.5), slot='LeafAlt'),
        dict(c=(-0.8, 0.7, 7.55), R=0.8, squash=0.82, lobes=3, lobe_d=(0.4, 0.5), slot='LeafAlt'),
        dict(c=(1.9, 0.25, 6.55), R=0.72, squash=0.82, lobes=3, lobe_d=(0.4, 0.5), slot='LeafAlt'),
    ]
    for m in masses:
        m['c'] = tuple(x + rng.uniform(-0.08, 0.08) for x in m['c'])
    seed = rng.random()
    objs = fit_masses(masses, 10 ** 6, seed)        # probe: wood hidden in the masses is free
    C.remove_hidden_faces(wood, occluders=objs)
    for o in objs:
        C.delete(o)
    objs = fit_masses(masses, 700, seed, wood=wood)
    soften_masses(objs, masses, (0.1, 0.0, 5.0), top=(3.8, 8.6))
    for w in wood:
        C.set_shade(w, C.gradient(0.0, 4.0, 0.85, 1.0))
        C.set_ao_weight(w, 0.6)
    ob = C.join(wood + objs, 'tree_round')
    return ob, dict(collider=dict(type='cylinder', radius=0.5, height=4.0),
                    layout=dict(masses=masses, seed=seed, trunk=trunk_pts, limbs=limbs,
                                center=(0.1, 0.0, 5.0), top=(3.8, 8.6)),
                    finalize=dict(ao=dict(distance=1.8, samples=64, floor=0.45, smooth=1)))


def tier_normals(c, cz):
    """Soft, up-biased dome normals for one conifer tier (center c, normal origin height cz)."""
    def fn(co, n):
        d = co - Vector((c.x, c.y, cz))
        return (Vector((d.x, d.y, d.z * 1.4)).normalized() + UP * 0.55).normalized()
    return fn


@asset('tree_pine', 'tree', 520,
       notes='Stylized conifer: 6 stacked drooping scalloped tiers (closed). Collider = trunk.')
def tree_pine(rng):
    lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0.0))
    bm, _ = C.tube([Vector((0, 0, -0.2)), Vector((0, 0, 1.8)) + lean * 0.15,
                    Vector((0, 0, 6.5)) + lean * 0.6],
                   [0.42, 0.28, 0.12], sides=6, cap_start=False, end_tip=Vector((0, 0, 8.0)) + lean,
                   radial=flare_radial(0.5, 3, rng.uniform(0, TAU)))
    trunk = C.mesh_object('_trunk', bm, 'Bark')
    tiers, tier_specs = [], []
    spec = [  # (rim z, top z, radius, scallops)
        (1.65, 3.95, 2.7, 8), (2.85, 5.0, 2.25, 7), (3.98, 6.0, 1.86, 7),
        (5.08, 7.0, 1.46, 6), (6.12, 8.0, 1.06, 6), (7.15, 9.15, 0.68, 5),
    ]
    for k, (zb, zt, R, n) in enumerate(spec):
        h = zt - zb
        c = lean * ((zb + zt) * 0.5 / 9.0)
        phase = rng.uniform(0, TAU)

        def star(i, j, a):
            tip = j % 2 == 0
            if i == 1:  # rim
                return 1.07 if tip else 0.88
            if i == 2:  # ring A
                return 1.03 if tip else 0.96
            return 1.0
        # counter-clockwise profile: underside pole, underside ring, rim, ring A, top pole
        prof = [(0.0, zb + h * 0.3), (R * 0.42, zb + h * 0.13), (R, zb), (R * 0.56, zb + h * 0.5),
                (0.0, zt)]
        bm, rings = C.lathe(prof, sides=n * 2, radial=star, phase=phase, center=c)
        for j, v in enumerate(rings[1]):  # scallop tips droop, notches lift
            v.co.z += -0.24 * h if j % 2 == 0 else 0.05 * h
        for j, v in enumerate(rings[2]):
            v.co.z -= 0.06 * h if j % 2 == 0 else 0.0
        tier = C.mesh_object(f'_tier{k}', bm, 'Leaf')
        tier_specs.append((zb, zt, R, n, phase, c))
        C.set_normals(tier, tier_normals(c, zb + h * 0.22))
        tiers.append(tier)
    C.remove_hidden_faces(tiers + [trunk])
    ob = C.join([trunk] + tiers, 'tree_pine')
    return ob, dict(collider=dict(type='cylinder', radius=0.45, height=3.0),
                    layout=dict(lean=lean, tiers=tier_specs),
                    finalize=dict(ao=dict(distance=1.5, samples=64, floor=0.5)))


def shade_cap(cap, top, R):
    """Mushroom cap shading: normals half-way to a point under the dome, a dome that lightens
    toward the center and a slightly darker underside."""
    cc = top + Vector((0, 0, -0.6))
    C.set_normals(cap, lambda co, n: n.lerp((co - cc).normalized(), 0.5))

    def shade(co):
        if co.z <= top.z + 0.1:
            return 0.9
        return C.lerp(0.8, 1.0, 1.0 - C.smoothstep(0.3 * R, R, math.hypot(co.x - top.x, co.y - top.y)))
    C.set_shade(cap, shade)


@asset('tree_umbrella', 'tree', 600,
       notes='Alien mushroom tree: curved stem with a skirt ring, wide scalloped cap, 16 Glow '
             'spots underneath. Collider = stem.')
def tree_umbrella(rng):
    parts = []
    P = [Vector((0, 0, -0.2)), Vector((0.42, 0.05, 2.6)), Vector((0.05, -0.05, 5.0)),
         Vector((-0.35, 0.0, 6.85))]
    pts = C.bezier_points(*P, 7)
    radii = [0.62, 0.44, 0.37, 0.34, 0.32, 0.31, 0.31]
    bm, _ = C.tube(pts, radii, sides=8, cap_start=False, cap_end=False,
                   radial=flare_radial(0.4, 4, rng.uniform(0, TAU)))
    stem = C.mesh_object('_stem', bm, 'Bark')
    C.set_shade(stem, C.gradient(0.0, 6.0, 0.88, 1.0))
    parts.append(stem)
    ring_c = C.bezier(*P, 0.72)
    bm, _ = C.lathe([(0.33, -0.18), (0.74, -0.5), (0.33, 0.05)], sides=10, cap_bottom=False,
                    cap_top=False, center=ring_c,
                    radial=lambda i, j, a: (1.0 if j % 2 == 0 else 0.82) if i == 1 else 1.0)
    skirt = C.mesh_object('_skirt', bm, 'LeafAlt')
    C.set_normals(skirt, C.radial_normals(ring_c, 0.5))
    parts.append(skirt)
    top = pts[-1]
    R = 3.6
    sides = 20
    wob = [rng.uniform(0, TAU) for _ in range(3)]

    def wobble(a):
        return 0.3 * math.cos(3 * a + wob[0]) + 0.14 * math.cos(5 * a + wob[1])
    # counter-clockwise: underside from the stem out to the lip, around the rim, over the dome
    prof = [(0.0, 0.05), (R * 0.42, -0.08), (R * 0.8, -0.24), (R * 0.95, -0.4), (R, -0.12),
            (R * 0.9, 0.32), (R * 0.62, 0.8), (R * 0.3, 1.12), (R * 0.12, 1.36), (0.0, 1.4)]
    bm, rings = C.lathe(prof, sides=sides, center=top)
    for i, ring in enumerate(rings):
        rf = prof[i + 1][0] / R
        for j, v in enumerate(ring):
            a = TAU * j / sides
            v.co.z += wobble(a) * min(1.0, rf * 1.4)
            if i in (2, 3, 4):  # scalloped rim: alternate lobes out, notches in
                lobe = 1.06 if j % 2 == 0 else 0.95
                v.co.x = top.x + (v.co.x - top.x) * lobe
                v.co.y = top.y + (v.co.y - top.y) * lobe
                v.co.z += 0.08 if j % 2 == 1 else 0.0
    cap = C.mesh_object('_cap', bm, 'LeafAlt')
    shade_cap(cap, top, R)
    parts.append(cap)
    # bioluminescent spots on the underside, in two staggered rings
    from mathutils.bvhtree import BVHTree
    me = cap.data
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
    spots, spot_list = new_bm(), []
    for ring_i, (rf, count, size) in enumerate(((0.55, 7, 0.27), (0.8, 9, 0.24))):
        for k in range(count):
            a = TAU * (k + 0.5 * ring_i) / count + rng.uniform(-0.1, 0.1)
            probe = top + Vector((math.cos(a) * R * rf, math.sin(a) * R * rf, -2.0))
            hit = tree.ray_cast(probe, UP, 4.0)
            if hit[0] is None:
                continue
            loc, nrm = hit[0], hit[1]
            if nrm.z > 0:
                nrm = -nrm
            s = size * rng.uniform(0.85, 1.15)
            spot_list.append((loc.copy(), nrm.copy(), s))
            u, v = C.basis(nrm)
            ring = [spots.verts.new(loc + (u * math.cos(TAU * m / 6) + v * math.sin(TAU * m / 6)) * s - nrm * 0.01)
                    for m in range(6)]
            apex = spots.verts.new(loc + nrm * (s * 0.55))
            for m in range(6):
                f = spots.faces.new((ring[m], ring[(m + 1) % 6], apex))
                f.normal_update()
                if f.normal.dot(nrm) < 0:
                    f.normal_flip()
    glow = C.mesh_object('_spots', spots, 'Glow')
    C.set_normals(glow, lambda co, n: n)
    parts.append(glow)
    ob = C.join(parts, 'tree_umbrella')
    return ob, dict(collider=dict(type='cylinder', radius=0.55, height=6.8),
                    layout=dict(P=P, radii=radii, top=top, R=R, wob=wob, spots=spot_list),
                    finalize=dict(ao=dict(distance=1.4, samples=64, floor=0.45)))


@asset('tree_palm', 'tree', 600,
       notes='Ringed trunk curving toward +X, 9 pinnate drooping fronds (Leaf DoubleSide: they '
             'are seen from below), 3 coconuts. Collider = lower trunk.')
def tree_palm(rng):
    parts = []
    P0, P1, P2, P3 = (Vector((0, 0, -0.2)), Vector((0.05, 0, 2.8)), Vector((0.75, 0.1, 5.4)),
                      Vector((1.6, 0.2, 7.25)))
    nseg = 8
    pts, radii = [], []
    for s in range(nseg):
        for k, (dt, f) in enumerate(((0.0, 0.93), (0.84, 1.1))):
            t = (s + dt) / nseg
            pts.append(C.bezier(P0, P1, P2, P3, t))
            r = C.lerp(0.4, 0.24, t ** 0.8) * f
            if s == 0 and k == 0:
                r = 0.56
            radii.append(r)
    pts.append(C.bezier(P0, P1, P2, P3, 1.0))
    radii.append(0.22)
    bm, _ = C.tube(pts, radii, sides=6, cap_start=False, cap_end=True)
    trunk = C.mesh_object('_trunk', bm, 'Bark')
    C.set_shade(trunk, C.gradient(0.0, 6.0, 0.9, 1.0))
    parts.append(trunk)
    crown_c = P3 + Vector((0.06, 0.0, 0.12))
    bm = C.blob(crown_c, (0.36, 0.36, 0.42), subdivisions=1, lump=0.0)
    crown = C.mesh_object('_crown', bm, 'Bark')
    C.set_normals(crown, C.radial_normals(crown_c, 1.0))
    parts.append(crown)
    nuts = new_bm()
    a = rng.uniform(0, TAU)
    for k in range(3):
        if k:
            a += TAU / 3 + rng.uniform(-0.3, 0.3)
        nc = crown_c + polar(0.33, a, -0.3)
        C.blob(nc, (0.17, 0.17, 0.19), subdivisions=1, lump=0.0, bm=nuts)
    coconuts = C.mesh_object('_nuts', nuts, 'Bark')
    C.set_normals(coconuts, lambda co, n: n)
    parts.append(coconuts)
    bm = new_bm()
    a0 = rng.uniform(0, TAU)
    frond_specs = []
    for k in range(9):
        yaw = a0 + k * TAU / 9 + rng.uniform(-0.15, 0.15)
        young = k in (0, 5)
        f = dict(base=crown_c + polar(0.15, yaw, 0.22), yaw=yaw,
                 length=rng.uniform(2.9, 3.5) * (0.82 if young else 1.0), width=rng.uniform(0.62, 0.7),
                 rise=0.6 if young else rng.uniform(0.3, 0.44),
                 droop=0.25 if young else rng.uniform(0.55, 0.85))
        frond_specs.append(f)
        comb_frond(bm, f['base'], yaw, f['length'], f['width'], rise=f['rise'], droop=f['droop'],
                   segs=14, fold=0.55, sweep=1.25)
    fronds = C.mesh_object('_fronds', bm, 'Leaf')
    C.set_normals(fronds, dome_normals(crown_c - Vector((0, 0, 1.2)), 0.35))
    parts.append(fronds)
    ob = C.join(parts, 'tree_palm')
    return ob, dict(collider=dict(type='cylinder', radius=0.45, height=5.0),
                    layout=dict(trunk=(P0, P1, P2, P3), crown=crown_c, fronds=frond_specs),
                    finalize=dict(ao=dict(distance=1.2, samples=48, floor=0.5)))


# ----------------------------------------------------------------------------
# Rocks and landforms
# ----------------------------------------------------------------------------

def chiseled_rock(name, radii, rng, cuts=6, depth=(0.7, 0.86), lump=0.08, sink=0.1, bevel=0.035,
                  subdivisions=2, slot='Rock', center=(0.0, 0.0), top_cut=True, decimate_to=None):
    """Rounded boulder with a few planar chisel facets and soft bevels.

    A lumpy ellipsoid is sliced by `cuts` planes (mostly from the sides and top), each cut
    capped flat. Only the borders of those facets are bevelled (one segment), so the rounded
    parts stay cheap; finalize(weighted=True) then keeps facets flat while bevels and rounded
    areas shade smoothly.
    """
    rx, ry, rz = radii
    c = Vector((center[0], center[1], rz - sink))
    bm = C.blob(c, radii, subdivisions=subdivisions, lump=lump, lump_scale=1.3,
                seed=rng.uniform(0, 50))
    if decimate_to:
        tmp = C.mesh_object('_tmp', bm, slot)
        C.decimate(tmp, target_tris=decimate_to)
        bm = bmesh.new()
        bm.from_mesh(tmp.data)
        C.delete(tmp)
    facet = bm.faces.layers.int.new('facet')
    for k in range(cuts):
        a = rng.uniform(0, TAU)
        el = rng.uniform(1.15, 1.45) if (k == 0 and top_cut) else rng.uniform(-0.25, 0.75)
        d = Vector((math.cos(el) * math.cos(a), math.cos(el) * math.sin(a), math.sin(el)))
        ext = max((v.co - c).dot(d) for v in bm.verts)
        for f in C.chisel(bm, c + d * (ext * rng.uniform(*depth)), d):
            f[facet] = 1
    if bevel:
        bw = bm.edges.layers.float.new('bevel_weight_edge')
        for e in bm.edges:
            fs = e.link_faces
            if len(fs) == 2 and (fs[0][facet] or fs[1][facet]) and fs[0].normal.angle(fs[1].normal, 0) > 0.35:
                e[bw] = 1.0
    ob = C.mesh_object(name, bm, slot)
    if bevel:
        C.bevel_weighted(ob, bevel)
    a = ob.data.attributes.get('facet')
    if a is not None:
        ob.data.attributes.remove(a)
    return ob


def fit_rock(name, budget, rng, tries, **kw):
    """chiseled_rock() at the richest base resolution whose result fits `budget` triangles.

    tries: decimate_to values from rich to lean. The RNG is re-seeded per try so the result
    is deterministic.
    """
    import random
    seed = rng.random()
    for target in tries:
        ob = chiseled_rock(name, rng=random.Random(seed), decimate_to=target, **kw)
        if C.tri_count(ob) <= budget:
            return ob
        C.delete(ob)
    raise RuntimeError(f'{name}: no rock variant fits {budget} triangles')


def strata_paint(top_slot='Rock', top_dot=0.55):
    """paint_faces() callback: upward-facing faces get the light top slot."""
    return lambda p: top_slot if p.normal.z > top_dot else None


def organic_column(profile, sides, rng, lean=(0.0, 0.0), twist=0.0, noise_amp=0.1,
                   base_r=1.0, tip=None, wobble=0.35, dip=0.0, ledge_spread=0.35,
                   cap_bottom=True, height=None):
    """Irregular leaning column (bmesh) for spires. Returns (bmesh, kinds).

    profile: [(z, radius scale, kind, ledge, stratum)] bottom to top. A ring with ledge > 0
    is pushed out by up to that fraction on one broad side (a direction picked per stratum
    and shared by that stratum's rings), so strata read as lopsided eroded shelves rather
    than full discs. Ring outlines are irregular (smooth 3D noise), twist with height and
    follow a leaning, gently S-curved spine (`wobble`). Every ring above the 'foot' is tilted
    by `dip` radians towards one direction, so the strata dip consistently instead of
    stacking level. Faces carry an int layer 'band': index of their lower ring + 1 (faces
    added later, e.g. chisel caps, read 0); kinds[i] is the kind of ring i. The (buried)
    bottom is capped by default so later chisel cuts always close into flat facets. `height`
    (default: the last profile z) scales the spine curve, so a reduced profile of the same
    spire (its far LOD) follows the same lean.
    """
    bm = bmesh.new()
    band = bm.faces.layers.int.new('band')
    H = height or profile[-1][0]
    off = (rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50))
    wob = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0.0)).normalized() * wobble
    dip_dir = rng.uniform(0, TAU)
    tilt = math.tan(dip) * base_r
    ldir, ldirs = rng.uniform(0, TAU), {}
    rings, kinds = [], []
    for z, s, kind, ledge, stratum in profile:
        t = max(0.0, z) / H
        cx = lean[0] * t ** 1.5 + wob.x * math.sin(math.pi * t)
        cy = lean[1] * t ** 1.5 + wob.y * math.sin(math.pi * t)
        if stratum not in ldirs:  # each stratum's ledge juts out on its own side
            ldir += rng.uniform(1.6, 3.2)
            ldirs[stratum] = ldir
        w = 0.0 if kind == 'foot' else 1.0
        ring = []
        for j in range(sides):
            a = TAU * j / sides + twist * t
            d = Vector((math.cos(a), math.sin(a), 0.0))
            k = 1.0 + noise_amp * C.noise3(Vector((d.x * 1.3, d.y * 1.3, z * 0.35)), 1.0, off)
            if ledge:
                f = C.clamp((math.cos(a - ldirs[stratum]) + ledge_spread) / (1.0 + ledge_spread))
                k *= 1.0 + ledge * f ** 1.3
            r = base_r * s * k
            zz = z + w * tilt * math.cos(a - dip_dir)
            ring.append(bm.verts.new(Vector((cx + d.x * r, cy + d.y * r, zz))))
        rings.append(ring)
        kinds.append(kind)
    for i in range(len(rings) - 1):
        for j in range(sides):
            k = (j + 1) % sides
            f = bm.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
            f[band] = i + 1
    if tip is not None:
        apex = bm.verts.new(Vector(tip))
        for j in range(sides):
            f = bm.faces.new((rings[-1][j], rings[-1][(j + 1) % sides], apex))
            f[band] = len(rings)
    if cap_bottom:
        bm.faces.new(list(reversed(rings[0])))
    return bm, kinds


def spire_profile(rng, H=6.0, strata=3):
    """Hoodoo-like strata profile [(z, scale, kind, ledge, stratum)] for organic_column():
    a flared foot, then per stratum a soft eroded waist under a hard caprock (a ledge with a
    vertical face: 'lip' to 'lipt') and an inset 'shelf'; irregular stratum heights, widths
    and ledge sizes, tapering to a point."""
    prof = [(-0.3, 1.12, 'foot', 0.0, -1), (0.3, 1.0, 'base', 0.0, -1)]
    z, s = 0.3, 1.0
    heights = [rng.uniform(0.85, 1.2) for _ in range(strata)]
    unit = (H * 0.8 - z) / sum(heights)
    for i, hgt in enumerate(heights):
        top = z + unit * hgt              # top of this stratum's caprock shelf
        th = rng.uniform(0.16, 0.24)      # caprock thickness
        z_lip = top - th - 0.06
        led = rng.uniform(0.16, 0.28) * (1.0 - 0.3 * i / max(1, strata - 1))
        prof += [(z + (z_lip - z) * 0.55, s * rng.uniform(0.84, 0.9), 'soft', 0.0, i),
                 (z_lip, s, 'lip', led, i),
                 (z_lip + th, s * 0.97, 'lipt', led, i),
                 (top, s * 0.85, 'shelf', led * 0.25, i)]
        z = top
        s *= rng.uniform(0.74, 0.84)
    prof.append((H * 0.92, s * 0.62, 'top', 0.0, -1))
    return prof


@asset('rock_boulder', 'rock', 200,
       notes='Rounded boulder with planar chisel facets and soft bevels; sunk 12 cm.')
def rock_boulder(rng):
    ob = fit_rock('_boulder', 200, rng, (78, 70, 62, 56, 50, 44, 38), radii=(0.84, 0.72, 0.6),
                  cuts=6, sink=0.12, bevel=0.04)
    ob = C.join([ob], 'rock_boulder')
    return ob, dict(collider=dict(type='cylinder', radius=0.7, height=1.1),
                    finalize=dict(weighted=True, ao=dict(distance=0.7, samples=64, floor=0.45)))


@asset('rock_slab', 'rock', 220,
       notes='3 tilted angular plates, broken corner: Rock tops, RockDark strata sides; '
             'low edge buried.')
def rock_slab(rng):
    parts, plates = [], []
    base = C.outline(7, 1.32, 0.82, rng, jitter=0.07, angle_jitter=0.5)
    layers = [  # (z0, z1, scale, offset, rotation, side slot)
        (-0.45, 0.32, 1.0, (0.0, 0.0), 0.0, 'RockDark'),
        (0.24, 0.55, 0.8, (-0.18, 0.08), 0.12, 'Rock'),
        (0.48, 0.7, 0.56, (-0.36, 0.0), -0.1, 'RockDark'),
    ]
    for k, (z0, z1, s, (ox, oy), rot, slot) in enumerate(layers):
        poly = []
        for x, y in base:
            x, y = x * s * rng.uniform(0.93, 1.07), y * s * rng.uniform(0.93, 1.07)
            poly.append((x * math.cos(rot) - y * math.sin(rot) + ox, x * math.sin(rot) + y * math.cos(rot) + oy))
        plates.append((poly, z0, z1, slot))
        ch = 0.06
        bm, _ = C.extrude_profile(poly, [(z0, 1.0, 0.0), (z1 - ch, 0.98, 0.0), (z1, 0.98, ch)],
                                  bottom=k > 0)
        if k == 0:  # a broken-off corner on the bottom plate
            a = rng.uniform(0, TAU)
            d = Vector((math.cos(a), math.sin(a), 0.45)).normalized()
            ext = max(v.co.dot(d) for v in bm.verts)
            C.chisel(bm, d * (ext * 0.82), d)
        parts.append(C.mesh_object(f'_layer{k}', bm, slot))
    tilt = Matrix.Rotation(math.radians(15), 4, 'Y') @ Matrix.Rotation(math.radians(-6), 4, 'X')
    for p in parts:
        C.transform(p, Matrix.Translation((0, 0, 0.12)) @ tilt)
    C.remove_hidden_faces(parts)
    for p in parts:
        C.paint_faces(p, strata_paint())
    ob = C.join(parts, 'rock_slab')
    return ob, dict(collider=dict(type='cylinder', radius=1.1, height=1.0),
                    layout=dict(plates=plates, xform=Matrix.Translation((0, 0, 0.12)) @ tilt),
                    finalize=dict(weighted=True, ao=dict(distance=0.8, samples=64, floor=0.5)))


@asset('rock_spire', 'rock', 260,
       notes='Organic leaning hoodoo spire: one irregular column with dipping strata (soft '
             'eroded waists with RockDark undercuts under chunky lopsided Rock caprock ledges), '
             'chiselled flank facets and peak.')
def rock_spire(rng):
    prof = spire_profile(rng, 6.0, 3)
    column = dict(lean=(0.9, -0.35), twist=0.5, noise_amp=0.12, base_r=1.08, dip=math.radians(10))
    state = rng.getstate()
    bm, kinds = organic_column(prof, 7, rng, tip=(1.02, -0.4, 6.3), **column)
    # chisel a few long planar facets into the flanks and one across the peak
    a = rng.uniform(0, TAU)
    for k in range(3):
        if k:
            a += TAU / 3 + rng.uniform(-0.4, 0.4)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.15, 0.4))).normalized()
        c = Vector((0.0, 0.0, rng.uniform(1.0, 3.5)))
        ext = max((v.co - c).dot(d) for v in bm.verts)
        C.chisel(bm, c + d * (ext * rng.uniform(0.84, 0.9)), d)
    d = Vector((rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), 1.0)).normalized()
    top = max(v.co.z for v in bm.verts)
    C.chisel(bm, Vector((0.9, -0.35, top - 0.35)), d)
    # strata colors: RockDark only on the undercut (soft waist up to the ledge lip); ledges,
    # shelves, walls and chisel facets stay Rock
    dark = {i + 1 for i, kind in enumerate(kinds[:-1]) if kind == 'soft'}
    ob = C.mesh_object('_spire', bm, 'Rock')
    band = ob.data.attributes['band']
    C.paint_faces(ob, lambda p: 'RockDark' if band.data[p.index].value in dark else None)
    ob.data.attributes.remove(band)
    ob = C.join([ob], 'rock_spire')
    return ob, dict(collider=dict(type='cylinder', radius=1.0, height=5.6),
                    layout=dict(profile=prof, column=column, state=state, tip=(1.02, -0.4)),
                    finalize=dict(weighted=True, ao=dict(distance=0.9, samples=64, floor=0.6, smooth=2)))


@asset('rock_pebbles', 'rock', 150, notes='Cluster of 5 smooth river stones; decor, no collider.')
def rock_pebbles(rng):
    parts = []
    stones = [((0.0, 0.0), (0.21, 0.17, 0.095), 40, 'Rock'), ((0.28, 0.13), (0.15, 0.12, 0.07), 30, 'RockDark'),
              ((-0.24, 0.17), (0.14, 0.11, 0.07), 28, 'Rock'), ((0.1, -0.26), (0.11, 0.09, 0.055), 26, 'Rock'),
              ((-0.27, -0.15), (0.1, 0.08, 0.05), 24, 'RockDark')]
    for k, ((x, y), r, tris, slot) in enumerate(stones):
        x += rng.uniform(-0.03, 0.03)
        y += rng.uniform(-0.03, 0.03)
        c = Vector((x, y, r[2] * 0.62))
        bm = C.blob(c, r, subdivisions=2, lump=0.06, seed=rng.uniform(0, 50))
        ob = C.mesh_object(f'_pebble{k}', bm, slot)
        C.transform(ob, Matrix.Translation(c) @ Matrix.Rotation(rng.uniform(0, TAU), 4, 'Z')
                    @ Matrix.Rotation(rng.uniform(-0.2, 0.2), 4, 'X') @ Matrix.Translation(-c))
        C.decimate(ob, target_tris=tris)
        C.set_normals(ob, C.radial_normals(c, 0.9, squash=(1.0, 1.0, 1.8)))
        parts.append(ob)
    ob = C.join(parts, 'rock_pebbles')
    return ob, dict(collider=None, finalize=dict(ao=dict(distance=0.18, samples=64, floor=0.45)))


@asset('mesa_chunk', 'landform', 700,
       notes='Mid/far-distance butte: talus skirt, 3 strata (RockDark middle), flat top; '
             '~38 m wide, ~25 m tall. Collider approximates the cliff core.')
def mesa_chunk(rng):
    parts = []
    n = 26
    base = C.outline(n, 16.5, 12.5, rng, jitter=0.05, lobes=[(2, 0.07), (3, 0.05), (5, 0.03)])
    for g in rng.sample(range(n), 5):  # erosion gullies
        x, y = base[g]
        base[g] = (x * 0.86, y * 0.86)
    talus = [(x * 1.2, y * 1.2) for x, y in base]
    bm, _ = C.extrude_profile(talus, [(-0.6, 1.0, 0.0), (1.6, 0.93, 0.0), (3.8, 0.85, 0.0)],
                              top=False, bottom=False)
    parts.append(C.mesh_object('_talus', bm, 'Rock'))
    strata = [(3.2, 9.8, 1.0, 'Rock'), (9.5, 16.4, 0.9, 'RockDark'), (16.1, 24.6, 0.81, 'Rock')]
    layers = []
    for k, (z0, z1, s, slot) in enumerate(strata):
        poly = [(x * s * rng.uniform(0.97, 1.03), y * s * rng.uniform(0.97, 1.03)) for x, y in base]
        mid = (z0 + z1) * 0.5
        layers.append((poly, z0, z1, slot))
        bm, _ = C.extrude_profile(poly, [(z0, 1.0, 0.0), (mid, 0.99, 0.0), (z1 - 0.6, 0.97, 0.0),
                                         (z1, 0.97, 0.6)], bottom=k > 0)
        parts.append(C.mesh_object(f'_stratum{k}', bm, slot))
    C.remove_hidden_faces(parts)
    for p in parts:
        C.paint_faces(p, strata_paint())
    ob = C.join(parts, 'mesa_chunk')
    return ob, dict(collider=dict(type='cylinder', radius=15.0, height=24.6),
                    layout=dict(base=base, talus=talus, layers=layers),
                    finalize=dict(weighted=True, ao=dict(distance=5.0, samples=48, floor=0.62, smooth=2)))


def arch_ring(bm, t, sides, A, B, base_z, off, phase=None):
    """One cross-section ring of the sandstone arch at path parameter t (0 left foot .. 1
    right foot): a rounded-rectangle section, massive at the feet and slimmer over the span,
    displaced by smooth 3D noise. Returns the ring's BMVerts."""
    phi = math.pi * (1.0 - t)
    c = Vector((A * math.cos(phi), 0.0, B * math.sin(phi) + base_z))
    tan = Vector((A * math.sin(phi), 0.0, -B * math.cos(phi))).normalized()
    nrm = tan.cross(Vector((0, 1, 0))).normalized()  # in the arch plane
    if nrm.dot(c - Vector((0, 0, base_z))) < 0:
        nrm = -nrm
    s = math.sin(math.pi * t)
    th = 5.0 - 2.3 * s ** 1.3   # radial thickness: massive feet, slimmer span
    dp = 5.2 - 1.6 * s           # depth along Y
    ring = []
    for j in range(sides):
        a = TAU * j / sides + (math.pi / sides if phase is None else phase)
        ca, sa = math.cos(a), math.sin(a)
        k = 1.0 / max(abs(ca), abs(sa)) ** 0.4  # rounded-rectangle section
        p = c + nrm * (ca * th * 0.5 * k) + Vector((0, 1, 0)) * (sa * dp * 0.5 * k)
        p += Vector((C.noise3(p, 0.2, off), C.noise3(p, 0.2, (off[1], off[2], off[0])),
                     0.4 * C.noise3(p, 0.2, (off[2], off[0], off[1])))) * 0.45
        ring.append(bm.verts.new(p))
    return ring


@asset('sandstone_arch', 'landform', 800,
       notes='Natural arch spanning X, opening faces -Y; thin RockDark strata, talus boulders. '
             'collider is null so the opening stays walkable: use `colliders` (two leg cylinders, '
             'offset in three.js space [x, y, z]).')
def sandstone_arch(rng):
    N, sides = 22, 8
    A, B, base_z = 5.2, 12.0, -1.6
    bm = bmesh.new()
    off = (rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50))
    rings = [arch_ring(bm, i / (N - 1), sides, A, B, base_z, off) for i in range(N)]
    for i in range(N - 1):
        for j in range(sides):
            k = (j + 1) % sides
            bm.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bands = ((2.6, 3.3), (6.4, 7.0), (10.0, 10.5))  # thin dark strata
    for z in [z for b in bands for z in b]:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), dist=1e-4)
    arch = C.mesh_object('_arch', bm, 'Rock')
    C.paint_faces(arch, lambda p: 'RockDark' if any(a < p.center.z < b for a, b in bands) else None)
    parts = [arch]
    talus = ((-7.6, -1.6, 1.0), (7.4, 2.0, 1.15), (-5.0, 3.0, 0.7))
    for k, (x, y, R) in enumerate(talus):
        rock = chiseled_rock(f'_talus{k}', (R * 1.2, R, R * 0.8), rng, cuts=4, sink=0.2,
                             bevel=0.0, subdivisions=2, center=(x, y), decimate_to=30)
        parts.append(rock)
    C.remove_hidden_faces(parts)
    ob = C.join(parts, 'sandstone_arch')
    legs = [dict(type='cylinder', radius=2.6, height=8.0, offset=[-5.0, 0.0, 0.0]),
            dict(type='cylinder', radius=2.6, height=8.0, offset=[5.0, 0.0, 0.0])]
    return ob, dict(collider=None, colliders=legs,
                    layout=dict(A=A, B=B, base_z=base_z, off=off, bands=bands, talus=talus),
                    finalize=dict(weighted=True, ao=dict(distance=2.5, samples=48, floor=0.55)))


# ----------------------------------------------------------------------------
# Crystals
# ----------------------------------------------------------------------------

def crystal(bm, base, direction, length, radius, rng, sides=6, tip=0.26, chamfer=False,
            apex_shift=0.25, taper=0.9, log=None):
    """Faceted crystal: prism body from `base` (embedded, open) with a pyramid tip.

    chamfer=True doubles the side count with narrow edge facets that catch light (a bevel).
    log: a list that receives the resolved parameters (far LODs rebuild the same crystal).
    """
    d = Vector(direction).normalized()
    u, v = C.basis(d)
    rot = rng.uniform(0, TAU)
    body = length * (1.0 - tip)

    def ring(at, r):
        out = []
        for j in range(sides):
            if chamfer:
                k, odd = divmod(j, 2)
                a = rot + TAU * k / (sides // 2) + (0.16 if odd else -0.16)
            else:
                a = rot + TAU * j / sides
            out.append(bm.verts.new(at + (u * math.cos(a) + v * math.sin(a)) * r))
        return out
    r0 = ring(Vector(base), radius * taper)
    r1 = ring(Vector(base) + d * body, radius)
    for j in range(sides):
        k = (j + 1) % sides
        bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    apex = bm.verts.new(Vector(base) + d * length
                        + (u * rng.uniform(-1, 1) + v * rng.uniform(-1, 1)) * (radius * apex_shift))
    for j in range(sides):
        bm.faces.new((r1[j], r1[(j + 1) % sides], apex))
    if log is not None:
        log.append(dict(base=Vector(base), d=d, u=u, v=v, rot=rot, body=body, radius=radius,
                        taper=taper, apex=apex.co.copy(), length=length))
    return apex


@asset('crystal_cluster', 'crystal', 320,
       notes='7 hexagonal crystals (3 with chamfered edges) on a rock base; flat facets.')
def crystal_cluster(rng):
    base = chiseled_rock('_base', (0.82, 0.68, 0.36), rng, cuts=4, sink=0.12, bevel=0.0,
                         decimate_to=60, top_cut=False)
    bm, log = bmesh.new(), []
    spec = [  # (azimuth, lean, length, radius, chamfer)
        (0.0, 0.08, 2.35, 0.24, True), (0.9, 0.42, 1.55, 0.19, True), (2.4, 0.5, 1.25, 0.17, True),
        (3.6, 0.36, 1.7, 0.18, False), (4.6, 0.62, 0.9, 0.13, False), (5.5, 0.55, 1.05, 0.14, False),
        (1.7, 0.75, 0.7, 0.11, False),
    ]
    a0 = rng.uniform(0, TAU)
    for az, lean, L, r, ch in spec:
        az += a0 + rng.uniform(-0.2, 0.2)
        d = Vector((math.sin(lean) * math.cos(az), math.sin(lean) * math.sin(az), math.cos(lean)))
        foot = Vector((math.cos(az), math.sin(az), 0.0)) * (0.12 + 0.3 * math.sin(lean)) + Vector((0, 0, 0.1))
        crystal(bm, foot, d, L * rng.uniform(0.92, 1.06), r, rng, sides=12 if ch else 6, chamfer=ch,
                log=log)
    xtal = C.mesh_object('_crystals', bm, 'Crystal', smooth=False)
    C.set_shade(xtal, C.gradient(0.0, 1.6, 0.62, 1.0))
    lod_base = C.duplicate(base, '_base_lod')
    ob = C.join([base, xtal], 'crystal_cluster')
    return ob, dict(collider=dict(type='cylinder', radius=0.8, height=2.4),
                    layout=dict(base=lod_base, crystals=log, shade=(0.0, 1.6)),
                    finalize=dict(weighted=True, ao=dict(distance=0.6, samples=64, floor=0.5)))


@asset('crystal_spire', 'crystal', 220,
       notes='One ~10.5 m chamfered crystal, a leaning companion and 4 small crystals on a rock base.')
def crystal_spire(rng):
    base = chiseled_rock('_base', (1.7, 1.5, 0.6), rng, cuts=4, sink=0.2, bevel=0.0,
                         decimate_to=40, top_cut=False)
    bm, log = bmesh.new(), []
    d = Vector((0.07, -0.04, 1.0)).normalized()
    crystal(bm, Vector((0, 0, -0.2)), d, 10.7, 1.05, rng, sides=12, chamfer=True, tip=0.2,
            apex_shift=0.2, taper=0.82, log=log)
    az = rng.uniform(0, TAU)  # a medium companion crystal leaning off the giant
    crystal(bm, Vector((math.cos(az), math.sin(az), 0.0)) * 0.75,
            Vector((math.cos(az) * 0.45, math.sin(az) * 0.45, 1.0)), 4.6, 0.48, rng, sides=6, tip=0.24,
            log=log)
    for k in range(4):
        az = k * TAU / 4 + rng.uniform(-0.4, 0.4)
        lean = rng.uniform(0.4, 0.75)
        dd = Vector((math.sin(lean) * math.cos(az), math.sin(lean) * math.sin(az), math.cos(lean)))
        foot = Vector((math.cos(az), math.sin(az), 0.0)) * rng.uniform(1.0, 1.35) + Vector((0, 0, 0.05))
        crystal(bm, foot, dd, rng.uniform(1.3, 2.4), rng.uniform(0.22, 0.32), rng, sides=6, log=log)
    xtal = C.mesh_object('_crystals', bm, 'Crystal', smooth=False)
    C.set_shade(xtal, C.gradient(0.0, 7.0, 0.62, 1.0))
    lod_base = C.duplicate(base, '_base_lod')
    ob = C.join([base, xtal], 'crystal_spire')
    return ob, dict(collider=dict(type='cylinder', radius=1.2, height=10.5),
                    layout=dict(base=lod_base, crystals=log, shade=(0.0, 7.0)),
                    finalize=dict(weighted=True, ao=dict(distance=1.2, samples=64, floor=0.5)))


@asset('shard', 'collectible', 90,
       notes='Floating resonance shard: faceted gem + tilted Glow orbit ring. Origin at its '
             'center (bob/spin it in code); sphere collider centered on the origin.')
def shard(rng):
    bm = bmesh.new()
    sides = 6
    rot = rng.uniform(0, TAU)
    ring_pts = []
    for j in range(sides):
        a = rot + TAU * j / sides
        r = 0.15 * rng.uniform(0.86, 1.1)
        z = 0.05 + rng.uniform(-0.035, 0.035)
        ring_pts.append(bm.verts.new(Vector((math.cos(a) * r, math.sin(a) * r, z))))
    upper = []
    for j, v in enumerate(ring_pts):
        a = rot + TAU * j / sides
        r = v.co.xy.length * rng.uniform(0.8, 0.9)
        upper.append(bm.verts.new(Vector((math.cos(a) * r, math.sin(a) * r, v.co.z + 0.16))))
    top = bm.verts.new(Vector((0.03, -0.01, 0.45)))
    bot = bm.verts.new(Vector((-0.015, 0.01, -0.4)))
    for j in range(sides):
        k = (j + 1) % sides
        bm.faces.new((ring_pts[j], ring_pts[k], upper[k], upper[j]))
        bm.faces.new((upper[j], upper[k], top))
        bm.faces.new((ring_pts[k], ring_pts[j], bot))
    gem = C.mesh_object('_gem', bm, 'Crystal', smooth=False)
    C.set_shade(gem, lambda co: C.lerp(0.75, 1.0, C.smoothstep(-0.4, 0.4, co.z)))
    # thin orbit ring: 11 segments, triangular section, tilted
    rb = bmesh.new()
    R, w, segs = 0.36, 0.022, 11
    secs = []
    for i in range(segs):
        a = TAU * i / segs
        radial = Vector((math.cos(a), math.sin(a), 0.0))
        c = radial * R
        sec = [rb.verts.new(c + radial * w), rb.verts.new(c - radial * (w * 0.5) + UP * (w * 0.9)),
               rb.verts.new(c - radial * (w * 0.5) - UP * (w * 0.9))]
        secs.append(sec)
    for i in range(segs):
        s0, s1 = secs[i], secs[(i + 1) % segs]
        for j in range(3):
            k = (j + 1) % 3
            rb.faces.new((s0[j], s1[j], s1[k], s0[k]))
    bmesh.ops.recalc_face_normals(rb, faces=rb.faces)
    ring = C.mesh_object('_ring', rb, 'Glow')
    C.transform(ring, Matrix.Rotation(math.radians(18), 4, 'X') @ Matrix.Rotation(math.radians(-8), 4, 'Y'))
    C.set_normals(ring, lambda co, n: n)
    ob = C.join([gem, ring], 'shard')
    return ob, dict(collider=dict(type='sphere', radius=0.45, height=0.9), centered=True,
                    finalize=dict(ao=None))


# ----------------------------------------------------------------------------
# Far LODs
# ----------------------------------------------------------------------------
#
# Hand-built distant versions of the big assets, exported next to them in flora.glb as
# '<name>_far'. Each far builder reuses the layout its near builder recorded (extras
# 'layout': mass centers, spines, outlines, RNG states, ...), so the silhouette lines up, and
# it uses the same material slots and the same shading recipe (normals, gradients, baked AO),
# so the average color matches. Budget: at most a quarter of the near model's triangles.

FAR = {}


def far(name):
    """Register the far-LOD builder of asset `name`: fn(layout, budget, near) -> (obj, extras)
    where obj is named f'{name}_far' and extras may hold 'finalize' options."""
    def deco(fn):
        FAR[name] = fn
        return fn
    return deco


def slot_bounds(ob, slots):
    """(min corner, max corner) of the vertices used by faces of the given slots."""
    me = ob.data
    idx = {i for i, m in enumerate(me.materials) if m is not None and m.name in slots}
    vs = {v for p in me.polygons if p.material_index in idx for v in p.vertices}
    cos = [me.vertices[i].co for i in vs]
    lo = Vector((min(c.x for c in cos), min(c.y for c in cos), min(c.z for c in cos)))
    hi = Vector((max(c.x for c in cos), max(c.y for c in cos), max(c.z for c in cos)))
    return lo, hi


def fit_bounds(ob, lo, hi, axes=(0, 1, 2)):
    """Scale/offset ob along the given axes so its bounding box becomes (lo, hi) there."""
    me = ob.data
    a = Vector((min(v.co.x for v in me.vertices), min(v.co.y for v in me.vertices),
                min(v.co.z for v in me.vertices)))
    b = Vector((max(v.co.x for v in me.vertices), max(v.co.y for v in me.vertices),
                max(v.co.z for v in me.vertices)))
    for v in me.vertices:
        v.co = Vector(tuple(lo[k] + (v.co[k] - a[k]) * (hi[k] - lo[k]) / max(1e-6, b[k] - a[k])
                            if k in axes else v.co[k] for k in range(3)))
    me.update()


@far('bush_round')
def bush_round_far(L, budget, near):
    # the near recipe at a quarter of the triangles: the same masses (same seed, so the same
    # lobes), each a low-poly closed blob, LeafAlt still its own highlight lobe
    objs = fit_masses(L['masses'], budget, L['seed'], min_tris=8)
    soften_masses(objs, L['masses'], L['center'], top=L['top'])
    ob = C.join(objs, 'bush_round_far')
    fit_bounds(ob, *slot_bounds(near, ('Leaf', 'LeafAlt')))  # decimation shrinks; keep the size
    return ob, dict(finalize=dict(ao=dict(distance=0.5, samples=64, floor=0.5, smooth=1)))


@far('tree_round')
def tree_round_far(L, budget, near):
    t = L['trunk']
    bm, _ = C.tube([t[0], t[1], t[3], t[4] + Vector((0.0, 0.0, 0.9))], [0.74, 0.46, 0.37, 0.33],
                   sides=5, cap_start=False, cap_end=False)
    wood = [C.mesh_object('_trunk', bm, 'Bark')]
    for a, b, c, r, _ in L['limbs'][:2]:  # the two big limbs of the fork; the third hides
        bm, _ = C.tube([a, b.lerp(c, 0.5)], [r * 1.1, r * 0.8], sides=3, cap_start=False,
                       cap_end=False)
        wood.append(C.mesh_object('_limb', bm, 'Bark'))
    probe = fit_masses(L['masses'], 10 ** 6, L['seed'], min_tris=8)  # wood hidden in the canopy
    C.remove_hidden_faces(wood, occluders=probe)
    for o in probe:
        C.delete(o)
    objs = fit_masses(L['masses'], budget, L['seed'], wood=wood, min_tris=8)
    soften_masses(objs, L['masses'], L['center'], top=L['top'])
    canopy = C.join(objs, '_canopy')
    fit_bounds(canopy, *slot_bounds(near, ('Leaf', 'LeafAlt')))
    for w in wood:
        C.set_shade(w, C.gradient(0.0, 4.0, 0.85, 1.0))
        C.set_ao_weight(w, 0.6)
    ob = C.join(wood + [canopy], 'tree_round_far')
    return ob, dict(finalize=dict(ao=dict(distance=1.8, samples=64, floor=0.55, smooth=1)))


@far('rock_boulder')
def rock_boulder_far(L, budget, near):
    # one closed single-slot rock: a collapse-decimated copy of the finished near model keeps
    # its silhouette best (rebuilding from a coarser blob moves the chisel facets around)
    ob = C.duplicate(near, 'rock_boulder_far')
    C.decimate(ob, target_tris=budget)
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=0.7, samples=64, floor=0.45)))


def simplify_poly(poly, n):
    """Drop the least significant vertices (Visvalingam) down to n."""
    pts = list(poly)
    while len(pts) > n:
        def tri(i):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))
        pts.pop(min(range(len(pts)), key=tri))
    return pts


def inside_poly(p, poly):
    """Point-in-polygon (even-odd)."""
    x, y, inside = p[0], p[1], False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i - 1], poly[i]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


@far('rock_slab')
def rock_slab_far(L, budget, near):
    # the same tilted plates as plain prisms with simplified outlines; each upper plate stands
    # on the plate below (no hidden bottom faces) and is kept inside its outline. When the
    # budget only allows two plates, the second one rises to the mean height of the top two.
    plates = L['plates']
    for counts in ((5, 4, 3), (5, 4, 0), (4, 4, 0)):
        parts, below, floor = [], None, None
        for k, ((poly, z0, z1, slot), n) in enumerate(zip(plates, counts)):
            if not n:
                continue
            if k == 1 and not counts[2]:
                z1 = (z1 + plates[2][2]) * 0.5
            pts = simplify_poly(poly, n)
            if below is not None:
                cx, cy = sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
                while not all(inside_poly(p, below) for p in pts):
                    pts = [(cx + (x - cx) * 0.95, cy + (y - cy) * 0.95) for x, y in pts]
            bm, _ = C.extrude_profile(pts, [(z0 if floor is None else floor, 1.0, 0.0), (z1, 1.0, 0.0)],
                                      bottom=False)
            parts.append(C.mesh_object(f'_plate{k}', bm, slot))
            below, floor = pts, z1
        for p in parts:
            C.transform(p, L['xform'])
            C.paint_faces(p, strata_paint())
        ob = C.join(parts, 'rock_slab_far')
        if C.tri_count(ob) <= budget:
            fit_bounds(ob, *slot_bounds(near, ('Rock', 'RockDark')), axes=(0, 1))
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=0.8, samples=64, floor=0.6)))


@far('rock_spire')
def rock_spire_far(L, budget, near):
    # the same column (same RNG state: same spine, noise, ledge sides and strata dip) with 4
    # sides and only the rings that carry the silhouette and the strata colors: soft waist
    # and ledge lip per stratum (RockDark between them) plus the last shelf
    import random
    prof = L['profile']
    shelf = [e for e in prof if e[2] == 'shelf'][-1:]
    keep = [e for e in prof if e[2] in ('foot', 'soft', 'lip')]
    top = max(v.co.z for v in near.data.vertices)
    for rings in (keep + shelf, keep):
        rng = random.Random()
        rng.setstate(L['state'])
        bm, kinds = organic_column(rings, 4, rng, tip=(*L['tip'], top), cap_bottom=False,
                                   height=prof[-1][0], **L['column'])
        dark = {i + 1 for i, kind in enumerate(kinds[:-1]) if kind == 'soft'}
        ob = C.mesh_object('_spire', bm, 'Rock')
        band = ob.data.attributes['band']
        C.paint_faces(ob, lambda p: 'RockDark' if band.data[p.index].value in dark else None)
        ob.data.attributes.remove(band)
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    ob = C.join([ob], 'rock_spire_far')
    return ob, dict(finalize=dict(ao=dict(distance=0.9, samples=64, floor=0.6, smooth=2)))


@far('tree_pine')
def tree_pine_far(L, budget, near):
    # the same six tiers as single star cones (scallop tips only, drooping like the near ones);
    # the lowest tiers keep their notches when the budget allows
    lean = L['lean']
    for notched in (2, 1, 0):
        bm, _ = C.tube([Vector((0, 0, -0.2)), Vector((0, 0, 2.4)) + lean * 0.2], [0.46, 0.27],
                       sides=4, cap_start=False, cap_end=False)
        trunk = C.mesh_object('_trunk', bm, 'Bark')
        tiers = []
        for k, (zb, zt, R, n, phase, c) in enumerate(L['tiers']):
            h, full = zt - zb, k < notched
            bm, rings = C.lathe([(0.0, zb + h * 0.3), (R, zb), (0.0, zt)], sides=n * 2 if full else n,
                                phase=phase, center=c,
                                radial=lambda i, j, a, full=full: 0.88 if full and j % 2 else 1.07)
            for j, v in enumerate(rings[0]):
                v.co.z += 0.05 * h if full and j % 2 else -0.24 * h
            tier = C.mesh_object(f'_tier{k}', bm, 'Leaf')
            C.set_normals(tier, tier_normals(c, zb + h * 0.22))
            tiers.append(tier)
        C.remove_hidden_faces(tiers + [trunk])
        ob = C.join([trunk] + tiers, 'tree_pine_far')
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(ao=dict(distance=1.5, samples=64, floor=0.5)))


def spike(bm, loc, nrm, size, sides=3):
    """Small pyramid (no base) standing on a surface, for glow spots and studs."""
    u, v = C.basis(nrm)
    ring = [bm.verts.new(loc + (u * math.cos(TAU * m / sides) + v * math.sin(TAU * m / sides)) * size - nrm * 0.01)
            for m in range(sides)]
    apex = bm.verts.new(loc + nrm * (size * 0.55))
    for m in range(sides):
        f = bm.faces.new((ring[m], ring[(m + 1) % sides], apex))
        f.normal_update()
        if f.normal.dot(nrm) < 0:
            f.normal_flip()


@far('tree_umbrella')
def tree_umbrella_far(L, budget, near):
    # stem (5 sides), a 10-sided cap with the same wobbling rim, half the glow spots (bigger,
    # same total glow area); the small skirt ring is dropped (LeafAlt stays on the cap)
    from mathutils.bvhtree import BVHTree
    P, top, R, wob = L['P'], L['top'], L['R'], L['wob']
    near_r = L['radii']

    def stem_r(t):
        x = t * (len(near_r) - 1)
        i = min(int(x), len(near_r) - 2)
        return C.lerp(near_r[i], near_r[i + 1], x - i)

    def wobble(a):
        return 0.3 * math.cos(3 * a + wob[0]) + 0.14 * math.cos(5 * a + wob[1])
    for spans, sides, every in ((3, 10, 2), (2, 10, 2), (2, 8, 2), (2, 8, 3)):
        ts = [i / spans for i in range(spans + 1)]
        bm, _ = C.tube([C.bezier(*P, t) for t in ts], [stem_r(t) * (1.15 if t == 0 else 1.0) for t in ts],
                       sides=5, cap_start=False, cap_end=False)
        stem = C.mesh_object('_stem', bm, 'Bark')
        C.set_shade(stem, C.gradient(0.0, 6.0, 0.88, 1.0))
        prof = [(0.0, 0.05), (R * 0.62, -0.18), (R * 0.97, -0.38), (R * 0.88, 0.36), (R * 0.4, 1.1),
                (0.0, 1.4)]
        bm, rings = C.lathe(prof, sides=sides, center=top)
        for i, ring in enumerate(rings):
            rf = prof[i + 1][0] / R
            for j, v in enumerate(ring):
                v.co.z += wobble(TAU * j / sides) * min(1.0, rf * 1.4)
        cap = C.mesh_object('_cap', bm, 'LeafAlt')
        fit_bounds(cap, *slot_bounds(near, ('LeafAlt',)), axes=(0, 1))
        shade_cap(cap, top, R)
        me = cap.data
        tree = BVHTree.FromPolygons([v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
        picked = L['spots'][::every]
        grow = math.sqrt(len(L['spots']) * 3.08 / (len(picked) * 1.93))  # same total glow area
        bm = new_bm()
        for loc, nrm, s in picked:
            hit = tree.ray_cast(Vector((loc.x, loc.y, loc.z - 2.0)), UP, 4.0)
            if hit[0] is not None:
                spike(bm, hit[0], -hit[1] if hit[1].z > 0 else hit[1], s * grow)
        glow = C.mesh_object('_spots', bm, 'Glow')
        C.set_normals(glow, lambda co, n: n)
        ob = C.join([stem, cap, glow], 'tree_umbrella_far')
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(ao=dict(distance=1.4, samples=64, floor=0.45)))


def frond_ribbon(bm, f, segs=3, fill=0.7, fold=0.55):
    """Far-LOD frond: the comb frond's envelope as a folded (V) ribbon along the same spine.
    Leaflets cover only part of the envelope, hence `fill` < 1. 4 * segs - 4 triangles."""
    _, left = yaw_dirs(f['yaw'])
    ctrl = frond_spine(f['base'], f['yaw'], f['length'], f['rise'], f['droop'])
    rows = []
    for i in range(segs + 1):
        t = i / segs
        p = C.bezier(*ctrl, t)
        if i in (0, segs):
            rows.append((bm.verts.new(p),) * 3)
            continue
        w = frond_width(f['width'], t) * fill
        rows.append((bm.verts.new(p + left * w - UP * (w * fold)), bm.verts.new(p),
                     bm.verts.new(p - left * w - UP * (w * fold))))
    facing = (yaw_dirs(f['yaw'])[0] * 0.6 + UP).normalized()
    for (l0, c0, r0), (l1, c1, r1) in zip(rows, rows[1:]):
        for quad in ((c0, c1, l1, l0), (c0, r0, r1, c1)):
            vs = []
            for v in quad:
                if v not in vs:
                    vs.append(v)
            if len(vs) >= 3:
                face = bm.faces.new(vs)
                face.normal_update()
                if face.normal.dot(facing) < 0.0:
                    face.normal_flip()


@far('tree_palm')
def tree_palm_far(L, budget, near):
    # trunk on the same curve, 9 folded ribbon fronds on the same spines; with budget to
    # spare an octahedral crown knob (coconuts dropped: Bark stays on the trunk)
    P = L['trunk']
    for sides, segs, knob in ((5, 4, True), (4, 4, True), (4, 4, False), (4, 3, True)):
        ts = (0.0, 0.33, 0.67, 1.0)
        bm, _ = C.tube([C.bezier(*P, t) for t in ts], [0.5, 0.36, 0.29, 0.22], sides=sides,
                       cap_start=False, cap_end=False)
        trunk = C.mesh_object('_trunk', bm, 'Bark')
        C.set_shade(trunk, C.gradient(0.0, 6.0, 0.9, 1.0))
        parts = [trunk]
        cc = L['crown']
        if knob:
            bm = bmesh.new()
            C.convex_hull([cc + Vector(d) for d in ((0.36, 0, 0), (-0.36, 0, 0), (0, 0.36, 0),
                                                    (0, -0.36, 0), (0, 0, 0.42), (0, 0, -0.42))], bm=bm)
            crown = C.mesh_object('_crown', bm, 'Bark')
            C.set_normals(crown, C.radial_normals(cc, 1.0))
            parts.append(crown)
        bm = new_bm()
        for f in L['fronds']:
            frond_ribbon(bm, f, segs, fill=0.55)
        fronds = C.mesh_object('_fronds', bm, 'Leaf')
        fit_bounds(fronds, *slot_bounds(near, ('Leaf',)), axes=(0, 1))
        C.set_normals(fronds, dome_normals(cc - Vector((0, 0, 1.2)), 0.35))
        ob = C.join(parts + [fronds], 'tree_palm_far')
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(ao=dict(distance=1.2, samples=48, floor=0.5)))


@far('cactus_alien')
def cactus_alien_far(L, budget, near):
    # smooth low-sided columns on the same paths (ribs average out at distance), Glow crowns
    # on the tip fans; the tiny areole studs are dropped (Glow stays on the crowns)
    (mp, mr), *arms = L['columns']
    for main_keep, arm_sides in (((0, 2, 4, 5), (4, 4)), ((0, 2, 4, 5), (4, 3)), ((0, 2, 5), (4, 3)),
                                 ((0, 2, 5), (3, 3))):
        parts = []
        cols = [([mp[i] for i in main_keep], [mr[i] for i in main_keep], 5)]
        cols += [([ap[0], ap[2], ap[3]], [ar[0], ar[2], ar[3]], s) for (ap, ar), s in zip(arms, arm_sides)]
        for k, (pts, radii, sides) in enumerate(cols):
            top = pts[-1] + (pts[-1] - pts[-2]).normalized() * (radii[-1] * 0.55)
            bm, _ = C.tube(pts, [r * 1.05 for r in radii], sides=sides, cap_start=False, end_tip=top)
            col = C.mesh_object(f'_col{k}', bm, 'Leaf')
            C.paint_faces(col, lambda p, top=top, r=radii[-1]: 'Glow' if (p.center - top).length < r * 0.85 else None)
            C.set_shade(col, C.gradient(0.0, L['H'] * 0.4, 0.75, 1.0))
            parts.append(col)
        C.remove_hidden_faces(parts)
        ob = C.join(parts, 'cactus_alien_far')
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(ao=dict(distance=0.45, samples=48, floor=0.5)))


def keep_indices(poly, n):
    """Indices of the n most significant outline vertices (Visvalingam), in order."""
    idx = list(range(len(poly)))
    while len(idx) > n:
        def tri(k):
            a, b, c = poly[idx[k - 1]], poly[idx[k]], poly[idx[(k + 1) % len(idx)]]
            return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))
        idx.pop(min(range(len(idx)), key=tri))
    return idx


@far('mesa_chunk')
def mesa_chunk_far(L, budget, near):
    # the same talus and strata with the outline thinned to its most significant vertices
    # (shared by every layer) and no chamfers
    for n in range(18, 8, -1):
        idx = keep_indices(L['base'], n)
        bm, _ = C.extrude_profile([L['talus'][i] for i in idx], [(-0.6, 1.0, 0.0), (3.8, 0.85, 0.0)],
                                  top=False, bottom=False)
        parts = [C.mesh_object('_talus', bm, 'Rock')]
        for k, (poly, z0, z1, slot) in enumerate(L['layers']):
            bm, _ = C.extrude_profile([poly[i] for i in idx], [(z0, 1.0, 0.0), (z1, 0.97, 0.0)],
                                      bottom=k > 0)
            parts.append(C.mesh_object(f'_stratum{k}', bm, slot))
        C.remove_hidden_faces(parts)
        for p in parts:
            C.paint_faces(p, strata_paint())
        ob = C.join(parts, 'mesa_chunk_far')
        if C.tri_count(ob) <= budget:
            fit_bounds(ob, *slot_bounds(near, ('Rock', 'RockDark')), axes=(0, 1))
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=5.0, samples=48, floor=0.8, smooth=1)))


@far('sandstone_arch')
def sandstone_arch_far(L, budget, near):
    # the same noisy sweep with 6-sided sections; on the legs the rings sit on the strata
    # boundaries so the thin RockDark bands stay crisp without extra cuts; low-poly talus
    import random
    A, B, base_z, off, bands = L['A'], L['B'], L['base_z'], L['off'], L['bands']

    def t_at(z):  # left-leg path parameter where the arch center line reaches height z
        return math.asin(C.clamp((z - base_z) / B, 0.0, 1.0)) / math.pi
    leg = [t_at(z) for lo, hi in bands[:2] for z in (lo, hi)]
    for top_ts, rock_tris in (((0.34, 0.45, 0.55, 0.66), 10), ((0.34, 0.45, 0.55, 0.66), 8),
                              ((0.36, 0.5, 0.64), 8)):
        ts = [0.0] + leg + list(top_ts) + [1.0 - t for t in reversed(leg)] + [1.0]
        dark_rings = {1, 3, len(ts) - 3, len(ts) - 5}  # ring i -> band between rings i, i + 1
        bm = bmesh.new()
        band = bm.faces.layers.int.new('band')
        rings = [arch_ring(bm, t, 6, A, B, base_z, off, phase=0.0) for t in ts]
        for i in range(len(rings) - 1):
            for j in range(6):
                k = (j + 1) % 6
                f = bm.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
                f[band] = int(i in dark_rings)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        arch = C.mesh_object('_arch', bm, 'Rock')
        flag = arch.data.attributes['band']
        hi_lo, hi_hi = bands[2]
        C.paint_faces(arch, lambda p: 'RockDark' if flag.data[p.index].value or hi_lo < p.center.z < hi_hi else None)
        arch.data.attributes.remove(flag)
        parts = [arch]
        rng = random.Random(7)
        for k, (x, y, R) in enumerate(L['talus']):
            bm = C.blob((x, y, R * 0.8 - 0.2), (R * 1.2, R, R * 0.8), subdivisions=1, lump=0.1,
                        seed=rng.uniform(0, 50))
            rock = C.mesh_object(f'_talus{k}', bm, 'Rock')
            C.decimate(rock, target_tris=rock_tris)
            parts.append(rock)
        C.remove_hidden_faces(parts)
        ob = C.join(parts, 'sandstone_arch_far')
        if C.tri_count(ob) <= budget:
            break
        C.delete(ob)
    else:
        raise RuntimeError(f'far LOD does not fit {budget} triangles')
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=2.5, samples=48, floor=0.55)))


CRYSTAL_COST = (18, 12, 9, 3)  # 6-sided prism, 4-sided prism, 3-sided prism, 3-sided spike


def crystal_lod(bm, c, level):
    """A logged crystal() rebuilt with fewer sides (level indexes CRYSTAL_COST)."""
    sides = (6, 4, 3, 3)[level]
    d, u, v, rot = c['d'], c['u'], c['v'], c['rot']

    def ring(at, r):
        return [bm.verts.new(at + (u * math.cos(rot + TAU * j / sides) + v * math.sin(rot + TAU * j / sides)) * r)
                for j in range(sides)]
    r0 = ring(c['base'], c['radius'] * c['taper'])
    apex = bm.verts.new(c['apex'])
    if level < 3:
        r1 = ring(c['base'] + d * c['body'], c['radius'])
        for j in range(sides):
            k = (j + 1) % sides
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    else:
        r1 = r0
    for j in range(sides):
        bm.faces.new((r1[j], r1[(j + 1) % sides], apex))


def crystals_far(name, L, budget, base_tris):
    """Far LOD for crystal formations: the near rock base collapse-decimated, the logged
    crystals rebuilt with fewer sides, the smallest ones simplified first until it fits."""
    log = L['crystals']
    small_first = sorted(range(len(log)), key=lambda i: log[i]['length'] * log[i]['radius'])
    base = L['base']
    C.decimate(base, target_tris=base_tris)
    levels = [0 if log[i]['radius'] > 0.6 else 1 for i in range(len(log))]
    while sum(CRYSTAL_COST[lv] for lv in levels) + C.tri_count(base) > budget:
        i = next((i for i in small_first if levels[i] < 3), None)
        if i is None:
            raise RuntimeError(f'{name}: crystals do not fit {budget}')
        # degrade round-robin from the smallest, never two steps ahead of a bigger crystal
        lagging = [j for j in small_first if levels[j] < levels[i]]
        i = lagging[0] if lagging else i
        levels[i] += 1
    bm = bmesh.new()
    for c, level in zip(log, levels):
        crystal_lod(bm, c, level)
    xtal = C.mesh_object('_crystals', bm, 'Crystal', smooth=False)
    C.set_shade(xtal, C.gradient(L['shade'][0], L['shade'][1], 0.62, 1.0))
    C.remove_hidden_faces([base, xtal])
    return C.join([base, xtal], name)


@far('crystal_cluster')
def crystal_cluster_far(L, budget, near):
    ob = crystals_far('crystal_cluster_far', L, budget, 12)
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=0.6, samples=64, floor=0.5)))


@far('crystal_spire')
def crystal_spire_far(L, budget, near):
    ob = crystals_far('crystal_spire_far', L, budget, 10)
    return ob, dict(finalize=dict(weighted=True, ao=dict(distance=1.2, samples=64, floor=0.6)))


# ----------------------------------------------------------------------------
# Build + export
# ----------------------------------------------------------------------------

def build(names=None, far_lods=True):
    C.reset_scene()
    for slot in ('Grass', 'Leaf', 'LeafAlt', 'Bark', 'Rock', 'RockDark', 'Petal', 'Crystal',
                 'Glow', 'Sand'):
        if slot == 'Grass' and GRASS_MODE == 'terrain':
            C.material(slot, double_sided=False)  # see grass notes: terrain-lit, front faces out
        else:
            C.material(slot)
    built = []
    for spec in ASSETS:
        if names and spec['name'] not in names:
            continue
        rng = C.rng_for(spec['name'])
        ob, extra = spec['fn'](rng)
        assert ob.name == spec['name'], (ob.name, spec['name'])
        info = C.finalize(ob, budget=spec['budget'], **extra.get('finalize', {}))
        line = (f"  {spec['name']:<18} {info['triangles']:>4}/{spec['budget']:<4} tris  "
                f"h {info['height']:.2f}  r {info['radius']:.2f}  {info['materials']}")
        far_ob = far_info = None
        if spec['name'] in FAR and far_lods:
            budget = info['triangles'] // 4
            far_ob, fx = FAR[spec['name']](extra.get('layout', {}), budget, ob)
            assert far_ob.name == spec['name'] + '_far', far_ob.name
            far_info = C.finalize(far_ob, budget=budget, **fx.get('finalize', {}))
            if set(far_info['materials']) != set(info['materials']):
                raise RuntimeError(f"{far_ob.name}: slots {far_info['materials']} != {info['materials']}")
            line += f"   far {far_info['triangles']:>3}/{budget:<3} h {far_info['height']:.2f}"
        built.append((spec, ob, info, extra, far_ob, far_info))
        print(line)
    return built


def manifest(built):
    out = []
    for spec, ob, info, extra, far_ob, far_info in built:
        centered = extra.get('centered', False)
        entry = {
            'name': spec['name'],
            'kind': spec['kind'],
            'triangles': info['triangles'],
            'height': round(info['height'] if not centered else info['size'][2], 3),
            'radius': round(extra.get('radius', info['radius']), 3),
            'collider': extra.get('collider'),
            'materials': info['materials'],
            'far': far_ob.name if far_ob else None,
            'farTriangles': far_info['triangles'] if far_info else None,
            'notes': spec['notes'],
        }
        for k in ('colliders',):
            if k in extra:
                entry[k] = extra[k]
        out.append(entry)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--only', help='comma-separated asset names')
    ap.add_argument('--out', default=os.path.join(C.MODELS_DIR, 'flora.raw.glb'))
    ap.add_argument('--no-manifest', action='store_true')
    ap.add_argument('--no-pack', action='store_true')
    ap.add_argument('--no-far', action='store_true', help='skip the <name>_far LOD nodes')
    ap.add_argument('--pack-args', default='-cc -kn -km -vpf -kv')
    args = ap.parse_args(argv)
    names = set(args.only.split(',')) if args.only else None
    built = build(names, far_lods=not args.no_far)
    objs = [o for b in built for o in (b[1], b[4]) if o is not None]
    C.export_glb(args.out, objs)
    packed = args.out.replace('.raw.glb', '.glb') if args.out.endswith('.raw.glb') \
        else args.out[:-4] + '.packed.glb'
    if not args.no_pack:
        C.gltfpack(args.out, packed, args.pack_args.split())
    if not args.no_manifest:
        path = os.path.join(os.path.dirname(packed), 'flora.json')
        C.write_json(path, manifest(built))
    total = sum(b[2]['triangles'] for b in built)
    far_total = sum(b[5]['triangles'] for b in built if b[5])
    print(f'built {len(built)} assets, {total} triangles (+{far_total} in far LODs) -> {args.out}'
          + ('' if args.no_pack else f' + {packed}'))


if __name__ == '__main__':
    main(sys.argv[1:] if '--' not in sys.argv else sys.argv[sys.argv.index('--') + 1:])
