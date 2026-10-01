"""
The Unfolding: stylized flora, rock and crystal prop library.

Builds every asset as its own top-level object (object name = glTF node name), origin at the
base center on the ground (z = 0), facing -Y, then exports

    public/models/flora.raw.glb   (Blender glTF export)
    public/models/flora.glb       (gltfpack -cc -kn -km -vpf: meshopt, names kept)
    public/models/flora.json      (manifest: triangles, height, footprint, collider, slots)

-vpf keeps positions as floats: every named node then holds its mesh directly, in meters,
with no hidden dequantization child transform, which is what instancing code wants (it costs
about 10 KB). Pass --pack-args "-cc -kn -km" for the fully quantized variant.

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


def comb_frond(bm, base, yaw, length, width, rise, droop, segs, fold=0.42, sweep=1.1, curl=0.0,
               base_taper=0.0):
    """Pinnate 'comb' frond: one swept-forward triangle leaflet per side per spine segment.

    Leaflets share the spine vertices, so the frond is continuous along the rachis while each
    leaflet keeps its own silhouette (fern / palm read). `sweep` > 1 pushes leaflet tips past
    the next spine vertex; `fold` droops them into a V. Front faces point up. 2 * segs tris.
    """
    out, left = yaw_dirs(yaw)
    p0 = base
    p1 = base + out * (length * 0.15) + UP * (length * rise)
    p2 = base + out * (length * 0.6) + UP * (length * (rise + 0.05 - curl))
    p3 = base + out * length + UP * (length * (rise * 0.4 - droop))
    spine = C.bezier_points(p0, p1, p2, p3, segs + 1)
    sv = [bm.verts.new(p) for p in spine]
    for i in range(segs):
        t = (i + 1) / segs
        w = width * math.sin(math.pi * min(1.0, t * 0.92 + 0.04)) ** 0.8 * C.smoothstep(0.0, base_taper, t)
        tip_c = spine[i].lerp(spine[i + 1], sweep)
        facing = (out * 0.6 + UP).normalized()
        for sgn in (1.0, -1.0):
            tip = bm.verts.new(tip_c + left * (w * sgn) - UP * (w * fold))
            f = bm.faces.new((sv[i], sv[i + 1], tip) if sgn > 0 else (sv[i + 1], sv[i], tip))
            f.normal_update()
            if f.normal.dot(facing) < 0.0:  # rising part of the spine: keep fronts facing out
                f.normal_flip()
    return spine


def leaf_clump(c, R, rng, density=1.0, lats=(84, 58, 30, 4, -24), tilt=0.14, leaf_len=0.74,
               leaf_w=0.5, squash=0.9, core_tris=30, alt_frac=0.25, rounded=False, slot='Leaf',
               alt_slot='LeafAlt', ring_scale=None, up_bias=0.45):
    """A foliage clump that reads as leaves: a small core blob shingled with broad leaf plates.

    Leaves sit in latitude rings (counts follow the ring circumference), all pointing down the
    clump like shingles with a slight outward tilt, so the silhouette shows leaf tips while the
    front faces stay consistently lit. Leaf normals are radial from the clump center, which
    makes each clump shade as one soft volume. `alt_frac` of the leaves (biased to the top)
    use the LeafAlt slot for a dappled two-tone. Returns [core, leaves, leaves_alt].
    """
    c = Vector(c)
    core_bm = C.blob(c, (R * 0.84, R * 0.84, R * 0.84 * squash), subdivisions=2, lump=0.0)
    core = C.mesh_object('_core', core_bm, slot)
    C.decimate(core, target_tris=core_tris)
    lift_n = UP * up_bias  # bend normals up: undersides catch sky light instead of going black
    C.set_normals(core, lambda co, n: ((co - c).normalized() + lift_n).normalized())
    layers = {slot: new_bm(), alt_slot: new_bm()}
    a_off = rng.uniform(0, TAU)
    for ri, lat_deg in enumerate(lats):
        clat = math.cos(math.radians(lat_deg))
        n = max(3, int(round(TAU * clat * density / (leaf_w * 1.25)))) if lat_deg < 80 else 3
        scale = ring_scale(lat_deg) if ring_scale else 1.0
        for k in range(n):
            az = a_off + (k + 0.5 * (ri % 2)) * TAU / n + rng.uniform(-0.15, 0.15)
            la = math.radians(lat_deg + rng.uniform(-6, 6))
            d = Vector((math.cos(la) * math.cos(az), math.cos(la) * math.sin(az), math.sin(la)))
            if lat_deg >= 80:  # crown leaves spread from the top in different directions
                t = Vector((math.cos(az), math.sin(az), -0.35)).normalized()
            else:
                t = Vector((math.sin(la) * math.cos(az), math.sin(la) * math.sin(az), -math.cos(la)))
            s = t.cross(d).normalized()
            L = R * leaf_len * scale * rng.uniform(0.88, 1.12)
            W = R * leaf_w * scale * rng.uniform(0.88, 1.12)
            B = c + Vector((d.x, d.y, d.z * squash)) * (R * 0.62)
            dirv = (t * math.cos(tilt) + d * math.sin(tilt)).normalized()
            lift = d * (R * 0.1)
            top_bias = 0.5 + max(0.0, d.z)
            bm = layers[alt_slot if rng.random() < alt_frac * top_bias else slot]
            if rounded:
                P1 = B + dirv * (L * 0.36) + lift
                P2 = B + dirv * (L * 0.76) + lift * 0.9
                T = B + dirv * L + lift * 0.5
                vs = [bm.verts.new(B), bm.verts.new(P1 - s * W * 0.95), bm.verts.new(P1 + s * W * 0.95),
                      bm.verts.new(P2 - s * W * 0.8), bm.verts.new(P2 + s * W * 0.8), bm.verts.new(T)]
                faces = [(vs[0], vs[2], vs[1]), (vs[1], vs[2], vs[4], vs[3]), (vs[3], vs[4], vs[5])]
            else:
                M = B + dirv * (L * 0.45) + lift
                vs = [bm.verts.new(B), bm.verts.new(M - s * W), bm.verts.new(M + s * W),
                      bm.verts.new(B + dirv * L + lift * 0.4)]
                faces = [(vs[0], vs[2], vs[1]), (vs[1], vs[2], vs[3])]
            made = [bm.faces.new(f) for f in faces]
            for f in made:
                f.normal_update()
            if made[0].normal.dot(d) < 0.0:  # front faces point out of the clump
                for f in made:
                    f.normal_flip()
    out = [core]
    for name, bm in layers.items():
        if len(bm.faces):
            ob = C.mesh_object('_leaves', bm, name)
            C.set_normals(ob, lambda co, n: ((co - c).normalized() + lift_n).normalized())
            out.append(ob)
        else:
            bm.free()
    return out


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


def fit_clumps(specs, budget, seed, wood=(), start=1.25, **kw):
    """Build leaf clumps, shrinking leaf density until clumps + wood fit `budget`.

    specs: [(center, radius, extra kwargs)]. Every attempt re-seeds identically, so the output
    depends only on the final density (deterministic). Hidden core faces (and wood faces
    inside cores) are removed before counting. Returns the clump part objects.
    """
    import random
    density = start
    for _ in range(40):
        rng = random.Random(seed)
        parts, cores = [], []
        for c, R, extra in specs:
            opts = dict(kw)
            opts.update(extra)
            clump = leaf_clump(c, R, rng, density=density, **opts)
            cores.append(clump[0])
            parts += clump
        C.remove_hidden_faces(cores)
        total = sum(C.tri_count(p) for p in parts) + sum(C.tri_count(w) for w in wood)
        if total <= budget:
            return parts, cores
        for p in parts:
            C.delete(p)
        density *= 0.97
    raise RuntimeError('fit_clumps: could not fit budget')


@asset('bush_round', 'bush', 260,
       notes='4 clumped foliage blobs: closed cores shingled with broad leaf plates, Leaf with '
             'dappled LeafAlt leaves (render DoubleSide). Walk-through, no collider.')
def bush_round(rng):
    specs = [((0.0, 0.02, 0.86), 0.68, dict(core_tris=34)),
             ((0.6, -0.32, 0.5), 0.48, dict(core_tris=22)),
             ((-0.57, -0.27, 0.52), 0.48, dict(core_tris=22)),
             ((-0.06, 0.54, 0.55), 0.45, dict(core_tris=20))]
    specs = [((c[0] + rng.uniform(-0.04, 0.04), c[1] + rng.uniform(-0.04, 0.04), c[2]), R, e)
             for c, R, e in specs]
    parts, _ = fit_clumps(specs, 260, rng.random(), lats=(84, 56, 26, -6), tilt=0.12,
                          leaf_len=0.72, leaf_w=0.52, squash=0.92, alt_frac=0.28)
    ob = C.join(parts, 'bush_round')
    C.transform(ob, Matrix.Translation((0, 0, -0.1)))  # bed the lowest leaves into the ground
    return ob, dict(collider=None,
                    finalize=dict(ao=dict(distance=0.5, samples=64, floor=0.56, smooth=1)))


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
       notes='Broadleaf tree: S-curved trunk with root flare and a fork, 5 leafy canopy clumps '
             '(Leaf with dappled LeafAlt, DoubleSide). Collider = trunk.')
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
    specs = [((0.1, 0.05, 6.75), 2.05, dict(squash=0.8, core_tris=40)),
             ((1.8, 0.5, 5.6), 1.55, dict(core_tris=30)),
             ((-1.65, -0.45, 5.35), 1.5, dict(core_tris=30)),
             ((0.35, 1.6, 5.8), 1.45, dict(core_tris=28)),
             ((-0.45, -1.6, 6.05), 1.42, dict(core_tris=28))]
    specs = [(tuple(x + rng.uniform(-0.1, 0.1) for x in c), R, e) for c, R, e in specs]
    for w in wood:
        C.triangulate(w)
    seed = rng.random()
    # wood hidden inside the clump cores does not count against the budget
    probe, cores = fit_clumps(specs, 10 ** 6, seed, start=1.0)
    C.remove_hidden_faces(wood, occluders=cores)
    for p in probe:
        C.delete(p)
    crown, cores = fit_clumps(specs, 700, seed, wood=wood, start=1.15, lats=(84, 58, 30, 2, -26),
                              tilt=0.13, leaf_len=0.7, leaf_w=0.5, squash=0.88, alt_frac=0.24)
    for w in wood:
        C.set_shade(w, C.gradient(0.0, 4.0, 0.85, 1.0))
    ob = C.join(wood + crown, 'tree_round')
    return ob, dict(collider=dict(type='cylinder', radius=0.5, height=4.0),
                    finalize=dict(ao=dict(distance=2.2, samples=64, floor=0.52, smooth=1)))


@asset('tree_pine', 'tree', 520,
       notes='Stylized conifer: 6 stacked drooping scalloped tiers (closed). Collider = trunk.')
def tree_pine(rng):
    lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0.0))
    bm, _ = C.tube([Vector((0, 0, -0.2)), Vector((0, 0, 1.8)) + lean * 0.15,
                    Vector((0, 0, 6.5)) + lean * 0.6],
                   [0.42, 0.28, 0.12], sides=6, cap_start=False, end_tip=Vector((0, 0, 8.0)) + lean,
                   radial=flare_radial(0.5, 3, rng.uniform(0, TAU)))
    trunk = C.mesh_object('_trunk', bm, 'Bark')
    tiers = []
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
        cz = zb + h * 0.22

        def nf(co, nn, cz=cz, c=c):
            d = co - Vector((c.x, c.y, cz))
            return (Vector((d.x, d.y, d.z * 1.4)).normalized() + UP * 0.55).normalized()
        C.set_normals(tier, nf)
        tiers.append(tier)
    C.remove_hidden_faces(tiers + [trunk])
    ob = C.join([trunk] + tiers, 'tree_pine')
    return ob, dict(collider=dict(type='cylinder', radius=0.45, height=3.0),
                    finalize=dict(ao=dict(distance=1.5, samples=64, floor=0.5)))


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
    cc = top + Vector((0, 0, -0.6))
    C.set_normals(cap, lambda co, n: n.lerp((co - cc).normalized(), 0.5))
    C.set_shade(cap, lambda co: (C.lerp(0.8, 1.0, 1.0 - C.smoothstep(0.3 * R, R, math.hypot(co.x - top.x, co.y - top.y)))
                                 if co.z > top.z + 0.1 else 0.9))
    parts.append(cap)
    # bioluminescent spots on the underside, in two staggered rings
    from mathutils.bvhtree import BVHTree
    me = cap.data
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
    spots = new_bm()
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
    for k in range(3):
        a = rng.uniform(0, TAU) if k == 0 else a + TAU / 3 + rng.uniform(-0.3, 0.3)
        nc = crown_c + polar(0.33, a, -0.3)
        C.blob(nc, (0.17, 0.17, 0.19), subdivisions=1, lump=0.0, bm=nuts)
    coconuts = C.mesh_object('_nuts', nuts, 'Bark')
    C.set_normals(coconuts, lambda co, n: n)
    parts.append(coconuts)
    bm = new_bm()
    a0 = rng.uniform(0, TAU)
    for k in range(9):
        yaw = a0 + k * TAU / 9 + rng.uniform(-0.15, 0.15)
        young = k in (0, 5)
        comb_frond(bm, crown_c + polar(0.15, yaw, 0.22), yaw,
                   rng.uniform(2.9, 3.5) * (0.82 if young else 1.0), rng.uniform(0.62, 0.7),
                   rise=0.6 if young else rng.uniform(0.3, 0.44),
                   droop=0.25 if young else rng.uniform(0.55, 0.85), segs=14, fold=0.55, sweep=1.25)
    fronds = C.mesh_object('_fronds', bm, 'Leaf')
    C.set_normals(fronds, dome_normals(crown_c - Vector((0, 0, 1.2)), 0.35))
    parts.append(fronds)
    ob = C.join(parts, 'tree_palm')
    return ob, dict(collider=dict(type='cylinder', radius=0.45, height=5.0),
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
    parts = []
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
                    finalize=dict(weighted=True, ao=dict(distance=0.8, samples=64, floor=0.5)))


@asset('rock_spire', 'rock', 260,
       notes='Leaning hoodoo spire: hard Rock layers over recessed RockDark bands, '
             'chiselled cap.')
def rock_spire(rng):
    parts = []
    base = C.outline(6, 1.1, 0.92, rng, jitter=0.1, angle_jitter=0.45)
    lean = Vector((0.85, -0.3, 0.0))
    spec = [  # (z0, z1, scale, hard)
        (-0.3, 1.5, 1.0, True), (1.42, 1.85, 0.86, False), (1.78, 3.0, 0.86, True),
        (2.92, 3.3, 0.74, False), (3.22, 4.4, 0.72, True), (4.32, 4.62, 0.6, False),
        (4.55, 5.5, 0.58, True),
    ]
    for k, (z0, z1, s, hard) in enumerate(spec):
        off = lean * (((z0 + z1) * 0.5) / 6.0) ** 1.4
        rot = rng.uniform(-0.3, 0.3)
        poly = []
        for x, y in base:
            x, y = x * s * rng.uniform(0.9, 1.1), y * s * rng.uniform(0.9, 1.1)
            poly.append((x * math.cos(rot) - y * math.sin(rot) + off.x, x * math.sin(rot) + y * math.cos(rot) + off.y))
        if hard:
            ch = 0.06 + 0.04 * s
            levels = [(z0, 1.0, 0.0), (z1 - ch, 0.92, 0.0), (z1, 0.92, ch)]
        else:
            levels = [(z0, 1.0, 0.0), (z1, 1.0, 0.0)]
        # caps that can never be seen (buried, or embedded in the layer below) are omitted:
        # a big hidden cap would otherwise dominate the weighted normals of the walls
        bm, _ = C.extrude_profile(poly, levels, bottom=k > 0)
        parts.append(C.mesh_object(f'_stratum{k}', bm, 'Rock' if hard else 'RockDark'))
    off = lean * (5.85 / 6.0) ** 1.4
    cap_poly = [(x * 0.42 + off.x, y * 0.42 + off.y) for x, y in base]
    bm, rings = C.extrude_profile(cap_poly, [(5.4, 1.0, 0.0), (5.8, 0.75, 0.0)], top=False)
    apex = bm.verts.new(Vector((off.x + 0.1, off.y - 0.04, 6.2)))
    ring = rings[-1]
    for j in range(len(ring)):
        bm.faces.new((ring[j], ring[(j + 1) % len(ring)], apex))
    parts.append(C.mesh_object('_cap', bm, 'Rock'))
    C.remove_hidden_faces(parts)
    for p in parts:
        C.paint_faces(p, strata_paint())
    ob = C.join(parts, 'rock_spire')
    return ob, dict(collider=dict(type='cylinder', radius=1.0, height=6.0),
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
    for k, (z0, z1, s, slot) in enumerate(strata):
        poly = [(x * s * rng.uniform(0.97, 1.03), y * s * rng.uniform(0.97, 1.03)) for x, y in base]
        mid = (z0 + z1) * 0.5
        bm, _ = C.extrude_profile(poly, [(z0, 1.0, 0.0), (mid, 0.99, 0.0), (z1 - 0.6, 0.97, 0.0),
                                         (z1, 0.97, 0.6)], bottom=k > 0)
        parts.append(C.mesh_object(f'_stratum{k}', bm, slot))
    C.remove_hidden_faces(parts)
    for p in parts:
        C.paint_faces(p, strata_paint())
    ob = C.join(parts, 'mesa_chunk')
    return ob, dict(collider=dict(type='cylinder', radius=15.0, height=24.6),
                    finalize=dict(weighted=True, ao=dict(distance=5.0, samples=48, floor=0.62, smooth=2)))


@asset('sandstone_arch', 'landform', 800,
       notes='Natural arch spanning X, opening faces -Y; thin RockDark strata, talus boulders. '
             'collider is null so the opening stays walkable: use `colliders` (two leg cylinders, '
             'offset in three.js space [x, y, z]).')
def sandstone_arch(rng):
    N, sides = 22, 8
    A, B, base_z = 5.2, 12.0, -1.6
    bm = bmesh.new()
    rings = []
    off = (rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50))
    for i in range(N):
        t = i / (N - 1)
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
            a = TAU * j / sides + math.pi / sides
            ca, sa = math.cos(a), math.sin(a)
            k = 1.0 / max(abs(ca), abs(sa)) ** 0.4  # rounded-rectangle section
            p = c + nrm * (ca * th * 0.5 * k) + Vector((0, 1, 0)) * (sa * dp * 0.5 * k)
            p += Vector((C.noise3(p, 0.2, off), C.noise3(p, 0.2, (off[1], off[2], off[0])),
                         0.4 * C.noise3(p, 0.2, (off[2], off[0], off[1])))) * 0.45
            ring.append(bm.verts.new(p))
        rings.append(ring)
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
    for k, (x, y, R) in enumerate(((-7.6, -1.6, 1.0), (7.4, 2.0, 1.15), (-5.0, 3.0, 0.7))):
        rock = chiseled_rock(f'_talus{k}', (R * 1.2, R, R * 0.8), rng, cuts=4, sink=0.2,
                             bevel=0.0, subdivisions=2, center=(x, y), decimate_to=30)
        parts.append(rock)
    C.remove_hidden_faces(parts)
    ob = C.join(parts, 'sandstone_arch')
    legs = [dict(type='cylinder', radius=2.6, height=8.0, offset=[-5.0, 0.0, 0.0]),
            dict(type='cylinder', radius=2.6, height=8.0, offset=[5.0, 0.0, 0.0])]
    return ob, dict(collider=None, colliders=legs,
                    finalize=dict(weighted=True, ao=dict(distance=2.5, samples=48, floor=0.55)))


# ----------------------------------------------------------------------------
# Crystals
# ----------------------------------------------------------------------------

def crystal(bm, base, direction, length, radius, rng, sides=6, tip=0.26, chamfer=False,
            apex_shift=0.25, taper=0.9):
    """Faceted crystal: prism body from `base` (embedded, open) with a pyramid tip.

    chamfer=True doubles the side count with narrow edge facets that catch light (a bevel).
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
    return apex


