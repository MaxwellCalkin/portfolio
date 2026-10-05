"""Aster, the player's personal survey ship for The Unfolding.

Run headless (Blender 5 as a Python module):
    /home/claude/blender/.venv/bin/python art/blender/ship.py

Builds the whole ship procedurally, animates the landing gear, exports public/models/ship.raw.glb and
optimizes it with gltfpack (-cc -kn -km -ke) into public/models/ship.glb. Deterministic: rerun after
tweaking any parameter. Standalone (does not need art/blender/common.py).

Conventions (art/STYLE.md): meters, +Z up, nose toward -Y (glTF +Z forward), origin on the ground,
midway between the nose pad and the main pads with the gear deployed. Material slot names are the
contract: Hull, HullDark, Accent, Glass, Glow, Metal. "_L" is the pilot's left, +X (glTF +X).

Design: ~13.2 m long, ~11.2 m span, ~3.2 m tall with gear down. Ogive nose with a slight droop, big
forward bubble canopy, lifting-body fuselage that widens to swallow the inner halves of two big engines,
cranked swept wings with canted winglets, navy dorsal spine and coral fin. Livery: navy wing leading /
trailing edges, coral nose chevrons and engine stripes, the site's triangle emblem on the left wing,
"07" on the right wing and on both nose flanks.

Nodes (all under the root empty "Ship"):
  meshes   Fuselage, Canopy, CanopyFrame, Spine, Fin, Antenna, Wing_L/R, Winglet_L/R, Nacelle_L/R,
           Gun_L/R, EngineStripes, GearBay_Nose/L/R, Door_Nose_L/R, Door_L_In/Out, Door_R_In/Out
  gear     Gear_Nose, Gear_L, Gear_R (hinge pivots) > *_Piston (telescopes) > *_Foot (stays level)
  empties  Engine_L/R (nozzle exit centre, local -Y in Blender = glTF +Z = exhaust direction),
           Muzzle_L/R (gun tips, glTF +Z forward), Cockpit (pilot eye), Boarding (ground, left side)
Animation "GearDeploy": 1.0 s (frames 0..30 @ 30 fps). 0 = stowed, doors shut; 1.0 s = deployed. Doors open
over 0-0.3 s, legs swing down 0.17-0.83 s with the feet kept level, struts extend 0.63-1.0 s. The exported
static pose is the deployed (last) frame.
Finishing: modifiers are baked, grayscale AO goes to COLOR_0 (hull/doors baked stowed, gear/bays baked
deployed), and a ray-parity check reports any stowed gear vertex outside the hull.
"""
import bpy
import bmesh
import math
import os
import shutil
import subprocess
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_RAW = os.path.join(ROOT, 'public', 'models', 'ship.raw.glb')
OUT_GLB = os.path.join(ROOT, 'public', 'models', 'ship.glb')
GLTFPACK = os.environ.get('GLTFPACK', '/tmp/claude-0/tools/node_modules/.bin/gltfpack')
FPS, F_END = 30, 30          # GearDeploy = frames 0..30 at 30 fps = 1.0 s
TRI_BUDGET = 12000

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene
COLL = SCENE.collection

# =============================================================== materials
PALETTE = {  # name: (sRGB hex, roughness, metallic, emission strength)
    'Hull':     ('#e9e4d5', 0.42, 0.0, 0.0),
    'HullDark': ('#1a2433', 0.50, 0.12, 0.0),
    'Accent':   ('#f0744e', 0.40, 0.0, 0.0),
    'Glass':    ('#0f2f36', 0.10, 0.0, 0.0),
    'Glow':     ('#8cf0d1', 0.30, 0.0, 1.6),
    'Metal':    ('#5d6b75', 0.45, 0.3, 0.0),
}
MAT = {}


def srgb_to_linear(hex_):
    h = hex_.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92)
    return tuple(out)


def make_materials():
    for name, (hex_, rough, metal, emit) in PALETTE.items():
        m = bpy.data.materials.new(name)
        if m.node_tree is None:
            m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        col = srgb_to_linear(hex_) + (1.0,)
        bsdf.inputs['Base Color'].default_value = col
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
        if emit:
            bsdf.inputs['Emission Color'].default_value = col
            bsdf.inputs['Emission Strength'].default_value = emit
            # dim base so lit diffuse doesn't wash the emissive hue out to white
            bsdf.inputs['Base Color'].default_value = tuple(c * 0.25 for c in col[:3]) + (1.0,)
        m.diffuse_color = col
        MAT[name] = m


# =============================================================== math helpers
def pchip(xs, ys):
    """Monotone cubic interpolation through (xs, ys): smooth, no overshoot."""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = 0
        while x > xs[i + 1]:
            i += 1
        t = (x - xs[i]) / h[i]
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
                + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])
    return f


def table(keys):
    """keys: rows of (x, v1, v2, ...) -> function x -> (v1, v2, ...)"""
    xs = [k[0] for k in keys]
    fs = [pchip(xs, [k[c] for k in keys]) for c in range(1, len(keys[0]))]
    return lambda x: tuple(f(x) for f in fs)


def lerp(a, b, t):
    return a + (b - a) * t


def frame_for(axis):
    """Two unit vectors perpendicular to axis."""
    axis = Vector(axis).normalized()
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u).normalized()
    return u, v


# =============================================================== mesh building
class Parts:
    """Accumulates primitive pieces (verts, faces, material per face) into one mesh."""

    def __init__(self):
        self.v, self.f, self.m = [], [], []

    def add(self, verts, faces, mat):
        o = len(self.v)
        self.v += [tuple(p) for p in verts]
        self.f += [tuple(i + o for i in f) for f in faces]
        self.m += [mat] * len(faces) if isinstance(mat, str) else list(mat)
        return self

    def build(self, name, **kw):
        return build(name, self.v, self.f, self.m, **kw)


def newell(points):
    n = Vector((0, 0, 0))
    for k in range(len(points)):
        a, b = points[k], points[(k + 1) % len(points)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


def oriented(face, verts, want):
    n = newell([Vector(verts[i]) for i in face])
    return face if n.dot(want) >= 0 else tuple(reversed(face))


def build(name, verts, faces, mats, parent=None, smooth=True, sharp=35, bevel=None, merge=1e-5, origin=None, recalc=True):
    """Create a mesh object. mats: one material name or a list per face.
    bevel: (width, segments[, angle_deg]) adds a Bevel modifier (applied on export)."""
    names = [mats] * len(faces) if isinstance(mats, str) else list(mats)
    slots = list(dict.fromkeys(names))
    bm = bmesh.new()
    ov = Vector(origin) if origin else Vector((0, 0, 0))
    bv = [bm.verts.new(Vector(p) - ov) for p in verts]
    for f, n in zip(faces, names):
        vs = []
        for i in f:
            if not vs or bv[i] is not vs[-1]:
                vs.append(bv[i])
        if len(vs) > 2 and vs[0] is vs[-1]:
            vs.pop()
        if len(set(vs)) < 3:
            continue
        try:
            face = bm.faces.new(vs)
        except ValueError:
            continue
        face.material_index = slots.index(n)
        face.smooth = smooth
    if merge:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for n in slots:
        me.materials.append(MAT[n])
    if smooth and sharp is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp))
    obj = bpy.data.objects.new(name, me)
    COLL.objects.link(obj)
    obj.location = ov
    if parent is not None:
        obj.parent = parent
    if bevel:
        add_bevel(obj, *bevel)
    return obj


def add_bevel(obj, width, segments=2, angle=35):
    m = obj.modifiers.new('Bevel', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    m.profile = 0.5
    m.harden_normals = True
    m.use_clamp_overlap = True
    return m


def empty(name, loc, parent, rot=(0, 0, 0), size=0.4):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = size
    COLL.objects.link(e)
    e.location = loc
    e.rotation_euler = rot
    e.parent = parent
    return e


def loft(rings, cap0=True, cap1=True, mat_fn=None, cap_mats=('Metal', 'Metal')):
    """Connect equal-length closed rings with quads. mat_fn(ring_index, seg_index, quad_points) -> material."""
    n = len(rings[0])
    verts = [p for r in rings for p in r]
    faces, mats = [], []
    for j in range(len(rings) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            c, d = (j + 1) * n + (i + 1) % n, (j + 1) * n + i
            faces.append((a, b, c, d))
            mats.append(mat_fn(j, i, [verts[a], verts[b], verts[c], verts[d]]) if mat_fn else 'Hull')
    if cap0:
        faces.append(tuple(range(n))[::-1])
        mats.append(cap_mats[0])
    if cap1:
        k = (len(rings) - 1) * n
        faces.append(tuple(range(k, k + n)))
        mats.append(cap_mats[1])
    return verts, faces, mats


def cylinder(p0, p1, r0, r1=None, n=12, caps=True):
    r1 = r0 if r1 is None else r1
    p0, p1 = Vector(p0), Vector(p1)
    u, v = frame_for(p1 - p0)
    rings = []
    for p, r in ((p0, r0), (p1, r1)):
        rings.append([p + (u * math.cos(2 * math.pi * k / n) + v * math.sin(2 * math.pi * k / n)) * r for k in range(n)])
    verts, faces, _ = loft(rings, caps, caps)
    return verts, faces


def tube(points, radii, n=12, caps=True):
    """Lofted round tube through a polyline of centers (axis-aligned frames from the first segment)."""
    pts = [Vector(p) for p in points]
    u, v = frame_for(pts[-1] - pts[0])
    rings = [[p + (u * math.cos(2 * math.pi * k / n) + v * math.sin(2 * math.pi * k / n)) * r for k in range(n)]
             for p, r in zip(pts, radii)]
    verts, faces, _ = loft(rings, caps, caps)
    return verts, faces


def sphere(c, r, nu=10, nv=6, scale=(1, 1, 1)):
    c = Vector(c)
    verts = [c + Vector((0, 0, -r * scale[2]))]
    for j in range(1, nv):
        th = -math.pi / 2 + math.pi * j / nv
        for i in range(nu):
            ph = 2 * math.pi * i / nu
            verts.append(c + Vector((r * scale[0] * math.cos(th) * math.cos(ph), r * scale[1] * math.cos(th) * math.sin(ph), r * scale[2] * math.sin(th))))
    verts.append(c + Vector((0, 0, r * scale[2])))
    faces = []
    for i in range(nu):
        faces.append((0, 1 + (i + 1) % nu, 1 + i))
    for j in range(nv - 2):
        for i in range(nu):
            a = 1 + j * nu + i
            b = 1 + j * nu + (i + 1) % nu
            faces.append((a, b, b + nu, a + nu))
    top = len(verts) - 1
    base = 1 + (nv - 2) * nu
    for i in range(nu):
        faces.append((base + i, base + (i + 1) % nu, top))
    return verts, faces


def box(c, size, rot_z=0.0):
    c = Vector(c)
    sx, sy, sz = (s / 2 for s in size)
    cz, sz_ = math.cos(rot_z), math.sin(rot_z)
    verts = []
    for z in (-sz, sz):
        for (x, y) in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
            verts.append(c + Vector((x * cz - y * sz_, x * sz_ + y * cz, z)))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def se_ring(cx, cy, cz, a, b, e, n, rake=0.0):
    """Superellipse ring in the XZ plane at y=cy (e=2 ellipse, larger = squarer). rake shifts y by z offset."""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        x = cx + a * math.copysign(abs(c) ** (2 / e), c)
        z = cz + b * math.copysign(abs(s) ** (2 / e), s)
        pts.append((x, cy - (z - cz) * rake, z))
    return pts


# =============================================================== draping (decals, panels, doors)
class Surf:
    """Ray-cast target built from the base meshes of objects (world space)."""

    def __init__(self, objs):
        bpy.context.view_layer.update()
        verts, polys = [], []
        for o in objs:
            mw = o.matrix_world
            off = len(verts)
            verts.extend(mw @ v.co for v in o.data.vertices)
            polys.extend([off + i for i in p.vertices] for p in o.data.polygons)
        self.bvh = BVHTree.FromPolygons(verts, polys)

    def hit(self, a, b, mode='down'):
        if mode == 'down':
            o, d = Vector((a, b, 30.0)), Vector((0, 0, -1))
        elif mode == 'up':
            o, d = Vector((a, b, -30.0)), Vector((0, 0, 1))
        elif mode == '+x':   # ray toward -X, hitting the +X side; (a, b) = (y, z)
            o, d = Vector((30.0, a, b)), Vector((-1, 0, 0))
        else:                # '-x'
            o, d = Vector((-30.0, a, b)), Vector((1, 0, 0))
        loc, nor, _, _ = self.bvh.ray_cast(o, d)
        if loc is None:
            raise RuntimeError(f'drape ray missed at {a:.3f}, {b:.3f} ({mode})')
        if nor.dot(d) > 0:
            nor = -nor
        return loc, nor


def drape_solid(surf, grid, off_top=0.012, off_bot=-0.02, mode='down', wrap=False, bottom=False):
    """grid[i][j]: 2D points (rows along the shape, columns across). Builds a thin shell hugging the surface:
    the top skin plus walls dropping to off_bot (inside the hull). Faces are explicitly oriented outward, so
    build these with recalc=False. bottom=True also closes the underside (for parts that move, e.g. doors)."""
    rows, cols = len(grid), len(grid[0])
    hits = [[surf.hit(a, b, mode) for (a, b) in row] for row in grid]
    verts, it, ib = [], [], []
    for row in hits:
        it.append([len(verts) + j for j in range(cols)])
        verts += [loc + nor * off_top for loc, nor in row]
    for row in hits:
        ib.append([len(verts) + j for j in range(cols)])
        verts += [loc + nor * off_bot for loc, nor in row]
    V = [Vector(v) for v in verts]
    faces = []
    R = rows if wrap else rows - 1
    for i in range(R):
        i2 = (i + 1) % rows
        for j in range(cols - 1):
            nrm = hits[i][j][1] + hits[i2][j + 1][1]
            faces.append(oriented((it[i][j], it[i2][j], it[i2][j + 1], it[i][j + 1]), V, nrm))
            if bottom:
                faces.append(oriented((ib[i][j], ib[i2][j], ib[i2][j + 1], ib[i][j + 1]), V, -nrm))
        if cols > 1:
            out0 = V[it[i][0]] - V[it[i][1]]
            out1 = V[it[i][-1]] - V[it[i][-2]]
            faces.append(oriented((it[i][0], ib[i][0], ib[i2][0], it[i2][0]), V, out0))
            faces.append(oriented((it[i2][-1], ib[i2][-1], ib[i][-1], it[i][-1]), V, out1))
    if not wrap:
        for i, i_in in ((0, 1), (rows - 1, rows - 2)):
            for j in range(cols - 1):
                out = V[it[i][j]] - V[it[i_in][j]]
                faces.append(oriented((it[i][j], it[i][j + 1], ib[i][j + 1], ib[i][j]), V, out))
    return verts, faces


def resample(pts, step, closed=False):
    out = []
    seq = pts + [pts[0]] if closed else pts
    for i in range(len(seq) - 1):
        a, b = Vector(seq[i]), Vector(seq[i + 1])
        n = max(1, math.ceil((b - a).length / step))
        for k in range(n):
            out.append(a.lerp(b, k / n))
    if not closed:
        out.append(Vector(seq[-1]))
    return [(p.x, p.y) for p in out]


def strip_grid(pts, width, closed=False, ncross=2, step=0.15, miter_limit=3.0, offset=0.0):
    """Polyline -> grid rows with mitered joints. offset shifts the strip along the left normal."""
    P = [Vector(p) for p in resample(pts, step, closed)]
    n = len(P)
    rows = []
    for i in range(n):
        if closed:
            d0, d1 = (P[i] - P[i - 1]).normalized(), (P[(i + 1) % n] - P[i]).normalized()
        else:
            d0 = (P[i] - P[i - 1]).normalized() if i > 0 else (P[1] - P[0]).normalized()
            d1 = (P[i + 1] - P[i]).normalized() if i < n - 1 else d0
        n0, n1 = Vector((-d0.y, d0.x)), Vector((-d1.y, d1.x))
        m = n0 + n1
        m = n0 if m.length < 1e-6 else m.normalized()
        scale = min(miter_limit, 1.0 / max(1e-3, m.dot(n0)))
        rows.append([tuple(P[i] + m * (offset + ((k / (ncross - 1)) - 0.5) * width) * scale) for k in range(ncross)])
    return rows


def fan_grid(center, outline, mid=True):
    c = Vector(center)
    rows = []
    for p in outline:
        p = Vector(p)
        rows.append([tuple(c), tuple(c.lerp(p, 0.5)), tuple(p)] if mid else [tuple(c), tuple(p)])
    return rows


def quad_grid(p00, p10, p11, p01, nu, nv):
    A, B, C, D = (Vector(p) for p in (p00, p10, p11, p01))
    rows = []
    for i in range(nu + 1):
        u = i / nu
        rows.append([tuple((A.lerp(B, u)).lerp(D.lerp(C, u), j / nv)) for j in range(nv + 1)])
    return rows


def rounded_poly(corners, radius, seg=4):
    """Closed polygon with rounded corners (2D)."""
    out = []
    n = len(corners)
    for i in range(n):
        p0, p1, p2 = Vector(corners[i - 1]), Vector(corners[i]), Vector(corners[(i + 1) % n])
        a, b = (p0 - p1).normalized(), (p2 - p1).normalized()
        ang = math.acos(max(-1, min(1, a.dot(b))))
        t = radius / math.tan(ang / 2)
        s, e = p1 + a * t, p1 + b * t
        bis = (a + b).normalized()
        cen = p1 + bis * (radius / math.sin(ang / 2))
        a0 = math.atan2(s.y - cen.y, s.x - cen.x)
        a1 = math.atan2(e.y - cen.y, e.x - cen.x)
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(seg + 1):
            ak = a0 + da * k / seg
            out.append((cen.x + radius * math.cos(ak), cen.y + radius * math.sin(ak)))
    return out


# =============================================================== design (pre-shift coordinates)
# Gear contact points; everything is shifted along Y at the end so the origin sits midway between them.
NOSE_GEAR_Y = -3.35
MAIN_GEAR_Y = 2.45
MAIN_GEAR_X = 1.64

# ---- fuselage (lifting body): y, half-width, chine z, crown height above chine, belly depth below chine.
# Narrow, flattened nose; widens toward the tail where it swallows the inner halves of the engines.
FUS = table([
    (-6.70, 0.040, 1.720, 0.025, 0.018),
    (-6.63, 0.260, 1.724, 0.120, 0.070),
    (-6.45, 0.540, 1.736, 0.265, 0.150),
    (-6.10, 0.820, 1.762, 0.420, 0.235),
    (-5.55, 1.050, 1.800, 0.560, 0.315),
    (-4.85, 1.200, 1.845, 0.660, 0.370),
    (-4.00, 1.300, 1.882, 0.720, 0.410),
    (-3.00, 1.360, 1.905, 0.750, 0.435),
    (-1.80, 1.400, 1.917, 0.755, 0.450),
    (-0.50, 1.440, 1.920, 0.740, 0.455),
    (0.90, 1.510, 1.920, 0.710, 0.455),
    (2.00, 1.615, 1.920, 0.670, 0.450),
    (3.10, 1.700, 1.922, 0.620, 0.435),
    (4.20, 1.740, 1.925, 0.565, 0.410),
    (5.10, 1.700, 1.930, 0.510, 0.380),
    (5.65, 1.620, 1.935, 0.465, 0.350),
    (5.90, 1.540, 1.940, 0.430, 0.325),
])
CROWN_Q = 0.65                    # top:    z = zc + ht * (1 - |x/w|^P)^Q   (vertical wall at the chine)
CROWN_P = pchip([-7.0, -1.0, 3.0, 6.0], [2.2, 2.2, 3.0, 3.0])   # flatter deck toward the tail
BELLY_P = 2.4                     # bottom: z = zc - hb * (1 - |x/w|^P)       (creased chine)
FUS_STATIONS = [-6.70, -6.65, -6.56, -6.42, -6.22, -5.96, -5.62, -5.22, -4.75, -4.22, -3.62, -2.98, -2.30,
                -1.55, -0.80, 0.00, 0.80, 1.60, 2.40, 3.20, 4.00, 4.70, 5.25, 5.62, 5.90]
TAIL_Y = 5.90


def fus_top_z(x, y):
    w, zc, ht, hb = FUS(y)
    u = min(1.0, abs(x) / w)
    return zc + ht * max(0.0, 1 - u ** CROWN_P(y)) ** CROWN_Q


def fus_ring(y, nt=14, nb=6):
    w, zc, ht, hb = FUS(y)
    pts = []
    for k in range(nt):                       # right chine (+w) over the crown toward the left chine
        c = math.cos(math.pi * k / nt)
        pts.append((w * c, y, zc + ht * max(0.0, 1 - abs(c) ** CROWN_P(y)) ** CROWN_Q))
    for k in range(nb):                       # left chine under the belly back to the right
        c = math.cos(math.pi + math.pi * k / nb)
        pts.append((w * c, y, zc - hb * (1 - abs(c) ** BELLY_P)))
    return pts, nt


def build_fuselage(root):
    rings = []
    for y in FUS_STATIONS:
        r, nt = fus_ring(y)
        rings.append(r)

    def mat(j, i, q):
        return 'Hull' if i < nt else 'HullDark'
    v, f, m = loft(rings, True, True, mat, cap_mats=('Hull', 'HullDark'))
    body = Parts().add(v, f, m)
    # tail light bar on the flat rear face
    w, zc, ht, hb = FUS(TAIL_Y)
    body.add(*box((0, TAIL_Y + 0.012, zc + 0.05), (0.95, 0.05, 0.075)), 'Glow')
    return body.build('Fuselage', parent=root, sharp=40, bevel=(0.03, 2, 40))


# ---- canopy: y, half-width, bubble height above the hull
CANOPY = table([
    (-5.30, 0.010, 0.004),
    (-5.24, 0.200, 0.085),
    (-5.10, 0.340, 0.175),
    (-4.88, 0.470, 0.285),
    (-4.55, 0.580, 0.400),
    (-4.12, 0.650, 0.490),
    (-3.60, 0.680, 0.540),
    (-3.05, 0.665, 0.525),
    (-2.50, 0.590, 0.450),
    (-2.05, 0.460, 0.330),
    (-1.70, 0.300, 0.190),
    (-1.48, 0.110, 0.070),
])
CANOPY_STATIONS = [-5.30, -5.24, -5.10, -4.88, -4.55, -4.12, -3.60, -3.05, -2.50, -2.05, -1.70, -1.48]


def canopy_ring(y, n=14):
    wc, hc = CANOPY(y)
    pts = []
    for k in range(n + 1):
        c = math.cos(math.pi * k / n)
        x = wc * c
        pts.append((x, y, fus_top_z(x, y) + hc * max(0.0, 1 - abs(c) ** 2.4) ** 0.55))
    pts.append((-wc, y, fus_top_z(-wc, y) - 0.14))
    pts.append((wc, y, fus_top_z(wc, y) - 0.14))
    return pts


def build_canopy(root, surf):
    rings = [canopy_ring(y) for y in CANOPY_STATIONS]
    v, f, m = loft(rings, True, True, lambda j, i, q: 'Glass', cap_mats=('Glass', 'Glass'))
    canopy = build('Canopy', v, f, m, parent=root, sharp=60)
    # sill (frame) around the base, from rear-left round the nose to rear-right; plus a teal edge light outside it
    ys = [-5.30, -5.27, -5.24, -5.17, -5.10, -4.99, -4.88, -4.72, -4.55, -4.34, -4.12, -3.86, -3.60, -3.33,
          -3.05, -2.78, -2.50, -2.28, -2.12]
    right = [(CANOPY(y)[0], y) for y in ys]
    outline = [(-x, y) for (x, y) in reversed(right)] + right[1:]   # CCW seen from above: left normal points inward
    frame = Parts()
    frame.add(*drape_solid(surf, strip_grid(outline, 0.13, ncross=2, step=0.30, offset=-0.01), 0.045, -0.05), 'HullDark')
    frame_obj = frame.build('CanopyFrame', parent=root, sharp=45, bevel=(0.012, 1, 40), recalc=False)
    light = Parts()
    light.add(*drape_solid(surf, strip_grid(outline, 0.05, ncross=2, step=0.30, offset=-0.11), 0.014, -0.02), 'Glow')
    light.build('CanopyLight', parent=root, sharp=45, recalc=False)
    return canopy, frame_obj


# ---- dorsal spine: y, half-width, height above the hull
SPINE = table([
    (-2.20, 0.040, 0.020),
    (-2.10, 0.330, 0.130),
    (-1.85, 0.410, 0.175),
    (0.00, 0.390, 0.185),
    (2.00, 0.350, 0.180),
    (3.60, 0.300, 0.165),
    (4.80, 0.230, 0.130),
    (5.40, 0.160, 0.070),
    (5.78, 0.100, 0.012),
])
SPINE_STATIONS = [-2.20, -2.10, -1.85, -0.90, 0.20, 1.40, 2.60, 3.60, 4.40, 4.95, 5.40, 5.78]


def spine_ring(y, n=8):
    ws, hs = SPINE(y)
    pts = []
    for k in range(n + 1):
        c = math.cos(math.pi * k / n)
        x = ws * c
        pts.append((x, y, fus_top_z(x, y) + hs * max(0.0, 1 - abs(c) ** 4) ** 0.35))
    pts.append((-ws, y, fus_top_z(-ws, y) - 0.12))
    pts.append((ws, y, fus_top_z(ws, y) - 0.12))
    return pts


def build_spine(root):
    rings = [spine_ring(y) for y in SPINE_STATIONS]
    v, f, m = loft(rings, True, True, lambda j, i, q: 'HullDark', cap_mats=('HullDark', 'HullDark'))
    return build('Spine', v, f, m, parent=root, sharp=40, bevel=(0.025, 1, 40))


def spine_top_z(y):
    return fus_top_z(0, y) + SPINE(y)[1]


# ---- airfoil-ish section used by the fin and the winglets
FOIL = [(0.0, 0.0), (0.04, 0.55), (0.13, 0.86), (0.32, 1.0), (0.62, 0.80), (1.0, 0.16)]


def foil_ring(le, chord_dir, side_dir, chord, thick):
    """Closed ring around an airfoil section. le: leading-edge point, chord_dir: unit LE->TE, side_dir: thickness axis."""
    le, cd, sd = Vector(le), Vector(chord_dir), Vector(side_dir)
    pos = [le + cd * (s * chord) + sd * (f * thick / 2) for s, f in FOIL]
    neg = [le + cd * (s * chord) - sd * (f * thick / 2) for s, f in reversed(FOIL[1:])]
    return pos + neg


def build_fin(root):
    # horizontal slices: z, LE y, TE y, thickness
    slices = [(2.30, 2.20, 5.80, 0.24),
              (2.74, 2.80, 5.76, 0.22),
              (3.06, 3.72, 5.80, 0.17),
              (3.20, 4.48, 5.88, 0.11)]
    rings = [foil_ring((0, yl, z), (0, 1, 0), (1, 0, 0), yt - yl, t) for z, yl, yt, t in slices]
    v, f, m = loft(rings, True, True, lambda j, i, q: 'Accent', cap_mats=('Accent', 'Accent'))
    fin = Parts().add(v, f, m)
    fin.add(*box((0, 5.74, 3.205), (0.07, 0.16, 0.035)), 'Glow')        # beacon on the fin tip
    return fin.build('Fin', parent=root, sharp=40, bevel=(0.026, 1, 40))


# ---- wings: cranked leading edge (strake under the intakes), forward-raked trailing edge
WING_ROOT_X, WING_CRANK_X, WING_TIP_X = 0.95, 2.30, 5.10
STRAKE0, CRANK, TIP_LE = (0.95, -3.70), (2.30, -1.10), (5.10, 1.90)
TE_ROOT, TE_TIP = (0.95, 4.35), (5.20, 3.70)
WING_Z0, DIHEDRAL = 1.97, math.radians(1.5)
WING_T_ROOT, WING_T_TIP = 0.46, 0.20


def wing_le(x):
    if x <= CRANK[0]:
        return lerp(STRAKE0[1], CRANK[1], (x - STRAKE0[0]) / (CRANK[0] - STRAKE0[0]))
    return lerp(CRANK[1], TIP_LE[1], (x - CRANK[0]) / (TIP_LE[0] - CRANK[0]))


def wing_te(x):
    return lerp(TE_ROOT[1], TE_TIP[1], (x - TE_ROOT[0]) / (TE_TIP[0] - TE_ROOT[0]))


def wing_mid_z(x):
    return WING_Z0 + (x - WING_ROOT_X) * math.tan(DIHEDRAL)


def wing_t(x):
    return lerp(WING_T_ROOT, WING_T_TIP, (x - WING_ROOT_X) / (WING_TIP_X - WING_ROOT_X))


def wing_section(x, s):
    yl, yt, zm, t = wing_le(x), wing_te(x), wing_mid_z(x), wing_t(x)
    c = yt - yl
    X = s * x
    return [(X, yl, zm),                      # 0 leading edge
            (X, yl + 0.10 * c, zm + t / 2),   # 1 top: end of LE chamfer
            (X, yl + 0.82 * c, zm + t / 2),   # 2 top: start of TE chamfer
            (X, yt, zm + 0.022),              # 3 trailing edge top
            (X, yt, zm - 0.022),              # 4 trailing edge bottom
            (X, yl + 0.80 * c, zm - t / 2),   # 5 bottom
            (X, yl + 0.14 * c, zm - t / 2)]   # 6 bottom: end of LE chamfer


def build_wing(root, side):
    s = side
    xs = [WING_ROOT_X, 1.60, WING_CRANK_X, 3.2, 4.2, WING_TIP_X]
    rings = [wing_section(x, s) for x in xs]
    tops = {0: 'HullDark', 1: 'Hull', 2: 'HullDark', 3: 'HullDark', 4: 'HullDark', 5: 'HullDark', 6: 'HullDark'}
    v, f, m = loft(rings, True, True, lambda j, i, q: tops[i], cap_mats=('HullDark', 'HullDark'))
    return build('Wing_' + ('L' if s > 0 else 'R'), v, f, m, parent=root, sharp=12, bevel=(0.03, 2, 12))


def build_winglet(root, side):
    s = side
    x0 = WING_TIP_X - 0.03
    yl0, yt0 = wing_le(WING_TIP_X), wing_te(WING_TIP_X)
    z0 = wing_mid_z(WING_TIP_X) - 0.05
    cant = math.radians(22)
    span = Vector((s * math.sin(cant), 0, math.cos(cant)))
    side_dir = Vector((s * math.cos(cant), 0, -math.sin(cant)))
    H = 1.25
    # span fraction, LE y, TE y, thickness
    st = [(0.0, yl0 - 0.03, yt0 + 0.03, 0.26), (0.55, yl0 + 0.64, yt0 + 0.06, 0.17),
          (1.0, yl0 + 1.08, yt0 + 0.12, 0.11)]
    rings = []
    for eta, yl, yt, t in st:
        base = Vector((s * x0, 0, z0)) + span * (eta * H)
        rings.append(foil_ring((base.x, yl, base.z), (0, 1, 0), side_dir, yt - yl, t))
    mats = ['Hull', 'Accent']
    v, f, m = loft(rings, True, True, lambda j, i, q: mats[j], cap_mats=('Hull', 'Accent'))
    wl = Parts().add(v, f, m)
    xl = WING_TIP_X - 0.16
    wl.add(*box((s * xl, wing_le(xl) + 0.035, wing_mid_z(xl)), (0.20, 0.07, 0.06)), 'Glow')   # nav light
    return wl.build('Winglet_' + ('L' if s > 0 else 'R'), parent=root, sharp=40, bevel=(0.024, 1, 40))


# ---- nacelles (intake slot on the strake, cowl, engine body, nozzle) as one loft path
NAC = table([  # y, center x, center z, half-width, half-height, superellipse exponent
    (-0.80, 1.84, 2.42, 0.45, 0.26, 3.4),
    (-0.45, 1.84, 2.39, 0.50, 0.35, 3.0),
    (0.00, 1.80, 2.32, 0.56, 0.46, 2.7),
    (0.80, 1.73, 2.22, 0.64, 0.60, 2.3),
    (1.70, 1.67, 2.14, 0.69, 0.68, 2.05),
    (2.60, 1.64, 2.10, 0.70, 0.70, 2.0),
    (5.45, 1.63, 2.09, 0.70, 0.70, 2.0),
])
NAC_N = 18
INTAKE_Y = -0.80
NOZZLE_EXIT_Y = 6.38
NOZZLE_X, NOZZLE_Z = 1.63, 2.09
INTAKE_RAKE = 0.30


def build_nacelle(root, side):
    s = side
    rings, mats = [], []

    def ring(y, da=0.0, db=0.0, rake=0.0, params_y=None):
        cx, cz, a, b, e = NAC(params_y if params_y is not None else y)
        pts = se_ring(cx, y, cz, a + da, b + db, e, NAC_N, rake)
        return [(s * p[0], p[1], p[2]) for p in pts]

    y0 = INTAKE_Y
    # intake duct from the fan face out to the lip (raked: the top lip leads)
    rings.append(ring(y0 + 0.55, -0.12, -0.10, INTAKE_RAKE, params_y=y0)); mats.append('Metal')
    rings.append(ring(y0 + 0.14, -0.075, -0.065, INTAKE_RAKE, params_y=y0)); mats.append('Metal')
    rings.append(ring(y0 + 0.012, -0.05, -0.045, INTAKE_RAKE, params_y=y0)); mats.append('HullDark')
    rings.append(ring(y0, 0.0, 0.0, INTAKE_RAKE)); mats.append('HullDark')
    rings.append(ring(-0.50, 0.0, 0.0, INTAKE_RAKE * 0.4)); mats.append('split')
    for y in (-0.10, 0.35, 0.80, 1.25, 1.70, 2.60, 4.30):
        rings.append(ring(y)); mats.append('split')
    rings.append(ring(4.75)); mats.append('HullDark')           # dark band ahead of the nozzle
    rings.append(ring(5.43)); mats.append('Metal')              # step face into the shroud
    rings.append(ring(5.45, 0.035, 0.035)); mats.append('Metal')
    rings.append(ring(NOZZLE_EXIT_Y, 0.07, 0.07, params_y=5.45)); mats.append('Metal')
    rings.append(ring(NOZZLE_EXIT_Y + 0.012, -0.04, -0.04, params_y=5.45)); mats.append('Glow')
    rings.append(ring(NOZZLE_EXIT_Y - 0.15, -0.065, -0.065, params_y=5.45)); mats.append('Metal')
    rings.append(ring(NOZZLE_EXIT_Y - 0.40, -0.12, -0.12, params_y=5.45)); mats.append(None)

    def mat(j, i, q):
        mm = mats[j]
        if mm == 'split':
            zc = sum(p[2] for p in q) / 4
            cz = NAC(sum(p[1] for p in q) / 4)[1]
            return 'Hull' if zc > cz - 0.02 else 'HullDark'
        return mm
    v, f, m = loft(rings, True, True, mat, cap_mats=('Metal', 'Glow'))
    nac = Parts().add(v, f, m)
    # exhaust plug (inner cone)
    cx, cz = s * NOZZLE_X, NOZZLE_Z
    yb = NOZZLE_EXIT_Y - 0.44
    prof = [(yb, 0.21), (yb + 0.16, 0.205), (yb + 0.34, 0.16), (yb + 0.48, 0.08), (yb + 0.54, 0.02)]
    cone = [[(cx + r * math.cos(2 * math.pi * k / 14), y, cz + r * math.sin(2 * math.pi * k / 14)) for k in range(14)] for y, r in prof]
    cv, cf, cm = loft(cone, True, True, lambda j, i, q: 'Metal', cap_mats=('Metal', 'Metal'))
    nac.add(cv, cf, cm)
    # intake fan hub
    hcx, hcz = s * NAC(y0)[0], NAC(y0)[1]
    hv, hf = sphere((hcx, y0 + 0.53, hcz), 0.11, nu=10, nv=6, scale=(1, 0.8, 1))
    nac.add(hv, hf, 'Metal')
    return nac.build('Nacelle_' + ('L' if s > 0 else 'R'), parent=root, sharp=38, bevel=(0.022, 1, 38))


# ---- guns: small barrels on the wing leading edges, just outboard of the intakes
GUN_X = 2.50
GUN_TIP_Y = -1.95


def gun_z():
    return wing_mid_z(GUN_X) + 0.01


def build_gun(root, side):
    s = side
    g = Parts()
    x, z = s * GUN_X, gun_z()
    pod = [(x, -1.40, z), (x, -1.25, z), (x, -0.80, z), (x, 0.0, z), (x, 0.30, z)]
    g.add(*tube(pod, [0.06, 0.125, 0.135, 0.12, 0.04], n=10), 'HullDark')
    g.add(*cylinder((x, -1.30, z), (x, GUN_TIP_Y + 0.12, z), 0.045, n=8), 'Metal')
    g.add(*cylinder((x, GUN_TIP_Y + 0.15, z), (x, GUN_TIP_Y, z), 0.065, n=8), 'Metal')
    return g.build('Gun_' + ('L' if s > 0 else 'R'), parent=root, sharp=40, bevel=(0.008, 1, 40))


# ---- antenna (on the spine, offset left, behind the canopy)
def build_antenna(root):
    g = Parts()
    y0, x0 = -0.60, 0.17
    zb = spine_top_z(y0) - 0.012
    g.add(*cylinder((x0, y0, zb - 0.05), (x0, y0 + 0.12, zb + 0.34), 0.016, 0.010, n=6), 'Metal')
    g.add(*sphere((x0, y0 + 0.125, zb + 0.355), 0.03, nu=8, nv=5), 'Glow')
    g.add(*cylinder((x0, y0 - 0.02, zb - 0.06), (x0, y0 - 0.02, zb + 0.04), 0.05, 0.04, n=8), 'Metal')
    return g.build('Antenna', parent=root, sharp=40)


# =============================================================== decals and panels
def number07(surf, center, right, up, H, mode, st=None, step=0.12, lift=0.012):
    """Draped "07" glyph pair. center/right/up are 2D in the drape plane ((x, y) for down, (y, z) for side)."""
    st = st or H * 0.30
    W = H * 0.55
    c = Vector(center)

    def Q(gx, gy):
        p = c + right * gx + up * gy
        return (p.x, p.y)
    verts, faces = [], []

    def add(vf):
        o = len(verts)
        verts.extend(vf[0])
        faces.extend(tuple(i + o for i in f) for f in vf[1])
    R = W - st / 2
    ox = -0.75 * H
    zero = []
    for i in range(6):
        a = math.pi * i / 5
        zero.append(Q(ox + R * math.cos(a), (H - R - st / 2) + R * math.sin(a)))
    for i in range(6):
        a = math.pi + math.pi * i / 5
        zero.append(Q(ox + R * math.cos(a), -(H - R - st / 2) + R * math.sin(a)))
    add(drape_solid(surf, strip_grid(zero, st, closed=True, step=step), lift, -0.02, mode=mode, wrap=True))
    sx = 0.75 * H
    seven = [Q(sx - W, H - st / 2), Q(sx + W - 0.05 * H, H - st / 2), Q(sx - 0.15 * H, -H)]
    add(drape_solid(surf, strip_grid(seven, st, step=step), lift, -0.02, mode=mode))
    return verts, faces


def build_decals(root, fus_surf, wing_l, wing_r, nac_l, nac_r):
    nose = Parts()
    # twin coral chevrons on the nose, pointing forward
    for (apex, arm, ln) in (((0, -6.40), 0.40, 0.15), ((0, -6.10), 0.50, 0.13)):
        ax, ay = apex
        pts = [(ax - arm, ay + arm * 0.95), (ax, ay), (ax + arm, ay + arm * 0.95)]
        nose.add(*drape_solid(fus_surf, strip_grid(pts, ln, ncross=3, step=0.2), 0.012, -0.03), 'Accent')
    nose_obj = nose.build('NoseDecals', parent=root, sharp=40, bevel=(0.005, 1, 40), recalc=False)

    panels = Parts()
    for s in (1, -1):
        # dorsal access hatches between the canopy and the intakes
        quad = [(s * 0.62, -1.95), (s * 1.02, -1.80), (s * 1.06, -0.75), (s * 0.60, -0.75)]
        panels.add(*drape_solid(fus_surf, quad_grid(quad[0], quad[3], quad[2], quad[1], 3, 2), 0.012, -0.03), 'Hull')
    panels.build('AccessPanels', parent=root, sharp=40, bevel=(0.006, 1, 40), recalc=False)

    # coral racing stripes along the top of each engine hump
    stripes = Parts()
    for s, nac in ((1, nac_l), (-1, nac_r)):
        surf = Surf([nac])
        path = [(s * (NAC(y)[0] - 0.19), y) for y in (0.35, 1.0, 1.7, 2.6, 3.5, 4.3, 4.7)]
        stripes.add(*drape_solid(surf, strip_grid(path, 0.15, ncross=3, step=0.6), 0.014, -0.03), 'Accent')
    stripes_obj = stripes.build('EngineStripes', parent=root, sharp=40, bevel=(0.005, 1, 40), recalc=False)

    # left wing: the site's emblem (dark rounded plate, ivory triangle, teal inner triangle, coral dot)
    wl = Surf([wing_l])
    em = Parts()
    cx, cy, S = 3.45, 1.85, 1.05            # emblem center and plate size (plan)
    up = Vector((0, -1))                     # glyph "up" = toward the nose
    rt = Vector((-1, 0))                     # glyph "right" as seen from the chase camera

    def P(gx, gy):
        p = Vector((cx, cy)) + rt * gx + up * gy
        return (p.x, p.y)
    h = S / 2
    plate = rounded_poly([P(-h, -h), P(h, -h), P(h, h), P(-h, h)], 0.16, seg=3)
    em.add(*drape_solid(wl, fan_grid(P(0, 0), plate, mid=False), 0.010, -0.03, wrap=True), 'HullDark')
    k = S / 64.0                              # favicon units -> meters
    outer = [P(0, (32 - 9) * k), P((56 - 32) * k, (32 - 51) * k), P((8 - 32) * k, (32 - 51) * k)]
    inner = [P(0, (32 - 24) * k), P((47 - 32) * k, (32 - 51) * k), P((17 - 32) * k, (32 - 51) * k)]
    em.add(*drape_solid(wl, strip_grid(outer, 2.6 * k, closed=True, step=0.5), 0.018, 0.0, wrap=True), 'Hull')
    em.add(*drape_solid(wl, strip_grid(inner, 2.6 * k, closed=True, step=0.5), 0.018, 0.0, wrap=True), 'Glow')
    dot = [P(3.2 * k * math.cos(2 * math.pi * i / 10), (32 - 42) * k + 3.2 * k * math.sin(2 * math.pi * i / 10)) for i in range(10)]
    em.add(*drape_solid(wl, fan_grid(P(0, (32 - 42) * k), dot, mid=False), 0.018, 0.0, wrap=True), 'Accent')
    em_obj = em.build('Emblem', parent=root, sharp=40, bevel=(0.004, 1, 40), recalc=False)

    # right wing: "07" in navy, readable from the chase camera
    num = Parts()
    num.add(*number07(Surf([wing_r]), (-3.45, 1.95), Vector((-1, 0)), Vector((0, -1)), 0.40, 'down', step=1.0), 'HullDark')
    num_obj = num.build('Number07', parent=root, sharp=40, bevel=(0.004, 1, 40), recalc=False)
    # "07" on both nose flanks (side view); coordinates are (y, z), glyph right points aft on the left flank
    side = Parts()
    for sgn, mode in ((1, '+x'), (-1, '-x')):
        side.add(*number07(fus_surf, (-3.95, 2.155), Vector((sgn, 0)), Vector((0, 1)), 0.19, mode, st=0.062, step=0.06, lift=0.016), 'HullDark')
    side.build('NoseNumbers', parent=root, sharp=40, recalc=False)
    return nose_obj, stripes_obj, em_obj, num_obj


# =============================================================== landing gear
NOSE_HINGE = (0.0, NOSE_GEAR_Y, 1.82)
MAIN_HINGE_Z = 1.86
STROKE = 0.50          # telescoping travel of the lower strut
GEAR_STOW = math.radians(90)
DOOR_OPEN = math.radians(105)


def stadium(length, width, n_end=5):
    """Closed 2D outline of a stadium (rounded slot) centered at the origin, long axis along Y."""
    r = width / 2
    h = max(0.0, length / 2 - r)
    pts = []
    for i in range(n_end + 1):
        a = math.pi * i / n_end
        pts.append((r * math.cos(a), h + r * math.sin(a)))
    for i in range(n_end + 1):
        a = math.pi + math.pi * i / n_end
        pts.append((r * math.cos(a), -h + r * math.sin(a)))
    return pts


def prism(outline, z0, z1, center=(0, 0)):
    cx, cy = center
    rings = [[(cx + x, cy + y, z) for (x, y) in outline] for z in (z0, z1)]
    v, f, _ = loft(rings, True, True)
    return v, f


def build_gear_leg(root, name, hinge, leg, piston_r, foot, knuckle_w, a_frame):
    """Pivot mesh (boxy upper leg) at the hinge; child piston (telescopes); grandchild foot (stays level).
    leg: (width x, depth y); foot: (length y, width x)."""
    L = hinge[2]                             # hinge height above ground = pad bottom depth below the hinge
    up = Parts()
    up.add(*cylinder((-knuckle_w / 2, 0, 0), (knuckle_w / 2, 0, 0), leg[1] * 0.55, n=10), 'Metal')
    up.add(*box((0, 0, -0.49), (leg[0], leg[1], 1.10)), 'Hull')
    up.add(*box((0, 0, -1.04), (leg[0] * 1.14, leg[1] * 1.14, 0.13)), 'HullDark')    # cuff
    if a_frame:
        for sx in (-1, 1):
            up.add(*cylinder((sx * knuckle_w * 0.44, 0, -0.02), (sx * leg[0] * 0.3, 0, -0.80), 0.06, n=8), 'Metal')
    pivot = up.build(name, parent=root, sharp=40, bevel=(0.03, 1, 40))
    pivot.location = hinge
    lo = Parts()
    lo.add(*cylinder((0, 0, -0.55), (0, 0, -(L - 0.20)), piston_r, n=12), 'Metal')
    lo.add(*box((0, -piston_r - 0.03, -(L - 0.45)), (0.06, 0.07, 0.34)), 'HullDark')     # torque link
    piston = lo.build(name + '_Piston', parent=pivot, sharp=40, bevel=(0.01, 1, 40))
    ft = Parts()
    ft.add(*sphere((0, 0, 0), piston_r * 1.25, nu=8, nv=5), 'Metal')
    ft.add(*box((0, 0, -0.07), (piston_r * 1.6, foot[0] * 0.45, 0.10)), 'HullDark')       # yoke
    ft.add(*prism(stadium(foot[0], foot[1]), -0.21, -0.08), 'HullDark')
    ft.add(*prism(stadium(foot[0] * 0.86, foot[1] * 0.70, n_end=3), -0.08, -0.06), 'Metal')  # tread plate
    foot_obj = ft.build(name + '_Foot', parent=piston, sharp=50, bevel=(0.02, 1, 50))
    foot_obj.location = (0, 0, -(L - 0.21))
    return pivot, piston, foot_obj


def build_bay_and_doors(root, surf, x0, x1, y0, y1, names, tag, nseg=4):
    """Metal bay panel + two doors hinged at the bay's outer edges (x0 and x1), draped under a hull surface.
    names: (door hinged at x0, door hinged at x1)."""
    bay = Parts()
    g = quad_grid((x0, y0), (x0, y1), (x1, y1), (x1, y0), 4, nseg)
    bay.add(*drape_solid(surf, g, 0.004, -0.03, mode='up'), 'Metal')
    bay_obj = bay.build('GearBay_' + tag, parent=root, sharp=40, recalc=False)
    doors = []
    xm = (x0 + x1) / 2
    for (xa, xb, hinge_x, name) in ((x0, xm, x0, names[0]), (xm, x1, x1, names[1])):
        d = Parts()
        g = quad_grid((xa + 0.006, y0 + 0.01), (xa + 0.006, y1 - 0.01), (xb - 0.006, y1 - 0.01), (xb - 0.006, y0 + 0.01), 3, max(1, nseg // 2))
        verts, faces = drape_solid(surf, g, 0.040, 0.010, mode='up', bottom=True)
        hz = surf.hit(hinge_x, (y0 + y1) / 2, 'up')[0].z - 0.025
        d.add(verts, faces, 'HullDark')
        door = d.build(name, parent=root, sharp=40, bevel=(0.006, 1, 40), origin=(hinge_x, (y0 + y1) / 2, hz), recalc=False)
        free_x = xb if hinge_x == xa else xa
        door['open_angle'] = DOOR_OPEN if free_x > hinge_x else -DOOR_OPEN
        doors.append(door)
    return bay_obj, doors


# =============================================================== assembly
def main():
    make_materials()
    root = bpy.data.objects.new('Ship', None)
    root.empty_display_type = 'PLAIN_AXES'
    COLL.objects.link(root)

    fus = build_fuselage(root)
    fus_surf = Surf([fus])
    canopy, cframe = build_canopy(root, fus_surf)
    spine = build_spine(root)
    fin = build_fin(root)
    wing_l, wing_r = build_wing(root, 1), build_wing(root, -1)
    wl_l, wl_r = build_winglet(root, 1), build_winglet(root, -1)
    nac_l, nac_r = build_nacelle(root, 1), build_nacelle(root, -1)
    build_gun(root, 1), build_gun(root, -1)
    build_antenna(root)
    build_decals(root, fus_surf, wing_l, wing_r, nac_l, nac_r)

    # ---- landing gear
    gear = {}
    gear['Nose'] = build_gear_leg(root, 'Gear_Nose', NOSE_HINGE, (0.28, 0.24), 0.115, (0.86, 0.52), 0.46, False)
    for s, tag in ((1, 'L'), (-1, 'R')):
        gear[tag] = build_gear_leg(root, 'Gear_' + tag, (s * MAIN_GEAR_X, MAIN_GEAR_Y, MAIN_HINGE_Z), (0.34, 0.28), 0.14, (1.05, 0.62), 0.64, True)
    bays = {}
    bays['Nose'] = build_bay_and_doors(root, fus_surf, -0.34, 0.34, NOSE_GEAR_Y - 0.24, NOSE_GEAR_Y + 1.62,
                                       ('Door_Nose_R', 'Door_Nose_L'), 'Nose')
    for s, tag, nac in ((1, 'L', nac_l), (-1, 'R', nac_r)):
        surf = Surf([nac])
        xa, xb = s * MAIN_GEAR_X - 0.40, s * MAIN_GEAR_X + 0.40
        names = ('Door_%s_In' % tag, 'Door_%s_Out' % tag) if s > 0 else ('Door_%s_Out' % tag, 'Door_%s_In' % tag)
        bays[tag] = build_bay_and_doors(root, surf, xa, xb, MAIN_GEAR_Y - 0.24, MAIN_GEAR_Y + 1.72, names, tag)

    # ---- attachment points
    e = {}
    e['Engine_L'] = empty('Engine_L', (NOZZLE_X, NOZZLE_EXIT_Y, NOZZLE_Z), root, rot=(0, 0, math.pi))
    e['Engine_R'] = empty('Engine_R', (-NOZZLE_X, NOZZLE_EXIT_Y, NOZZLE_Z), root, rot=(0, 0, math.pi))
    e['Muzzle_L'] = empty('Muzzle_L', (GUN_X, GUN_TIP_Y, gun_z()), root)
    e['Muzzle_R'] = empty('Muzzle_R', (-GUN_X, GUN_TIP_Y, gun_z()), root)
    e['Cockpit'] = empty('Cockpit', (0.0, -3.40, fus_top_z(0, -3.40) + 0.20), root)
    e['Boarding'] = empty('Boarding', (3.60, -0.90, 0.0), root)   # ahead of the left wing root, clear of guns/footprint

    # ---- shift so the origin sits midway between the nose pad and the main pads
    shift = -(NOSE_GEAR_Y + MAIN_GEAR_Y) / 2
    for o in list(root.children):
        o.location.y += shift

    animate(gear, bays)
    bake_modifiers()
    join_into('Fuselage', ['NoseDecals', 'NoseNumbers', 'AccessPanels'])
    join_into('CanopyFrame', ['CanopyLight'])
    join_into('Wing_L', ['Emblem'])
    join_into('Wing_R', ['Number07'])
    gear_objs = [o for trio in gear.values() for o in trio]
    hull = [fus] + [o for o in SCENE.objects if o.name in ('Nacelle_L', 'Nacelle_R', 'Wing_L', 'Wing_R')]
    check_stowed(gear_objs, hull)
    bay_panels = [b for (b, _) in bays.values()]
    moving = set(gear_objs) | set(bay_panels)
    bake_ao([o for o in SCENE.objects if o.type == 'MESH' and o not in moving], 0)   # hull + closed doors, stowed
    bake_ao(gear_objs + bay_panels, F_END)                                           # legs + bays, deployed
    SCENE.frame_set(F_END)
    report = export(root)
    return report


def animate(gear, bays):
    SCENE.render.fps = FPS
    SCENE.frame_start, SCENE.frame_end = 0, F_END
    act = bpy.data.actions.new('GearDeploy')

    def key(obj, path, frames_vals):
        if obj.animation_data is None:
            obj.animation_data_create().action = act
        for f, val in frames_vals:
            if path == 'rotation_x':
                obj.rotation_euler.x = val
                obj.keyframe_insert('rotation_euler', index=0, frame=f)
            elif path == 'rotation_y':
                obj.rotation_euler.y = val
                obj.keyframe_insert('rotation_euler', index=1, frame=f)
            elif path == 'location_z':
                obj.location.z = val
                obj.keyframe_insert('location', index=2, frame=f)
    # doors swing open first, legs swing down, then the struts extend
    for tag, (bay, doors) in bays.items():
        for d in doors:
            a = d['open_angle']
            key(d, 'rotation_y', [(0, 0.0), (9, a)])
    for tag, (pivot, piston, foot) in gear.items():
        delay = 0 if tag == 'Nose' else 1
        key(pivot, 'rotation_x', [(0, GEAR_STOW), (5 + delay, GEAR_STOW), (24 + delay, 0.0)])
        key(foot, 'rotation_x', [(0, -GEAR_STOW), (5 + delay, -GEAR_STOW), (24 + delay, 0.0)])
        z0 = piston.location.z
        key(piston, 'location_z', [(0, z0 + STROKE), (19, z0 + STROKE), (F_END, z0)])
    SCENE.frame_set(F_END)


# =============================================================== finishing: bake modifiers, AO, checks
AO_DIST, AO_POWER, AO_MIN = 1.5, 2.0, 0.30


def hemisphere_dirs(n):
    """Deterministic cosine-weighted hemisphere directions (z up)."""
    golden = math.pi * (3 - math.sqrt(5))
    out = []
    for i in range(n):
        u = (i + 0.5) / n
        r, z = math.sqrt(u), math.sqrt(1 - u)
        out.append((r * math.cos(i * golden), r * math.sin(i * golden), z))
    return out


AO_DIRS = hemisphere_dirs(24)


def bake_modifiers():
    """Apply every modifier (bevels) so the AO bake sees the final surfaces; custom normals survive."""
    dg = bpy.context.evaluated_depsgraph_get()
    for o in [o for o in SCENE.objects if o.type == 'MESH' and o.modifiers]:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        old = o.data
        o.modifiers.clear()
        o.data = me
        me.name = o.name
        bpy.data.meshes.remove(old)


def join_into(target_name, source_names):
    target = bpy.data.objects[target_name]
    sources = [bpy.data.objects[n] for n in source_names if n in bpy.data.objects]
    if not sources:
        return target
    with bpy.context.temp_override(active_object=target, object=target,
                                   selected_objects=[target] + sources, selected_editable_objects=[target] + sources):
        bpy.ops.object.join()
    target.data.name = target_name
    return target


def world_bvh(objs):
    verts, polys = [], []
    for o in objs:
        mw = o.matrix_world
        off = len(verts)
        verts.extend(mw @ v.co for v in o.data.vertices)
        polys.extend([off + i for i in p.vertices] for p in o.data.polygons)
    return BVHTree.FromPolygons(verts, polys)


def bake_ao(targets, frame):
    """Grayscale ambient occlusion into a CORNER color attribute (exported as COLOR_0). Glow stays unshaded."""
    SCENE.frame_set(frame)
    bpy.context.view_layer.update()
    bvh = world_bvh([o for o in SCENE.objects if o.type == 'MESH'])
    for o in targets:
        me = o.data
        mw = o.matrix_world
        nm = mw.to_3x3().inverted_safe().transposed()
        glow = {i for i, m in enumerate(me.materials) if m and m.name == 'Glow'}
        attr = me.color_attributes.get('AO') or me.color_attributes.new('AO', 'BYTE_COLOR', 'CORNER')
        cols = [1.0] * (len(me.loops) * 4)
        cn = me.corner_normals
        loops = me.loops
        cache = {}
        for poly in me.polygons:
            if poly.material_index in glow:
                continue
            for li in poly.loop_indices:
                vi = loops[li].vertex_index
                n = (nm @ cn[li].vector).normalized()
                k = (vi, round(n.x, 2), round(n.y, 2), round(n.z, 2))
                ao = cache.get(k)
                if ao is None:
                    t, b = frame_for(n)
                    origin = mw @ me.vertices[vi].co + n * 0.012
                    occ = 0.0
                    for dx, dy, dz in AO_DIRS:
                        hit = bvh.ray_cast(origin, t * dx + b * dy + n * dz, AO_DIST)
                        if hit[0] is not None:
                            occ += 1.0 - (hit[3] / AO_DIST) ** 2
                    ao = max(AO_MIN, (1.0 - occ / len(AO_DIRS)) ** AO_POWER)
                    cache[k] = ao
                cols[li * 4:li * 4 + 3] = (ao, ao, ao)
        attr.data.foreach_set('color', cols)
        me.color_attributes.active_color = attr


def check_stowed(gear_objs, hull_objs):
    """Every gear vertex must be inside the hull when stowed (frame 0). Ray-parity test per hull shell."""
    SCENE.frame_set(0)
    bpy.context.view_layer.update()
    bvhs = [world_bvh([h]) for h in hull_objs]
    dirs = (Vector((0, 0, 1)), Vector((1, 0.0001, 0)), Vector((0.0001, 1, 0)))

    def inside(p, bvh):
        votes = 0
        for d in dirs:
            n, o = 0, p.copy()
            for _ in range(64):
                hit = bvh.ray_cast(o, d)
                if hit[0] is None:
                    break
                n += 1
                o = hit[0] + d * 1e-4
            votes += n % 2
        return votes >= 2
    bad, total = [], 0
    for g in gear_objs:
        mw = g.matrix_world
        for v in g.data.vertices:
            p = mw @ v.co
            total += 1
            if not any(inside(p, b) for b in bvhs):
                bad.append((g.name, tuple(round(c, 3) for c in p)))
    print(f'stowed check: {len(bad)} of {total} gear vertices outside the hull at frame 0')
    for item in bad[:12]:
        print('   outside:', item)
    return len(bad)


def evaluated_tris(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    total, per = 0, {}
    for o in objs:
        if o.type != 'MESH':
            continue
        eo = o.evaluated_get(dg)
        me = eo.to_mesh()
        me.calc_loop_triangles()
        per[o.name] = len(me.loop_triangles)
        total += per[o.name]
        eo.to_mesh_clear()
    return total, per


def export(root):
    objs = [o for o in SCENE.objects]
    total, per = evaluated_tris(objs)
    print('TRIS total', total)
    for k, v in sorted(per.items(), key=lambda kv: -kv[1]):
        print(f'  {k:24s} {v}')
    if total > TRI_BUDGET:
        print(f'WARNING: over the {TRI_BUDGET} triangle budget')
    os.makedirs(os.path.dirname(OUT_RAW), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_RAW, export_format='GLB', export_apply=True, export_animations=True, export_yup=True,
        export_animation_mode='ACTIONS', export_merge_animation='ACTION', export_current_frame=True,
        export_force_sampling=True, export_frame_range=False, export_cameras=False, export_lights=False,
        export_materials='EXPORT', export_vertex_color='ACTIVE', export_texcoords=False, export_normals=True,
        export_extras=False, export_optimize_animation_size=True, use_selection=False)
    if shutil.which(GLTFPACK) or os.path.exists(GLTFPACK):
        cmd = [GLTFPACK, '-i', OUT_RAW, '-o', OUT_GLB, '-cc', '-kn', '-km', '-ke']
        print(' '.join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(r.stdout.strip(), r.stderr.strip())
    else:
        print('gltfpack not found; only the raw GLB was written')
    return total


if __name__ == '__main__':
    main()