@asset('crystal_cluster', 'crystal', 320,
       notes='7 hexagonal crystals (3 with chamfered edges) on a rock base; flat facets.')
def crystal_cluster(rng):
    base = chiseled_rock('_base', (0.82, 0.68, 0.36), rng, cuts=4, sink=0.12, bevel=0.0,
                         decimate_to=60, top_cut=False)
    bm = bmesh.new()
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
        crystal(bm, foot, d, L * rng.uniform(0.92, 1.06), r, rng, sides=12 if ch else 6, chamfer=ch)
    xtal = C.mesh_object('_crystals', bm, 'Crystal', smooth=False)
    C.set_shade(xtal, C.gradient(0.0, 1.6, 0.62, 1.0))
    ob = C.join([base, xtal], 'crystal_cluster')
    return ob, dict(collider=dict(type='cylinder', radius=0.8, height=2.4),
                    finalize=dict(weighted=True, ao=dict(distance=0.6, samples=64, floor=0.5)))


@asset('crystal_spire', 'crystal', 220,
       notes='One ~10.5 m chamfered crystal, a leaning companion and 4 small crystals on a rock base.')
def crystal_spire(rng):
    base = chiseled_rock('_base', (1.7, 1.5, 0.6), rng, cuts=4, sink=0.2, bevel=0.0,
                         decimate_to=40, top_cut=False)
    bm = bmesh.new()
    d = Vector((0.07, -0.04, 1.0)).normalized()
    crystal(bm, Vector((0, 0, -0.2)), d, 10.7, 1.05, rng, sides=12, chamfer=True, tip=0.2,
            apex_shift=0.2, taper=0.82)
    az = rng.uniform(0, TAU)  # a medium companion crystal leaning off the giant
    crystal(bm, Vector((math.cos(az), math.sin(az), 0.0)) * 0.75, Vector((math.cos(az) * 0.45, math.sin(az) * 0.45, 1.0)),
            4.6, 0.48, rng, sides=6, tip=0.24)
    for k in range(4):
        az = k * TAU / 4 + rng.uniform(-0.4, 0.4)
        lean = rng.uniform(0.4, 0.75)
        dd = Vector((math.sin(lean) * math.cos(az), math.sin(lean) * math.sin(az), math.cos(lean)))
        foot = Vector((math.cos(az), math.sin(az), 0.0)) * rng.uniform(1.0, 1.35) + Vector((0, 0, 0.05))
        crystal(bm, foot, dd, rng.uniform(1.3, 2.4), rng.uniform(0.22, 0.32), rng, sides=6)
    xtal = C.mesh_object('_crystals', bm, 'Crystal', smooth=False)
    C.set_shade(xtal, C.gradient(0.0, 7.0, 0.62, 1.0))
    ob = C.join([base, xtal], 'crystal_spire')
    return ob, dict(collider=dict(type='cylinder', radius=1.2, height=10.5),
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
# Build + export
# ----------------------------------------------------------------------------

def build(names=None):
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
        built.append((spec, ob, info, extra))
        print(f"  {spec['name']:<18} {info['triangles']:>4}/{spec['budget']:<4} tris  "
              f"h {info['height']:.2f}  r {info['radius']:.2f}  {info['materials']}")
    return built


def manifest(built):
    out = []
    for spec, ob, info, extra in built:
        centered = extra.get('centered', False)
        entry = {
            'name': spec['name'],
            'kind': spec['kind'],
            'triangles': info['triangles'],
            'height': round(info['height'] if not centered else info['size'][2], 3),
            'radius': round(extra.get('radius', info['radius']), 3),
            'collider': extra.get('collider'),
            'materials': info['materials'],
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
    ap.add_argument('--pack-args', default='-cc -kn -km -vpf')
    args = ap.parse_args(argv)
    names = set(args.only.split(',')) if args.only else None
    built = build(names)
    objs = [ob for _, ob, _, _ in built]
    C.export_glb(args.out, objs)
    packed = args.out.replace('.raw.glb', '.glb') if args.out.endswith('.raw.glb') \
        else args.out[:-4] + '.packed.glb'
    if not args.no_pack:
        C.gltfpack(args.out, packed, args.pack_args.split())
    if not args.no_manifest:
        path = os.path.join(os.path.dirname(packed), 'flora.json')
        C.write_json(path, manifest(built))
    total = sum(i['triangles'] for _, _, i, _ in built)
    print(f'built {len(built)} assets, {total} triangles -> {args.out}'
          + ('' if args.no_pack else f' + {packed}'))


if __name__ == '__main__':
    main(sys.argv[1:] if '--' not in sys.argv else sys.argv[sys.argv.index('--') + 1:])
