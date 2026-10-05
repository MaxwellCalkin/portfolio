"""
The Unfolding: landmark library B (Projects, Mission and Contact worlds).

Builds every landmark described in art/specs/LANDMARKS.md under "Projects", "Mission" and
"Contact" procedurally, then exports one GLB per world:

    art/build/landmarks-<world>.raw.glb      (Blender glTF export, node names cleaned)
    public/models/landmarks-<world>.glb      (gltfpack -cc -kn -km -kv -ke -vpf)
    art/build/landmarks-<world>.json         (QA manifest: triangles, sizes, children, problems)

-vpf (float positions, about 8% larger) keeps each named node's mesh on that node. Without it
gltfpack moves every mesh into an unnamed dequantization child, so a COL_* node would hold no
geometry of its own and loaders that hide or measure meshes by name would miss it. Unnamed
child nodes that remain under a landmark root are gltfpack's instancing of primitives shared
by several landmarks (e.g. the four principle lenses); they are part of that landmark's body.

Run headless (deterministic):

    /home/claude/blender/.venv/bin/python art/blender/landmarks_b.py
    /home/claude/blender/.venv/bin/python art/blender/landmarks_b.py --only mission
    /home/claude/blender/.venv/bin/python art/blender/landmarks_b.py --only projects --nodes build_log

--nodes builds are for QA only: they write art/build/landmarks-<world>-qa.glb and never touch
public/models. Layout QA (landmarks placed per game/world/layout.js, seen from the spawn):
art/build/landmarks-projects.lab.html?world=<world>&cam=spawn|over|x,y,z,tx,ty,tz, screenshot
with node art/build/landmarks-projects.lab-shot.mjs "<query>" out.png.

Contract (LANDMARKS.md):
  * One top-level node per landmark, named exactly as the spec (snake_case), origin at ground
    level at the footprint center. All roots sit at the GLB origin; the game places them.
  * Front faces -Y in Blender (+Z in glTF). Meters, +Z up. Bases go ~0.3 m below z = 0.
  * Material slots: Stone, StoneDark, Trim, Accent, Glow, Metal, Glass. Colors are defaults
    from the world palette (the game recolors by slot name).
  * Children: POI_<id> / LABEL_<id> empties, ANIM_SPIN_/ANIM_BOB_/ANIM_PULSE_ meshes with their
    origin at the pivot and an identity rotation (any tilt is baked into the mesh, so "spin
    about local up" is always world up), COL_BOX_/COL_CYL_ invisible proxies (axis-aligned box
    or vertical cylinder geometry, oriented by the node transform).
  * Several landmarks share child names (POI_read, LABEL_title, ...). Blender needs unique
    object names, so objects are named "<name>~<n>" and the suffix is stripped from the glTF
    JSON before gltfpack runs.

Shading: bevelled hard-surface parts, face-area weighted normals, flat-faceted crystals, and
COLOR_0 = baked AO x a soft vertical gradient. Parts are kit-bashed (they interpenetrate), so
the AO bake here (bake_ao_lm) lets rays pass through back faces: a vertex buried inside a
neighbouring part takes the occlusion of its open surroundings instead of going black and
smearing dark along long faces. Glow parts ignore AO.
"""

import argparse
import json
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402

TAU = math.tau
PI = math.pi
UP = Vector((0.0, 0.0, 1.0))
BUILD_DIR = os.path.join(C.REPO_ROOT, 'art', 'build')
# -vpf keeps positions as floats so every named node (COL_*, ANIM_*) holds its own mesh directly
# instead of an unnamed dequantization child; loaders can then hide / animate / measure by name.
PACK_ARGS = ('-cc', '-kn', '-km', '-kv', '-ke', '-vpf')

# ----------------------------------------------------------------------------
# Palettes (defaults only; the game swaps materials by slot name)
# ----------------------------------------------------------------------------

PALETTES = {
    'projects': {'Stone': '#8d7fbf', 'StoneDark': '#2c2742', 'Trim': '#e2b8ff', 'Accent': '#8fd9ff',
                 'Glow': '#e2b8ff', 'Glass': '#a68cf6', 'Metal': '#3d3557'},
    'mission': {'Stone': '#e9eef4', 'StoneDark': '#3b5f86', 'Trim': '#83e8ff', 'Accent': '#f0744e',
                'Glow': '#83e8ff', 'Glass': '#3d7fc4', 'Metal': '#4a5566'},
    'contact': {'Stone': '#e2c08f', 'StoneDark': '#7a4330', 'Trim': '#ffd27a', 'Accent': '#f0744e',
                'Glow': '#ffd27a', 'Glass': '#33505e', 'Metal': '#5a4636'},
}
SURFACE = {
    'Stone': dict(roughness=0.82), 'StoneDark': dict(roughness=0.86),
    'Trim': dict(roughness=0.38, metallic=0.35), 'Accent': dict(roughness=0.5),
    'Glow': dict(roughness=0.45, emission=2.4), 'Glass': dict(roughness=0.12, metallic=0.1),
    'Metal': dict(roughness=0.5, metallic=0.15),
}


def make_materials(world):
    for slot, hexcol in PALETTES[world].items():
        C.material(slot, color=hexcol, **SURFACE[slot])


# ----------------------------------------------------------------------------
# Naming
# ----------------------------------------------------------------------------

_serial = [0]


def uname(base):
    """Unique Blender name for a glTF node that must be called `base` (suffix stripped later)."""
    if bpy.data.objects.get(base) is None:
        return base
    _serial[0] += 1
    return f'{base}~{_serial[0]}'


def clean(name):
    return re.sub(r'~\d+$', '', name)


def _tmp():
    _serial[0] += 1
    return f'_part{_serial[0]}'


# ----------------------------------------------------------------------------
# Geometry helpers (all return Blender objects in world space, ready to join)
# ----------------------------------------------------------------------------

def mat4(loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), scale=None):
    m = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
    if scale is not None:
        s = (scale, scale, scale) if isinstance(scale, (int, float)) else scale
        m = m @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))
    return m


def part(bm, slot, smooth=True):
    if not smooth:
        for e in bm.edges:
            e.smooth = False
    return C.mesh_object(_tmp(), bm, slot, smooth=smooth)


def place(ob, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), scale=None, matrix=None):
    C.transform(ob, matrix if matrix is not None else mat4(loc, rot, scale))
    return ob


def bev(ob, width, seg=1, angle=35.0):
    if width > 0:
        C.bevel(ob, width, segments=seg, angle=angle)
    return ob


def sharpen(ob, angle=40.0):
    """Mark edges sharper than `angle` degrees as sharp (weighted normals keep them)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    lim = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            if e.link_faces[0].normal.angle(e.link_faces[1].normal, 0.0) > lim:
                e.smooth = False
        elif len(e.link_faces) != 2:
            e.smooth = False
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def box(size, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), slot='Stone', bevel=0.0, seg=1,
        taper=None):
    """Box of `size` centered at loc. taper=(sx, sy) scales the top face (a frustum)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        if taper is not None and v.co.z > 0:
            v.co.x *= taper[0]
            v.co.y *= taper[1]
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    ob = part(bm, slot)
    bev(ob, bevel, seg)
    return place(ob, loc, rot)


def boxz(x0, x1, y0, y1, z0, z1, slot='Stone', bevel=0.0, seg=1):
    """Axis-aligned box from bounds."""
    return box((x1 - x0, y1 - y0, z1 - z0), ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
               slot=slot, bevel=bevel, seg=seg)


def lathe(profile, sides=24, slot='Stone', loc=(0.0, 0.0, 0.0), bevel=0.0, seg=1, phase=0.0,
          smooth=True, sharp=40.0, cap_bottom=True, cap_top=True):
    bm, _ = C.lathe(profile, sides=sides, phase=phase, cap_bottom=cap_bottom, cap_top=cap_top)
    ob = part(bm, slot, smooth=smooth)
    if sharp:
        sharpen(ob, sharp)
    bev(ob, bevel, seg)
    return place(ob, loc)


def cyl(r, z0, z1, sides=24, slot='Stone', loc=(0.0, 0.0), bevel=0.0, seg=1, r_top=None,
        phase=0.0):
    rt = r if r_top is None else r_top
    return lathe([(r, z0), (rt, z1)], sides=sides, slot=slot, loc=(loc[0], loc[1], 0.0),
                 bevel=bevel, seg=seg, phase=phase)


def ngon(n, r, phase=0.0):
    return [(r * math.cos(phase + TAU * i / n), r * math.sin(phase + TAU * i / n)) for i in range(n)]


def rrect(w, h, r, n=3):
    """Rounded rectangle outline (CCW), w x h, corner radius r, n segments per corner."""
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    pts = []
    for cx, cy, a0 in ((w / 2 - r, -h / 2 + r, -PI / 2), (w / 2 - r, h / 2 - r, 0.0),
                       (-w / 2 + r, h / 2 - r, PI / 2), (-w / 2 + r, -h / 2 + r, PI)):
        for k in range(n + 1):
            a = a0 + (PI / 2) * k / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def rect(w, h):
    return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]


def chamfer_poly(poly, c):
    """Cut every corner of a CCW polygon by distance c (an octagon from a square, etc.)."""
    out = []
    n = len(poly)
    for i in range(n):
        p0, p1, p2 = Vector(poly[i - 1]), Vector(poly[i]), Vector(poly[(i + 1) % n])
        a = p1 + (p0 - p1).normalized() * c
        b = p1 + (p2 - p1).normalized() * c
        out += [(a.x, a.y), (b.x, b.y)]
    return out


def prism(poly, z0, z1, slot='Stone', chamfer=0.0, bevel=0.0, seg=1, matrix=None, smooth=True):
    bm, _ = C.prism(poly, z0, z1, chamfer=chamfer)
    ob = part(bm, slot, smooth=smooth)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def strata(poly, levels, slot='Stone', bevel=0.0, seg=1, matrix=None, center=None):
    bm, _ = C.extrude_profile(poly, levels, center=center)
    ob = part(bm, slot)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def arc_band(r_in, r_out, y0, y1, a0, a1, segs, slot='Stone', bevel=0.0, seg=1, matrix=None,
             caps=True, smooth=True):
    """Annular sector with a rectangular section, in the XZ plane (angle 0 = +X, PI/2 = +Z),
    extruded along Y from y0 to y1. A full ring when a1 - a0 == TAU (caps ignored)."""
    full = abs((a1 - a0) - TAU) < 1e-6
    n = segs if full else segs + 1
    bm = bmesh.new()
    rings = []
    for i in range(n):
        a = a0 + (a1 - a0) * i / segs
        c, s = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((r_in * c, y0, r_in * s)), bm.verts.new((r_out * c, y0, r_out * s)),
                      bm.verts.new((r_out * c, y1, r_out * s)), bm.verts.new((r_in * c, y1, r_in * s))])
    m = n if full else n - 1
    for i in range(m):
        A, B = rings[i], rings[(i + 1) % n]
        for k in range(4):
            kk = (k + 1) % 4
            bm.faces.new((A[k], A[kk], B[kk], B[k]))
    if not full and caps:
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = part(bm, slot, smooth=smooth)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def ring_xy(r_in, r_out, z0, z1, a0=0.0, a1=TAU, segs=48, slot='Stone', bevel=0.0, seg=1,
            matrix=None, caps=True):
    """Same as arc_band but lying flat (in the XY plane, extruded along Z)."""
    ob = arc_band(r_in, r_out, -z1, -z0, a0, a1, segs, slot=slot, bevel=bevel, seg=seg, caps=caps)
    place(ob, rot=(-PI / 2, 0.0, 0.0))    # (x, y, z) -> (x, z, -y): XZ arc -> XY, -Y extrusion -> +Z
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def tube(points, radii, sides=8, slot='Metal', cap=True, smooth=True, sharp=None):
    bm, _ = C.tube([Vector(p) for p in points], radii, sides=sides, cap_start=cap, cap_end=cap)
    ob = part(bm, slot, smooth=smooth)
    if sharp:
        sharpen(ob, sharp)
    return ob


def sweep_arc(radius, a0, a1, segs, r_tube, sides=8, slot='Glow', matrix=None, round_ends=True):
    """Round tube along an arc in the XZ plane, with hemispherical end caps (a neon stroke)."""
    pts = [Vector((radius * math.cos(a0 + (a1 - a0) * i / segs), 0.0,
                   radius * math.sin(a0 + (a1 - a0) * i / segs))) for i in range(segs + 1)]
    bm, rings = C.tube(pts, r_tube, sides=sides, cap_start=not round_ends, cap_end=not round_ends)
    ob = part(bm, slot)
    parts = [ob]
    if round_ends:
        for p in (pts[0], pts[-1]):
            s = part(C.icosphere(2, r_tube), slot)
            place(s, loc=p)
            parts.append(s)
        ob = C.join(parts, _tmp())
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def hull_bm(points):
    """Convex hull as a closed bmesh (common.convex_hull can list a vertex twice for deletion)."""
    bm = bmesh.new()
    verts = [bm.verts.new(Vector(p)) for p in points]
    res = bmesh.ops.convex_hull(bm, input=verts, use_existing_faces=False)
    junk = {g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert)}
    junk |= {v for v in bm.verts if not v.link_faces}
    if junk:
        bmesh.ops.delete(bm, geom=list(junk), context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def hull(points, slot='Glass', smooth=False, matrix=None):
    bm = hull_bm(points)
    ob = part(bm, slot, smooth=smooth)
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def crystal(height, radius, sides=6, tip=0.35, base_tip=0.0, rng=None, lean=(0.0, 0.0),
            twist=0.0, jitter=0.12, slot='Glass', loc=(0.0, 0.0, 0.0), bottom=None, shade=None):
    """Faceted crystal: an n-sided prism with a pyramidal tip (tip = fraction of height),
    optionally a bottom point. Flat shaded. Leans by (rx, ry) radians."""
    rng = rng or C.rng_for('crystal')
    pts = []
    body = height * (1.0 - tip)
    z_base = 0.0 if bottom is None else bottom
    for i in range(sides):
        a = twist + TAU * i / sides + rng.uniform(-0.12, 0.12)
        r = radius * (1.0 + rng.uniform(-jitter, jitter))
        pts.append((r * math.cos(a), r * math.sin(a), z_base))
        r2 = r * rng.uniform(0.86, 0.98)
        pts.append((r2 * math.cos(a + 0.05), r2 * math.sin(a + 0.05), body * rng.uniform(0.9, 1.0)))
    tipx, tipy = rng.uniform(-0.12, 0.12) * radius, rng.uniform(-0.12, 0.12) * radius
    pts.append((tipx, tipy, height))
    # a short ridge under the apex reads as a chisel cut rather than a perfect pyramid
    pts.append((tipx + radius * 0.18, tipy, height * 0.97))
    if base_tip:
        pts.append((0.0, 0.0, z_base - height * base_tip))
    ob = hull(pts, slot)
    if shade is not None:
        C.set_shade(ob, lambda co: C.lerp(shade, 1.0, C.clamp(co.z / height) ** 0.75))
    place(ob, rot=(lean[0], lean[1], 0.0))
    place(ob, loc=loc)
    return ob


def set_shade(ob, fn):
    C.set_shade(ob, fn)
    return ob


def glow_intent(ob):
    """Glow parts: full brightness, no AO."""
    C.set_shade(ob, lambda co: 1.0)
    C.set_ao_weight(ob, 0.0)
    return ob


def paint(ob, fn):
    """fn(center, normal) -> slot or None, per face."""
    C.paint_faces(ob, lambda p: fn(Vector(p.center), Vector(p.normal)))
    return ob


def join(parts, name=None):
    parts = [p for p in parts if p is not None]
    return C.join(parts, name or _tmp())


class Path:
    """A polyline with parallel-transport frames (tan, nor, bin) and arc length."""

    def __init__(self, pts, up=None):
        self.pts = [Vector(p) for p in pts]
        self.tan, self.nor, self.bin = C.frames(self.pts, up)
        self.s = [0.0]
        for a, b in zip(self.pts, self.pts[1:]):
            self.s.append(self.s[-1] + (b - a).length)

    @classmethod
    def bezier(cls, p0, p1, p2, p3, n, up=None):
        return cls(C.bezier_points(Vector(p0), Vector(p1), Vector(p2), Vector(p3), n), up)

    def u(self, i):
        return self.s[i] / self.s[-1]

    def frame(self, i):
        return self.pts[i], self.tan[i], self.nor[i], self.bin[i]


def sweep(path, section, slot='Stone', i0=0, i1=None, caps=True, bevel=0.0, seg=1, smooth=True):
    """Sweep a closed 2D section along a Path. section(u) -> [(n, b), ...] in the frame's
    (nor, bin) plane (u = arc-length parameter 0..1), or a fixed list."""
    i1 = len(path.pts) - 1 if i1 is None else i1
    bm = bmesh.new()
    rings = []
    for i in range(i0, i1 + 1):
        sec = section(path.u(i)) if callable(section) else section
        p, t, n, b = path.frame(i)
        rings.append([bm.verts.new(p + n * dn + b * db) for dn, db in sec])
    k = len(rings[0])
    for A, B in zip(rings, rings[1:]):
        for j in range(k):
            bm.faces.new((A[j], A[(j + 1) % k], B[(j + 1) % k], B[j]))
    if caps:
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = part(bm, slot, smooth=smooth)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    return ob


def rect_sec(hn, hb):
    return [(-hn, -hb), (hn, -hb), (hn, hb), (-hn, hb)]


def ring_poly(poly, width, z0, z1, slot='Trim', bevel=0.0, matrix=None):
    """A flat band following a closed CCW outline (outline inset by `width`), z0..z1."""
    outer = list(poly)
    inner = C.inset(outer, width)
    bm = bmesh.new()
    ob_, ot_, ib_, it_ = [[bm.verts.new((x, y, z)) for x, y in P]
                          for P, z in ((outer, z0), (outer, z1), (inner, z0), (inner, z1))]
    n = len(outer)
    for j in range(n):
        k = (j + 1) % n
        bm.faces.new((ob_[j], ob_[k], ot_[k], ot_[j]))
        bm.faces.new((it_[j], it_[k], ib_[k], ib_[j]))
        bm.faces.new((ot_[j], ot_[k], it_[k], it_[j]))
        bm.faces.new((ib_[j], ib_[k], ob_[k], ob_[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = part(bm, slot)
    sharpen(ob, 40.0)
    bev(ob, bevel)
    if matrix is not None:
        place(ob, matrix=matrix)
    return ob


def hex_radial(n=6, phase=0.0):
    """lathe radial() that turns a round profile into a regular n-gon (r = circumradius)."""
    half = PI / n

    def fn(i, j, a):
        return math.cos(half) / math.cos(((a - phase) % (2 * half)) - half)
    return fn


def poly_lathe(profile, n=6, sides=24, slot='Stone', phase=0.0, bevel=0.0, seg=1, cap_bottom=True,
               cap_top=True):
    """Lathe whose rings are regular n-gons (sides must be a multiple of n)."""
    bm, _ = C.lathe(profile, sides=sides, phase=phase, radial=hex_radial(n, phase),
                    cap_bottom=cap_bottom, cap_top=cap_top)
    ob = part(bm, slot)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    return ob


def ring_sweep(radius, section, a0=0.0, a1=TAU, segs=48, slot='Trim', bevel=0.0, seg=1, center=(0, 0, 0),
               smooth=True):
    """Sweep a 2D section (dr, dy) around an arc in the XZ plane (angle 0 = +X, PI/2 = +Z).
    section(u) may vary along the arc (u = 0..1). A full circle closes on itself."""
    full = abs((a1 - a0) - TAU) < 1e-6
    n = segs if full else segs + 1
    cen = Vector(center)
    bm = bmesh.new()
    rings = []
    for i in range(n):
        u = i / segs
        a = a0 + (a1 - a0) * u
        rd = Vector((math.cos(a), 0.0, math.sin(a)))
        sec = section(u) if callable(section) else section
        rings.append([bm.verts.new(cen + rd * (radius + dr) + Vector((0.0, dy, 0.0))) for dr, dy in sec])
    k = len(rings[0])
    for i in range(n if full else n - 1):
        A, B = rings[i], rings[(i + 1) % n]
        for j in range(k):
            bm.faces.new((A[j], A[(j + 1) % k], B[(j + 1) % k], B[j]))
    if not full:
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = part(bm, slot, smooth=smooth)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    return ob


def plate_xz(poly, t, slot='Stone', bevel=0.0, seg=1, chamfer=0.0):
    """A CCW outline drawn in the XZ plane (x, z), extruded +-t along Y."""
    bm, _ = C.prism(poly, -t, t, chamfer=chamfer)
    ob = part(bm, slot)
    sharpen(ob, 40.0)
    bev(ob, bevel, seg)
    return place(ob, rot=(PI / 2, 0.0, 0.0))


def disc_y(r, y0, y1, sides=24, slot='Trim', bevel=0.0, center=(0, 0, 0), r1=None):
    """Cylinder along the Y axis (a disc facing -Y), from y0 to y1."""
    ob = lathe([(r, y0), (r if r1 is None else r1, y1)], sides, slot, bevel=bevel)
    place(ob, rot=(-PI / 2, 0.0, 0.0))     # (x, y, z) -> (x, z, -y): the lathe axis +Z becomes +Y
    return place(ob, loc=center)


def lathe_angles(profile, angles, slot='Stone', smooth=True):
    """Surface of revolution sampled at explicit angles (closed loop). Profile entries with
    r == 0 at either end become poles. Each face gets an int attribute 'col' = its column."""
    bm = bmesh.new()
    prof = list(profile)
    start_pole = prof.pop(0)[1] if prof[0][0] <= 1e-9 else None
    end_pole = prof.pop()[1] if prof[-1][0] <= 1e-9 else None
    n = len(angles)
    col = bm.faces.layers.int.new('col')
    rings = [[bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for a in angles] for r, z in prof]
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))[col] = j
    if start_pole is not None:
        pv = bm.verts.new((0.0, 0.0, start_pole))
        for j in range(n):
            bm.faces.new((rings[0][(j + 1) % n], rings[0][j], pv))[col] = j
    if end_pole is not None:
        pv = bm.verts.new((0.0, 0.0, end_pole))
        for j in range(n):
            bm.faces.new((rings[-1][j], rings[-1][(j + 1) % n], pv))[col] = j
    return part(bm, slot, smooth=smooth)


# ----------------------------------------------------------------------------
# Finalize: like common.finalize, but the AO rays pass through back faces
# ----------------------------------------------------------------------------

from mathutils.bvhtree import BVHTree  # noqa: E402

_HEMI = {}


def bake_ao_lm(ob, distance, samples=48, ground=True, ground_z=0.0, smooth=1):
    """Per-vertex AO for kit-bashed hard surfaces.

    Parts interpenetrate (a shaft sunk into a collar), so many vertices sit inside another
    closed part. A ray that starts inside a part first meets that part's back faces; those
    hits are skipped instead of counted, so buried vertices take the occlusion of the open
    surroundings and long faces no longer smear black from their buried ends.
    """
    me = ob.data
    cos = [v.co.copy() for v in me.vertices]
    tree = BVHTree.FromPolygons(cos, [tuple(p.vertices) for p in me.polygons])
    dirs = _HEMI.setdefault(samples, C._hemisphere(samples))
    eps = distance * 0.004 + 2e-4
    vals = []
    for i, co in enumerate(cos):
        n = Vector(me.vertex_normals[i].vector)
        if n.length_squared < 1e-12:
            n = UP.copy()
        if ground and co.z < ground_z - 1e-4:
            vals.append(0.0)
            continue
        rot = n.to_track_quat('Z', 'Y').to_matrix()
        o0 = co + n * eps
        occ = 0.0
        for d in dirs:
            w = rot @ d
            t_hit = None
            o, travelled = o0, 0.0
            for _ in range(6):
                hit = tree.ray_cast(o, w, distance - travelled)
                if hit[0] is None:
                    break
                if hit[1].dot(w) > 0.0:          # back face: leaving a part we started in
                    travelled += hit[3] + 1e-4
                    o = hit[0] + w * 1e-4
                    continue
                t_hit = travelled + hit[3]
                break
            if ground and w.z < -1e-6:
                tg = (ground_z - o0.z) / w.z
                if 0.0 <= tg <= distance and (t_hit is None or tg < t_hit):
                    t_hit = tg
            if t_hit is not None:
                occ += 1.0 - (t_hit / distance) ** 2
        vals.append(1.0 - occ / len(dirs))
    if smooth:
        nb = C.vertex_neighbors(me)
        for _ in range(smooth):
            vals = [0.5 * v + 0.5 * (sum(vals[j] for j in nb[i]) / len(nb[i]) if nb[i] else v)
                    for i, v in enumerate(vals)]
    return vals


def finalize_lm(ob, ao=None, weighted=True):
    """common.finalize with bake_ao_lm (weighted normals, COLOR_0 = AO x shade)."""
    C.apply_transform(ob)
    C.ensure_intent(ob)
    me = ob.data
    if weighted:
        C.weighted_normals(ob)
        C.apply_modifiers(ob)
        loops = [Vector(cn.vector) for cn in ob.data.corner_normals]
        tri = C._triangulate_keep_normals(ob, loops)
        me = ob.data
        me.normals_split_custom_set([tuple(n) for n in tri])
    else:
        C.triangulate(ob)
        C.bake_normals(ob)
    me = ob.data
    shade = [d.value for d in me.attributes['shade'].data]
    aow = [d.value for d in me.attributes['aow'].data]
    if ao is not None:
        opts = dict(ao)
        floor = opts.pop('floor', 0.35)
        gamma = opts.pop('gamma', 1.0)
        raw = bake_ao_lm(ob, **opts)
        vals = [s * C.lerp(1.0, C.lerp(floor, 1.0, C.clamp(a) ** gamma), w) for s, w, a in zip(shade, aow, raw)]
    else:
        vals = shade
    C.write_vertex_colors(ob, vals)
    for name in C.INTENT:
        a = me.attributes.get(name)
        if a is not None:
            me.attributes.remove(a)
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    me.update()
    return C.stats(ob)


# ----------------------------------------------------------------------------
# Landmark assembly
# ----------------------------------------------------------------------------

class Landmark:
    """Collects the static body, animated parts, empties and colliders of one landmark."""

    def __init__(self, name, budget=15000):
        self.name = name
        self.budget = budget
        self.parts = []
        self.anims = []        # (name, [objects], pivot, ao)
        self.empties = []      # (name, loc)
        self.colliders = []    # (kind, name, center, size, rot_z)
        self.root = None
        self.objects = []
        self.ao = dict(distance=3.0, samples=48, floor=0.4)
        self.gradient = None   # (z0, z1, v0) vertical shade gradient on the body

    def add(self, *obs):
        for ob in obs:
            if isinstance(ob, (list, tuple)):
                self.parts.extend(ob)
            elif ob is not None:
                self.parts.append(ob)
        return obs[0] if len(obs) == 1 else obs

    def anim(self, name, objs, pivot, ao=None, parent=None):
        self.anims.append(dict(name=name, objs=list(objs), pivot=Vector(pivot), ao=ao, parent=parent))

    def poi(self, pid, loc):
        self.empties.append(('POI_' + pid, Vector(loc)))

    def label(self, lid, loc):
        self.empties.append(('LABEL_' + lid, Vector(loc)))

    def empty(self, name, loc):
        self.empties.append((name, Vector(loc)))

    def col_box(self, cname, center, size, rot_z=0.0):
        self.colliders.append(('BOX', cname, Vector(center), Vector(size), rot_z))

    def col_cyl(self, cname, center_xy, radius, z0, z1):
        c = Vector((center_xy[0], center_xy[1], (z0 + z1) / 2))
        self.colliders.append(('CYL', cname, c, Vector((radius * 2, radius * 2, z1 - z0)), 0.0))

    # -- build ---------------------------------------------------------------
    def build(self):
        body = join(self.parts, uname(self.name))
        if self.gradient:
            z0, z1, v0 = self.gradient
            shade = C.gradient(z0, z1, v0, 1.0, 0.8)
            # multiply into existing shade (glow parts keep 1.0 because aow 0 / shade set later)
            me = body.data
            sh = me.attributes['shade']
            aw = me.attributes['aow']
            for v in me.vertices:
                if aw.data[v.index].value > 0.0:
                    sh.data[v.index].value *= shade(v.co)
        info = finalize_lm(body, ao=self.ao)
        self.root = body
        self.objects = [body]
        tris = info['triangles']
        made = {}
        for a in self.anims:
            if a['objs']:
                ob = join(a['objs'], uname(a['name']))
                ao = a['ao'] if a['ao'] is not None else dict(self.ao, distance=self.ao['distance'] * 0.6)
                info = finalize_lm(ob, ao=ao)
                tris += info['triangles']
                ob.data.transform(Matrix.Translation(-a['pivot']))
                ob.data.update()
            else:                                   # mesh-less pivot (e.g. a bob around a spin)
                ob = bpy.data.objects.new(uname(a['name']), None)
                ob.empty_display_type = 'PLAIN_AXES'
                C.link(ob)
            parent, ppos = (body, Vector())
            if a['parent']:
                parent, ppos = made[a['parent']]
            ob.parent = parent
            ob.location = a['pivot'] - ppos
            made[a['name']] = (ob, a['pivot'])
            self.objects.append(ob)
        for name, loc in self.empties:
            e = bpy.data.objects.new(uname(name), None)
            e.empty_display_type = 'PLAIN_AXES'
            C.link(e)
            e.parent = body
            e.location = loc
            self.objects.append(e)
        for kind, cname, center, size, rot_z in self.colliders:
            if kind == 'BOX':
                bm = bmesh.new()
                bmesh.ops.create_cube(bm, size=1.0)
                bmesh.ops.scale(bm, vec=size, verts=bm.verts)
                prefix = 'COL_BOX_'
            else:
                bm, _ = C.lathe([(size.x / 2, -size.z / 2), (size.x / 2, size.z / 2)], sides=16)
                prefix = 'COL_CYL_'
            me = bpy.data.meshes.new(prefix + cname)
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new(uname(prefix + cname), me)
            C.link(ob)
            ob.parent = body
            ob.location = center
            ob.rotation_euler = (0.0, 0.0, rot_z)
            self.objects.append(ob)
        if tris > self.budget:
            raise RuntimeError(f'{self.name}: {tris} triangles exceeds budget {self.budget}')
        self.tris = tris
        return self


# ----------------------------------------------------------------------------
# Export, name cleanup and verification
# ----------------------------------------------------------------------------

def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, length = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67, 'not a GLB'
    off = 12
    chunks = []
    while off < length:
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        chunks.append([ctype, data[off + 8:off + 8 + clen]])
        off += 8 + clen
    js = json.loads(chunks[0][1].decode('utf-8'))
    return js, chunks


def write_glb(path, js, chunks):
    raw = json.dumps(js, separators=(',', ':')).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ctype, cdata in chunks:
        pad = (4 - len(cdata) % 4) % 4
        cdata = cdata + (b' ' if ctype == 0x4E4F534A else b'\x00') * pad
        body += struct.pack('<II', len(cdata), ctype) + cdata
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def clean_glb_names(path):
    js, chunks = read_glb(path)
    for key in ('nodes', 'meshes'):
        for item in js.get(key, []):
            if 'name' in item:
                item['name'] = clean(item['name'])
    write_glb(path, js, chunks)


def glb_report(path):
    """Per top-level node: named descendants, from the packed GLB JSON."""
    js, _ = read_glb(path)
    nodes = js['nodes']
    out = {}

    def walk(i, acc):
        n = nodes[i]
        if 'name' in n:
            acc.append(n['name'])
        for c in n.get('children', []):
            walk(c, acc)
    for r in js['scenes'][0]['nodes']:
        acc = []
        for c in nodes[r].get('children', []):
            walk(c, acc)
        out[nodes[r].get('name', '?')] = acc
    mats = sorted(m.get('name', '?') for m in js.get('materials', []))
    return out, mats


def export_world(world, landmarks, pack=True, qa=False):
    """Full builds go to public/models; partial (--nodes) QA builds go to art/build/*-qa.glb so a
    partial export can never replace the shipped file."""
    os.makedirs(BUILD_DIR, exist_ok=True)
    tag = f'landmarks-{world}-qa' if qa else f'landmarks-{world}'
    raw = os.path.join(BUILD_DIR, f'{tag}.raw.glb')
    out = os.path.join(BUILD_DIR if qa else C.MODELS_DIR, f'{tag}.glb')
    objs = [o for lm in landmarks for o in lm.objects]
    C.export_glb(raw, objs)
    clean_glb_names(raw)
    manifest = {'world': world, 'landmarks': {}}
    bpy.context.view_layer.update()
    for lm in landmarks:
        # visual bounds: the body plus every animated mesh, in world space (colliders excluded)
        lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
        for ob in lm.objects:
            if ob.type != 'MESH' or clean(ob.name).startswith('COL_'):
                continue
            mw = ob.matrix_world
            for v in ob.data.vertices:
                w = mw @ v.co
                lo = Vector(map(min, lo, w))
                hi = Vector(map(max, hi, w))
        size = hi - lo
        manifest['landmarks'][lm.name] = {
            'triangles': lm.tris,
            'size': [round(size.x, 2), round(size.y, 2), round(size.z, 2)],
            'bounds_min': [round(c, 2) for c in lo],
            'bounds_max': [round(c, 2) for c in hi],
            'height': round(hi.z, 2),
            'children': sorted(clean(o.name) for o in lm.objects[1:]),
        }
    if pack:
        C.gltfpack(raw, out, PACK_ARGS)
        report, mats = glb_report(out)
        problems = []
        for lm in landmarks:
            want = sorted(clean(o.name) for o in lm.objects[1:])
            have = sorted(report.get(lm.name, []))
            missing = [n for n in want if n not in have]
            if lm.name not in report:
                problems.append(f'{lm.name}: missing top-level node')
            if missing:
                problems.append(f'{lm.name}: missing {missing}')
        manifest['materials'] = mats
        manifest['bytes'] = os.path.getsize(out)
        manifest['problems'] = problems
        print(f'[{world}] {out}: {os.path.getsize(out)} bytes, materials {mats}')
        for p in problems:
            print('  PROBLEM', p)
    C.write_json(os.path.join(BUILD_DIR, f'{tag}.json'), manifest)
    for name, m in manifest['landmarks'].items():
        print(f"  {name:28s} {m['triangles']:6d} tris  size {m['size']}  height {m['height']}  {m['children']}")
    return manifest


# ============================================================================
# PROJECTS: violet crystal frontier, a maker's workshop
# ============================================================================

def hex_poly(r, phase=0.0):
    return ngon(6, r, phase)


def is_chamfer(n, lo=0.25, hi=0.97):
    return lo < n.z < hi


def holo_ring(radius, height, thick, dashes, gap, z, tilt=(0.0, 0.0), slot='Glow', ticks=0,
              tick_len=0.25):
    """Segmented holographic ring lying flat around (0, 0, z), tilted by (rx, ry)."""
    parts = []
    step = TAU / dashes
    for i in range(dashes):
        a0 = i * step + gap / 2
        a1 = (i + 1) * step - gap / 2
        segs = max(2, int(24 * (a1 - a0) / TAU * 4))
        parts.append(ring_xy(radius - thick / 2, radius + thick / 2, -height / 2, height / 2, a0, a1, segs,
                             slot=slot))
    for i in range(ticks):
        a = TAU * (i + 0.5) / ticks
        c, s = math.cos(a), math.sin(a)
        t = box((tick_len, thick * 0.8, height * 0.45), loc=((radius + thick / 2 + tick_len / 2) * c,
                                                              (radius + thick / 2 + tick_len / 2) * s, 0.0),
                rot=(0.0, 0.0, a), slot=slot)
        parts.append(t)
    ob = join(parts)
    place(ob, rot=(tilt[0], tilt[1], 0.0))
    place(ob, loc=(0.0, 0.0, z))
    return glow_intent(ob)


def build_workshop_core():
    L = Landmark('workshop_core', budget=25000)
    L.ao = dict(distance=4.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 10.0, 0.8)
    core_z = 7.2

    # --- stepped hex platform (flat side to the front), deck rings for AO resolution ---
    t1 = poly_lathe([(9.6, -0.3), (9.6, 0.23), (9.52, 0.30), (8.95, 0.30)], slot='StoneDark', bevel=0.025)
    t2 = poly_lathe([(8.9, 0.0), (8.9, 0.57), (8.81, 0.65), (8.3, 0.65)], slot='Stone', bevel=0.025)
    deck = poly_lathe([(8.2, 0.3), (8.2, 0.95), (8.09, 1.05), (7.3, 1.05), (6.45, 1.05), (5.2, 1.05),
                       (4.0, 1.05), (3.55, 1.05), (2.6, 1.05)], slot='Stone', bevel=0.025)
    for ob in (t1, t2, deck):
        paint(ob, lambda c, n: 'Trim' if is_chamfer(n) else None)
    # the work floor inside the trim hex reads a shade deeper; a dark ring hugs the dais
    set_shade(deck, lambda co: 0.86 if co.xy.length < 6.5 and co.z > 1.0 else 1.0)
    paint(deck, lambda c, n: 'StoneDark' if n.z > 0.9 and c.xy.length < 3.6 else None)
    L.add(t1, t2, deck)
    L.add(ring_poly(hex_poly(6.62), 0.2, 1.0, 1.075, 'Trim', bevel=0.012))

    # six energy conduits run from the pylons into the dais
    for i in range(6):
        a = TAU * i / 6
        c, s_ = math.cos(a), math.sin(a)
        r0, r1 = 2.7, 6.45
        mid = (r0 + r1) / 2
        L.add(glow_intent(box((r1 - r0, 0.14, 0.05), loc=(mid * c, mid * s_, 1.06), rot=(0, 0, a), slot='Glow')))
        for side in (-1, 1):
            off = Vector((-s_, c, 0.0)) * 0.19 * side
            L.add(box((r1 - r0, 0.12, 0.12), loc=(mid * c + off.x, mid * s_ + off.y, 1.07), rot=(0, 0, a),
                      slot='Metal', bevel=0.025))

    # central dais: a stepped drum with a glowing emitter ring and a glass lens
    L.add(lathe([(2.95, 0.9), (2.95, 1.30), (2.86, 1.39), (2.05, 1.39), (2.05, 1.33)], 48, 'StoneDark',
                bevel=0.02, cap_top=False))
    L.add(glow_intent(lathe([(2.05, 1.33), (1.68, 1.33)], 48, 'Glow', cap_bottom=False, cap_top=False, sharp=None)))
    L.add(lathe([(1.68, 1.25), (1.68, 1.5), (1.56, 1.58), (1.3, 1.58)], 48, 'Trim', bevel=0.012, cap_top=False))
    L.add(lathe([(1.3, 1.52), (1.3, 1.6), (0.7, 1.66), (0.0, 1.68)], 48, 'Glass', sharp=None))
    for side in (0, 1, 2):                   # three emitter studs on the drum lip
        a = TAU * side / 3 + PI / 2
        L.add(box((0.5, 0.32, 0.16), loc=(2.5 * math.cos(a), 2.5 * math.sin(a), 1.44), rot=(0, 0, a),
                  slot='Trim', bevel=0.03))

    # --- six crown tines rising from the hex corners and hooking in over the core ---
    lift = {0: 0.25, 1: 0.9, 2: 0.65, 3: 0.0, 4: -0.55, 5: -0.35}    # azimuths 0,60,..: back = 60/120
    for i in range(6):
        a = TAU * i / 6
        L.add(*tine(a, 7.35, core_z, i, lift[i]))
        c, s_ = math.cos(a), math.sin(a)
        L.col_box(f'pylon_{i}', (7.35 * c, 7.35 * s_, 1.05 + 3.6), (1.2, 1.2, 7.2), rot_z=a)

    # front gate lanterns flanking the approach
    for side in (-1, 1):
        x = 3.1 * side
        L.add(strata(chamfer_poly(rect(0.8, 0.8), 0.18), [(-0.3, 1, 0), (0.25, 1, 0)], 'StoneDark', bevel=0.03,
                     matrix=mat4((x, -9.15, 0))))
        L.add(strata(chamfer_poly(rect(0.66, 0.66), 0.15), [(0.2, 1, 0), (1.15, 0.9, 0), (1.22, 0.9, 0.05)],
                     'Stone', bevel=0.03, matrix=mat4((x, -9.15, 0))))
        L.add(strata(chamfer_poly(rect(0.56, 0.56), 0.12), [(1.2, 1, 0), (1.32, 1, 0)], 'Trim',
                     bevel=0.015, matrix=mat4((x, -9.15, 0))))
        L.add(glow_intent(crystal(0.75, 0.2, sides=6, tip=0.42, rng=C.rng_for('gate', side), slot='Glow',
                                  loc=(x, -9.15, 1.3))))
        L.col_box(f'gate_{"L" if side < 0 else "R"}', (x, -9.15, 0.6), (0.62, 0.62, 1.8))

    # two maker's workbenches on the work floor, facing the core
    for k, a_deg in enumerate((210, 330)):
        a = math.radians(a_deg)
        L.add(*workbench(a, 4.95, k))
        L.col_box(f'bench_{k}', (4.95 * math.cos(a), 4.95 * math.sin(a), 1.5), (0.9, 1.9, 0.9), rot_z=a)

    # --- floating core (bob > spin) and the holographic ring ---
    L.anim('ANIM_BOB_core', [], (0.0, 0.0, core_z))
    L.anim('ANIM_SPIN_core', core_crystal(core_z), (0.0, 0.0, core_z), parent='ANIM_BOB_core')
    ring = [holo_ring(4.0, 0.24, 0.08, 18, 0.06, core_z, tilt=(0.15, 0.06)),
            holo_ring(4.45, 0.1, 0.05, 3, 0.55, core_z, tilt=(0.15, 0.06), ticks=30, tick_len=0.16)]
    L.anim('ANIM_SPIN_ring', ring, (0.0, 0.0, core_z))

    L.poi('archive', (0.0, -10.6, 0.0))
    L.label('title', (0.0, -2.5, 12.4))
    L.col_cyl('tier_0', (0, 0), 8.8, -0.3, 0.3)
    L.col_cyl('tier_1', (0, 0), 8.1, 0.3, 0.65)
    L.col_cyl('deck', (0, 0), 7.4, 0.65, 1.05)
    L.col_cyl('dais', (0, 0), 2.85, 1.05, 1.39)
    return L


def workbench(a, r, idx):
    """A sturdy maker's bench (top toward the core): slab, legs, a holo projector with a part
    floating over it, a small articulated arm and a parts bin."""
    M = Matrix.Translation(Vector((r * math.cos(a), r * math.sin(a), 1.05))) @ Matrix.Rotation(a + PI, 4, 'Z')
    parts = []
    for y in (-0.72, 0.72):
        parts.append(box((0.62, 0.14, 0.8), loc=(0.0, y, 0.4), slot='Metal', bevel=0.02))
    parts.append(box((0.5, 1.3, 0.1), loc=(0.05, 0.0, 0.22), slot='Metal', bevel=0.015))
    parts.append(paint(box((0.86, 1.95, 0.12), loc=(0.0, 0.0, 0.86), slot='Stone', bevel=0.025),
                       lambda c, n: 'Trim' if n.z < 0.95 and n.z > 0.2 else None))
    parts.append(box((0.88, 1.97, 0.04), loc=(0.0, 0.0, 0.8), slot='Trim'))
    # holo projector disc and a hovering part (a small faceted gem being cut)
    parts.append(cyl(0.22, 0.92, 0.98, 16, 'Trim', loc=(0.08, -0.4), bevel=0.01))
    parts.append(glow_intent(cyl(0.16, 0.98, 1.0, 16, 'Glow', loc=(0.08, -0.4))))
    parts.append(crystal(0.34, 0.1, sides=5, tip=0.45, base_tip=0.45, rng=C.rng_for('bench_gem', idx), slot='Glass',
                         loc=(0.08, -0.4, 1.2)))
    # articulated arm with a glowing tool tip
    j0, j1, j2 = Vector((-0.28, 0.55, 0.92)), Vector((-0.2, 0.42, 1.45)), Vector((0.05, 0.05, 1.32))
    parts.append(cyl(0.11, 0.92, 1.0, 10, 'Metal', loc=(j0.x, j0.y), bevel=0.01))
    parts.append(tube([j0, j1], 0.045, sides=8, slot='Metal'))
    parts.append(tube([j1, j2], 0.04, sides=8, slot='Metal'))
    parts.append(place(part(C.icosphere(1, 0.07), 'Trim'), loc=j1))
    parts.append(glow_intent(place(part(C.icosphere(1, 0.05), 'Glow'), loc=j2)))
    # parts bin on the shelf
    parts.append(box((0.42, 0.5, 0.2), loc=(0.05, 0.25, 0.37), slot='StoneDark', bevel=0.02))
    for p_ in parts:
        place(p_, matrix=M)
    return parts


def tine(a, r, core_z, idx, lift=0.0):
    """A crown tine: footing + plinth on a hex corner, then a swept blade that rises and hooks
    in over the core, a glow channel up its inner face and an emitter aimed at the core."""
    c, s_ = math.cos(a), math.sin(a)
    out = Vector((c, s_, 0.0))
    base = out * r
    M = Matrix.Translation(base) @ Matrix.Rotation(a + PI, 4, 'Z')    # local +X -> center
    parts = []
    parts.append(strata(chamfer_poly(rect(1.6, 1.6), 0.3), [(0.7, 1, 0), (1.6, 1, 0), (1.7, 1, 0.08)],
                        'Metal', bevel=0.03, matrix=M))
    parts.append(strata(chamfer_poly(rect(1.12, 1.0), 0.18), [(1.6, 1, 0), (2.55, 0.94, 0), (2.62, 0.94, 0.05)],
                        'Stone', bevel=0.03, matrix=M))
    parts.append(strata(chamfer_poly(rect(1.2, 1.08), 0.2), [(2.5, 1, 0), (2.72, 1, 0)], 'Trim',
                        bevel=0.02, matrix=M))
    # power cell window on the plinth's inner face
    parts.append(glow_intent(place(box((0.06, 0.42, 0.5), loc=(0.555, 0.0, 2.05), slot='Glow'), matrix=M)))

    def P(rr, z):
        return out * rr + Vector((0, 0, z))
    path = Path.bezier(P(r, 2.6), P(r, 6.6 + lift * 0.6), P(r - 0.1, 11.0 + lift), P(r - 1.75, 10.35 + lift * 0.8), 22, up=-out)
    hw = lambda u: C.lerp(0.36, 0.2, u ** 1.3)                           # noqa: E731
    hd = lambda u: C.lerp(0.44, 0.24, u ** 1.2)                          # noqa: E731

    def blade(u):
        w, d = hw(u), hd(u)
        nw, nd = 0.085, 0.07
        return [(-d, -w), (d, -w), (d, -nw), (d - nd, -nw), (d - nd, nw), (d, nw), (d, w), (-d, w)]
    parts.append(sweep(path, blade, 'Stone', bevel=0.02))
    # glow channel in the notch (inner face), 1 cm proud of the notch floor
    def chan(u):
        d = hd(u)
        return [(d - 0.07, -0.07), (d - 0.012, -0.07), (d - 0.012, 0.07), (d - 0.07, 0.07)]
    parts.append(glow_intent(sweep(path, chan, 'Glow', i0=1, i1=len(path.pts) - 2)))
    # trim collars along the blade
    for i, slot in ((5, 'Trim'), (12, 'Accent')):
        pnt, t, n, b = path.frame(i)
        u = path.u(i)
        w, d = hw(u) + 0.05, hd(u) + 0.05
        cp = Path([pnt - t * 0.14, pnt + t * 0.14], up=n)
        parts.append(sweep(cp, rect_sec(d, w), slot, bevel=0.015))
    # emitter at the hook tip, aimed at the core
    pnt, t, n, b = path.frame(len(path.pts) - 1)
    aim = (Vector((0.0, 0.0, core_z)) - pnt).normalized()
    tip = crystal(0.9, 0.17, sides=6, tip=0.5, base_tip=0.3, rng=C.rng_for('tine_tip', idx), slot='Glow')
    place(tip, matrix=C.align_z(aim, pnt + t * 0.05))
    parts.append(glow_intent(tip))
    return parts


def core_crystal(core_z):
    """The floating workshop core: a tall cut gem (crown and pavilion facets) with a glowing
    girdle, plus three small shards orbiting with it."""
    n = 6
    r = 1.75

    def ring(rr, z, phase):
        return [(rr * math.cos(TAU * i / n + phase), rr * math.sin(TAU * i / n + phase), z) for i in range(n)]
    g_lo, g_hi = ring(r, -0.4, PI / 6), ring(r, 0.5, PI / 6)
    crown = ring(1.42, 1.45, PI / 6 + PI / n) + ring(0.82, 2.55, PI / 6) + [(0.06, -0.05, 3.45)]
    pavilion = ring(1.3, -1.3, PI / 6 + PI / n) + ring(0.6, -2.2, PI / 6) + [(0.0, 0.04, -2.95)]
    upper = hull(g_hi + crown, 'Glass')
    lower = hull(g_lo + pavilion, 'Glass')
    band = hull(g_lo + g_hi, 'Glow')
    place(band, scale=(0.965, 0.965, 1.0))
    glow_intent(band)
    parts = [upper, lower, band]
    for k in range(3):
        a = TAU * k / 3 + 0.4
        z = (1.2, -0.7, 0.2)[k]
        sh = crystal(1.0 + 0.25 * k, 0.24, sides=5, tip=0.45, base_tip=0.45, rng=C.rng_for('orbit', k), slot='Glass')
        place(sh, rot=(0.3 * (k - 1), 0.25, 0.0))
        place(sh, loc=(2.75 * math.cos(a), 2.75 * math.sin(a), z))
        parts.append(sh)
    for p_ in parts:
        place(p_, loc=(0.0, 0.0, core_z))
    return parts


def front_phase(n):
    """ngon() phase that puts a flat side facing the front (-Y)."""
    return math.radians((270.0 - 180.0 / n) % (360.0 / n))


def crystal_dir(height, radius, direction, base, sides=6, tip=0.3, rng=None, slot='Glass', base_tip=0.0,
                jitter=0.12, twist=0.0, shade=None):
    """A crystal growing from `base` along `direction`."""
    ob = crystal(height, radius, sides=sides, tip=tip, rng=rng, slot=slot, base_tip=base_tip, jitter=jitter,
                 twist=twist, shade=shade)
    return place(ob, matrix=C.align_z(Vector(direction), Vector(base)))


# ---------------------------------------------------------------- project_beacn

def build_project_beacn():
    L = Landmark('project_beacn')
    L.ao = dict(distance=3.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 11.0, 0.8)
    ph8 = front_phase(8)
    p1 = strata(ngon(8, 3.15, ph8), [(-0.3, 1, 0), (0.24, 1, 0), (0.32, 1, 0.08)], 'StoneDark', bevel=0.025)
    p2 = strata(ngon(8, 2.45, ph8), [(0.1, 1, 0), (0.56, 1, 0), (0.65, 1, 0.09)], 'Stone', bevel=0.025)
    for ob in (p1, p2):
        paint(ob, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(p1, p2, ring_poly(ngon(8, 1.95, ph8), 0.14, 0.6, 0.675, 'Trim', bevel=0.01))
    # three concave buttress fins (none points at the visitor)
    prof = [(0.3, 0.5), (2.12, 0.5), (2.12, 0.95)]
    for i in range(1, 12):
        t = i / 12
        prof.append((0.52 + 1.55 * (1 - t) ** 2, 1.0 + 4.1 * t))
    prof += [(0.52, 5.1), (0.3, 5.1)]
    for k, a_deg in enumerate((90, 210, 330)):
        a = math.radians(a_deg)
        fin = plate_xz(prof, 0.16, 'Stone', bevel=0.035)
        paint(fin, lambda c, n: 'Trim' if n.z > 0.25 and n.x > 0.1 else None)
        L.add(place(fin, rot=(0, 0, a)))
        L.col_box(f'fin_{k}', (1.2 * math.cos(a), 1.2 * math.sin(a), 1.25), (1.7, 0.28, 1.5), rot_z=a)

    # tapered octagonal shaft, notched up the front for a glow seam
    yf = -0.62 * math.cos(PI / 8)
    sec = ngon(8, 0.62, PI / 8)
    shaft_sec = sec[:6] + [(-0.075, yf), (-0.075, yf + 0.065), (0.075, yf + 0.065), (0.075, yf)] + sec[6:]
    z0, z1, k1 = 0.5, 9.5, 0.64
    kz = lambda z: 1.0 + (k1 - 1.0) * (z - z0) / (z1 - z0)                     # noqa: E731
    L.add(strata(shaft_sec, [(z0, 1.0, 0), (z1, k1, 0)], 'Stone', bevel=0.02, center=(0, 0)))
    seam = [(-0.06, yf + 0.012), (0.06, yf + 0.012), (0.06, yf + 0.06), (-0.06, yf + 0.06)]
    L.add(glow_intent(strata(seam, [(1.0, kz(1.0), 0), (9.2, kz(9.2), 0)], 'Glow', center=(0, 0))))
    for z in (2.6, 4.6, 8.4):
        L.add(strata(ngon(8, 0.62 * kz(z) * 1.13, PI / 8), [(z - 0.12, 1, 0), (z + 0.12, 1, 0)], 'Trim', bevel=0.015))
    # the gyro node: a service housing with a floating guide ring on three spokes
    zn = 6.5
    rn = 0.62 * kz(zn)
    L.add(strata(ngon(8, rn * 1.32, PI / 8), [(zn - 0.55, 0.8, 0), (zn - 0.38, 1, 0), (zn + 0.38, 1, 0), (zn + 0.55, 0.8, 0)],
                 'Stone', bevel=0.02))
    L.add(strata(ngon(8, rn * 1.36, PI / 8), [(zn - 0.06, 1, 0), (zn + 0.06, 1, 0)], 'Trim', bevel=0.01))
    for k in range(4):
        a = PI / 4 + k * PI / 2
        L.add(glow_intent(box((0.03, 0.16, 0.42), loc=((rn * 1.32 * 0.924 + 0.005) * math.cos(a + PI / 8 - PI / 8),
                                                       (rn * 1.32 * 0.924 + 0.005) * math.sin(a), zn),
                              rot=(0, 0, a), slot='Glow')))
    L.add(ring_xy(1.25, 1.4, zn - 0.09, zn + 0.09, segs=48, slot='Trim', bevel=0.015))
    for a_deg in (90, 210, 330):
        a = math.radians(a_deg)
        L.add(box((0.5, 0.1, 0.1), loc=(1.05 * math.cos(a), 1.05 * math.sin(a), zn), rot=(0, 0, a), slot='Metal',
                  bevel=0.015))
    # crown: a cup with a glowing emitter and three prongs cradling the emblem's sweep
    L.add(lathe([(0.38, 9.3), (0.44, 9.5), (0.8, 9.82), (0.86, 9.92), (0.8, 9.98), (0.66, 9.98), (0.62, 9.92)], 40,
                'Trim', bevel=0.012, cap_top=False))
    L.add(glow_intent(lathe([(0.62, 9.92), (0.0, 9.96)], 40, 'Glow', cap_bottom=False, sharp=None)))
    for k, a_deg in enumerate((90, 210, 330)):
        a = math.radians(a_deg)
        out = Vector((math.cos(a), math.sin(a), 0.0))
        P = lambda r, z, out=out: out * r + Vector((0, 0, z))                  # noqa: E731
        path = Path.bezier(P(0.4, 9.15), P(1.0, 9.35), P(1.62, 9.9), P(1.72, 10.75), 12, up=Vector((0, 0, 1)))
        L.add(sweep(path, lambda u: rect_sec(C.lerp(0.13, 0.08, u), C.lerp(0.12, 0.07, u)), 'Trim', bevel=0.012))
        tp, tt, _, _ = path.frame(len(path.pts) - 1)
        L.add(glow_intent(lathe([(0.0, -0.02), (0.1, 0.06), (0.0, 0.2)], 10, 'Glow', sharp=None, loc=tuple(tp))))

    # the emblem: an outer ring and two inner arcs, glowing strokes on lilac backplates
    zc = 13.15
    cen = Vector((0.0, 0.0, zc))
    T = Matrix.Translation(cen)
    em = []
    Ro, Ri = 2.42, 1.86
    circ = [(0.17 * math.cos(TAU * i / 10), 0.17 * math.sin(TAU * i / 10)) for i in range(10)]
    em.append(glow_intent(ring_sweep(Ro, circ, segs=72, slot='Glow', center=cen)))
    em.append(ring_sweep(Ro, rect_sec(0.27, 0.05), segs=72, slot='Trim', bevel=0.012, center=cen + Vector((0, 0.13, 0))))
    for a0, a1 in ((math.radians(20), math.radians(160)), (math.radians(200), math.radians(340))):
        em.append(glow_intent(sweep_arc(Ri, a0, a1, 28, 0.15, sides=10, slot='Glow', matrix=T)))
        em.append(ring_sweep(Ri, rect_sec(0.22, 0.045), a0, a1, 28, slot='Trim', bevel=0.01,
                             center=cen + Vector((0, 0.11, 0))))
    L.anim('ANIM_SPIN_emblem', em, cen)

    L.poi('read', (0.0, -3.9, 0.0))
    L.label('title', (0.0, -1.0, 17.1))
    L.col_cyl('plinth_0', (0, 0), 2.95, -0.3, 0.32)
    L.col_cyl('plinth_1', (0, 0), 2.3, 0.32, 0.65)
    L.col_cyl('shaft', (0, 0), 0.52, 0.65, 9.9)
    return L


# ---------------------------------------------------------------- project_heard

def build_project_heard():
    L = Landmark('project_heard')
    L.ao = dict(distance=3.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 10.0, 0.82)
    px = -2.6
    S = Vector((px + 0.75, 0.0, 6.5))
    pl = strata([(x + 0.3, y) for x, y in rrect(9.6, 3.9, 1.3, 4)], [(-0.3, 1, 0), (0.33, 1, 0), (0.44, 1, 0.09)],
                'StoneDark', bevel=0.03)
    paint(pl, lambda c, n: 'Accent' if is_chamfer(n) else None)
    L.add(pl)
    # a stepped pedestal under the pillar
    L.add(paint(strata([(x + px, y) for x, y in chamfer_poly(rect(2.5, 2.3), 0.35)], [(0.3, 1, 0), (0.78, 1, 0), (0.86, 1, 0.07)],
                       'StoneDark', bevel=0.025), lambda c, n: 'Accent' if is_chamfer(n) else None))
    # ground echo: gold arcs inlaid in the plinth, spreading the same way as the voice
    for r in (2.0, 2.95, 3.9, 4.85):
        span = min(math.radians(56), math.asin(min(1.0, 1.5 / r)))
        L.add(place(ring_xy(r - 0.065, r + 0.065, 0.42, 0.465, -span, span, segs=max(6, int(r * 4)), slot='Accent'),
                    loc=(px, 0, 0)))
    # the pillar: a faceted navy monolith (flat front), gold seam, gold bands and a gold crown
    ctr = (px, 0.0)
    hexs = [(x * 0.82 + px, y * 0.68) for x, y in ngon(6, 0.9, 0.0)]       # flat faces front and back
    L.add(strata(hexs, [(0.8, 1.0, 0), (9.45, 0.74, 0), (9.55, 0.74, 0.05)], 'StoneDark', bevel=0.03, center=ctr))
    kz = lambda z: 1.0 - 0.26 * (z - 0.8) / 8.65                               # noqa: E731
    yf = -0.9 * 0.68 * math.cos(PI / 6)
    for vx, vy in (hexs[4], hexs[5], hexs[0], hexs[3]):      # the four corners that face the visitor's arc
        q = [(vx + dx, vy + dy) for dx, dy in rect(0.09, 0.09)]
        L.add(strata(q, [(1.2, kz(1.2), 0), (8.6, kz(8.6), 0)], 'Accent', center=ctr, bevel=0.01))
    for z in (1.15, 8.75, 9.1):
        L.add(strata([(x * 1.05 * kz(z) + px * (1 - 1.05 * kz(z)), y * 1.05 * kz(z)) for x, y in hexs],
                     [(z - 0.09, 1, 0), (z + 0.09, 1, 0)], 'Accent', bevel=0.012))
    L.add(strata([(x * 0.8 + px * 0.2, y * 0.8) for x, y in hexs], [(9.5, 0.9, 0), (9.72, 0.9, 0), (10.3, 0.12, 0.0)],
                 'Accent', bevel=0.02, center=ctr))
    # the voice: a speaker cone on the pillar's flank (gold rim, navy cone, ridges, glowing dust cap)
    cone = [lathe([(0.78, -0.25), (0.78, 0.16), (0.7, 0.24), (0.6, 0.24)], 40, 'Accent', bevel=0.015, cap_top=False),
            lathe([(0.6, 0.24), (0.6, 0.18), (0.22, 0.02), (0.0, 0.0)], 40, 'StoneDark', cap_bottom=False, sharp=None),
            ring_xy(0.4, 0.46, 0.07, 0.13, segs=40, slot='Accent'),
            glow_intent(lathe([(0.2, 0.0), (0.2, 0.06), (0.0, 0.16)], 20, 'Glow', sharp=None))]
    for b in cone:
        place(b, rot=(0.0, PI / 2, 0.0))
        place(b, loc=(S.x - 0.1, 0.0, S.z))
        L.add(b)
    # five sound waves: gold crescents, each with a navy echo just behind and outside it
    for k in range(5):
        r = 1.45 + 1.02 * k
        h = math.radians(56 - 5.5 * k)
        t0 = 0.2 - 0.018 * k
        d0 = 0.26 - 0.025 * k
        gold = lambda u, t0=t0, d0=d0: rect_sec(t0 * (0.28 + 0.72 * math.sin(PI * u)), d0)        # noqa: E731
        navy = lambda u, t0=t0, d0=d0: [(dr + 0.06, dy + d0 + 0.08) for dr, dy in
                                        rect_sec(t0 * (0.28 + 0.72 * math.sin(PI * u)) + 0.04, 0.09)]  # noqa: E731
        L.add(ring_sweep(r, gold, -h, h, 16 + 3 * k, slot='Accent', bevel=0.02, center=S))
        L.add(ring_sweep(r, navy, -h * 0.97, h * 0.97, 16 + 3 * k, slot='StoneDark', bevel=0.015, center=S))

    L.poi('read', (0.0, -3.2, 0.0))
    L.label('title', (0.4, -1.2, 11.6))
    L.col_box('plinth', (0.3, 0.0, 0.07), (9.2, 3.5, 0.74))
    L.col_box('pedestal', (px, 0.0, 0.45), (2.3, 2.1, 0.8))
    L.col_box('pillar', (px, 0.0, 5.0), (1.2, 0.9, 9.4))
    return L


# ---------------------------------------------------------------- project crystals

def crystal_base(L, sides=8, r=1.7, accent=True):
    ph = front_phase(sides)
    f = strata(ngon(sides, r + 0.3, ph), [(-0.3, 1, 0), (0.18, 1, 0), (0.25, 1, 0.06)], 'StoneDark', bevel=0.02)
    b = strata(ngon(sides, r, ph), [(0.2, 1, 0), (0.78, 0.93, 0), (0.86, 0.93, 0.06)], 'Metal', bevel=0.02)
    paint(b, lambda c, n: 'Trim' if is_chamfer(n) else None)
    col = strata(ngon(sides, r * 0.74, ph), [(0.8, 1, 0), (0.98, 1, 0), (1.02, 1, 0.03)], 'Trim', bevel=0.015)
    L.add(f, b, col)
    ap = r * math.cos(PI / sides) * 0.965
    for k in range(sides):
        if k % 2:
            continue
        a = ph + (k + 0.5) * TAU / sides
        L.add(box((0.035, 0.16, 0.34), loc=((ap + 0.006) * math.cos(a), (ap + 0.006) * math.sin(a), 0.5),
                  rot=(0, 0, a), slot='Accent' if accent else 'Glow', bevel=0.008))
    L.add(glow_intent(ring_xy(r * 0.5, r * 0.6, 0.99, 1.045, segs=sides * 4, slot='Glow')))
    L.col_cyl('base', (0, 0), r * 0.98, -0.3, 1.0)
    return 1.02


def crystal_ring(L, radius, z, tilt, dashes=10, ticks=20):
    L.anim('ANIM_SPIN_ring', [holo_ring(radius, 0.17, 0.06, dashes, 0.1, z, tilt=tilt),
                              holo_ring(radius + 0.24, 0.06, 0.035, 2, 0.9, z, tilt=tilt, ticks=ticks, tick_len=0.12)],
           (0.0, 0.0, z))


def crystal_landmark(name):
    L = Landmark(name)
    L.ao = dict(distance=2.6, samples=48, floor=0.45)
    L.gradient = (-0.3, 3.0, 0.8)
    return L


def build_project_crystal_0():
    """A single tall shard (alignment-evals)."""
    L = crystal_landmark('project_crystal_0')
    top = crystal_base(L, 8, 1.65)
    rng = C.rng_for('project_crystal_0')
    L.add(crystal(6.7, 0.74, sides=6, tip=0.22, rng=rng, slot='Glass', loc=(0.0, 0.0, top - 0.25), lean=(0.04, 0.05), shade=0.5))
    for k, (az, h, tl) in enumerate(((0.7, 1.5, 0.5), (2.6, 1.15, 0.6), (4.4, 1.8, 0.45))):
        L.add(crystal_dir(h, 0.22, (math.sin(tl) * math.cos(az), math.sin(tl) * math.sin(az), math.cos(tl)),
                          (0.55 * math.cos(az), 0.55 * math.sin(az), top - 0.15), sides=5, tip=0.35,
                          rng=C.rng_for('c0_side', k), shade=0.55))
    crystal_ring(L, 1.5, 3.9, (0.22, 0.08))
    L.poi('read', (0.0, -2.9, 0.0))
    L.label('title', (0.0, -0.6, 8.9))
    L.col_box('shard', (0.0, 0.0, 4.2), (1.0, 1.0, 6.4))
    return L


def build_project_crystal_1():
    """A twin shard (alignment-probes)."""
    L = crystal_landmark('project_crystal_1')
    top = crystal_base(L, 8, 1.65)
    L.add(crystal(6.4, 0.62, sides=6, tip=0.24, rng=C.rng_for('c1a'), loc=(0.22, 0.05, top - 0.25), lean=(0.03, 0.2), shade=0.5))
    L.add(crystal(5.1, 0.54, sides=6, tip=0.26, rng=C.rng_for('c1b'), loc=(-0.22, -0.05, top - 0.25),
                  lean=(-0.05, -0.27), shade=0.5))
    L.add(crystal_dir(1.3, 0.2, (0.2, -0.6, 0.78), (0.1, -0.45, top - 0.1), sides=5, tip=0.35, rng=C.rng_for('c1c'),
                      shade=0.55))
    crystal_ring(L, 1.75, 3.5, (0.2, -0.12))
    L.poi('read', (0.0, -2.9, 0.0))
    L.label('title', (0.0, -0.6, 8.6))
    L.col_box('shards', (0.0, 0.0, 3.8), (2.2, 1.0, 5.6))
    return L


def build_project_crystal_2():
    """A cluster (interpretability-toolkit)."""
    L = crystal_landmark('project_crystal_2')
    top = crystal_base(L, 8, 1.8)
    L.add(crystal(5.9, 0.62, sides=6, tip=0.24, rng=C.rng_for('c2'), loc=(0.0, 0.1, top - 0.25), lean=(0.03, -0.03), shade=0.5))
    rng = C.rng_for('c2_sat')
    sats = ((0.35, 3.8, 0.42), (1.3, 2.6, 0.36), (2.2, 3.2, 0.4), (3.2, 2.1, 0.3), (4.1, 2.9, 0.36), (5.2, 2.3, 0.33),
            (5.85, 1.6, 0.26))
    for k, (az, h, rr) in enumerate(sats):
        tl = 0.32 + 0.32 * (1.0 - h / 4.0) + rng.uniform(-0.05, 0.05)
        d = (math.sin(tl) * math.cos(az), math.sin(tl) * math.sin(az), math.cos(tl))
        L.add(crystal_dir(h, rr, d, (0.62 * math.cos(az), 0.62 * math.sin(az), top - 0.2), sides=6, tip=0.3,
                          rng=C.rng_for('c2s', k), shade=0.5))
    crystal_ring(L, 2.05, 3.3, (0.24, 0.1), dashes=12)
    L.poi('read', (0.0, -3.0, 0.0))
    L.label('title', (0.0, -0.6, 8.2))
    L.col_box('cluster', (0.0, 0.0, 3.0), (2.6, 2.6, 4.2))
    return L


def geode_half(side, rx=1.55, ry=1.3, rz=2.75, zc=3.85):
    """One half of a split geode: a faceted dark rock shell, a pale agate rim, glassy cavity
    walls and a glowing cavity floor, lined with crystals that grow toward the other half.
    side = +1 keeps x > 0."""
    rng = C.rng_for('geode_rock')
    pts = []
    n = 90
    golden = PI * (3.0 - math.sqrt(5.0))
    for i in range(n):
        zz = 1.0 - 2.0 * (i + 0.5) / n
        rad = math.sqrt(max(0.0, 1.0 - zz * zz))
        th = i * golden
        k = 1.0 + rng.uniform(-0.06, 0.07)
        taper = 1.0 - 0.22 * max(0.0, zz)            # an egg: narrower toward the top
        pts.append(Vector((rad * math.cos(th) * rx * k * taper, rad * math.sin(th) * ry * k * taper, zz * rz * k + zc)))
    bm = hull_bm(pts)
    caps = C.chisel(bm, (0.0, 0.0, 0.0), (-side, 0.0, 0.0))
    bmesh.ops.delete(bm, geom=caps, context='FACES_ONLY')
    # walk the open boundary loop
    bnd = [e for e in bm.edges if e.is_boundary]
    nxt = {}
    for e in bnd:
        a, b = e.verts
        nxt.setdefault(a, []).append(b)
        nxt.setdefault(b, []).append(a)
    loop = [bnd[0].verts[0]]
    prev = None
    while True:
        cands = [v for v in nxt[loop[-1]] if v is not prev]
        if not cands or cands[0] is loop[0]:
            break
        prev = loop[-1]
        loop.append(cands[0])
    c = sum((v.co for v in loop), Vector()) / len(loop)
    depth = Vector((side * 0.5, 0.0, 0.0))
    p1 = [bm.verts.new(c + (v.co - c) * 0.8) for v in loop]
    p2 = [bm.verts.new(c + (v.co - c) * 0.6 + depth) for v in loop]
    m = len(loop)
    kind = bm.faces.layers.int.new('kind')
    for f in bm.faces:
        f[kind] = 0
    for i in range(m):
        j = (i + 1) % m
        bm.faces.new((loop[i], loop[j], p1[j], p1[i]))[kind] = 1          # agate rim
        bm.faces.new((p1[i], p1[j], p2[j], p2[i]))[kind] = 2              # glassy walls
    bm.faces.new(p2)[kind] = 3                                              # glowing floor
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob_tmp = part(bm, 'StoneDark', smooth=False)
    me = ob_tmp.data
    slots = {1: C.slot_index(ob_tmp, 'Stone'), 2: C.slot_index(ob_tmp, 'Glass'), 3: C.slot_index(ob_tmp, 'Glow')}
    kv = me.attributes['kind']
    for poly in me.polygons:
        k = kv.data[poly.index].value
        if k:
            poly.material_index = slots[k]
    me.attributes.remove(kv)
    parts = [ob_tmp]
    rng2 = C.rng_for('geode_xtal', 1 if side > 0 else 2)
    fc = c + depth
    for k in range(18):
        zz = rng2.uniform(-1.0, 1.0)
        yy = rng2.uniform(-1.0, 1.0)
        off = Vector((0.0, yy * 0.55 * ry, zz * 0.62 * rz))
        h = rng2.uniform(0.35, 0.75)
        d = Vector((-side, yy * 0.45, zz * 0.45)).normalized()
        parts.append(crystal_dir(h, rng2.uniform(0.09, 0.16), d, fc + off * 0.85 + Vector((-side * 0.04, 0, 0)), sides=5,
                                 tip=0.45, rng=C.rng_for('gx', k + (0 if side > 0 else 50)),
                                 slot='Glow' if k % 5 == 0 else 'Glass', shade=0.85))
    return join(parts)


def build_project_crystal_3():
    """A split geode (prompt-injection-benchmark)."""
    L = crystal_landmark('project_crystal_3')
    top = crystal_base(L, 8, 1.95)
    for side in (1, -1):
        half = geode_half(side, zc=top + 2.55)
        piv = Vector((0.0, 1.0, 0.0))
        M = Matrix.Translation(piv) @ Matrix.Rotation(side * math.radians(24), 4, 'Z') @ Matrix.Translation(-piv)
        place(half, matrix=Matrix.Translation((side * 0.22, 0.0, -0.05)) @ M)
        L.add(half)
    gem = crystal(1.3, 0.32, sides=6, tip=0.42, base_tip=0.42, rng=C.rng_for('geode_gem'), slot='Glow',
                  loc=(0.0, -0.25, top + 2.0))
    L.anim('ANIM_BOB_gem', [glow_intent(gem)], (0.0, -0.25, top + 2.55))
    crystal_ring(L, 2.65, 3.4, (0.2, 0.06), dashes=12, ticks=24)
    L.poi('read', (0.0, -3.1, 0.0))
    L.label('title', (0.0, -0.8, 7.9))
    L.col_box('half_L', (-1.0, 0.1, 3.4), (1.5, 2.2, 4.8), rot_z=-0.42)
    L.col_box('half_R', (1.0, 0.1, 3.4), (1.5, 2.2, 4.8), rot_z=0.42)
    return L


def build_project_crystal_4():
    """A stacked prism (llm-circuit-visualizer): tapered crystal layers on glowing joints, with
    one circuit trace running up the front through every layer."""
    L = crystal_landmark('project_crystal_4')
    top = crystal_base(L, 6, 1.6)
    z = top - 0.05
    layers = ((1.05, 1.3), (0.95, 1.15), (0.86, 1.05), (0.76, 0.95))
    trace = []
    for k, (r, h) in enumerate(layers):
        ph = (0.18, -0.12, 0.22, -0.06)[k]
        sl = strata(ngon(6, r, ph), [(z, 0.9, 0.0), (z + 0.12, 1.0, 0), (z + h - 0.16, 0.95, 0), (z + h, 0.78, 0.0)],
                    'Glass', bevel=0.015)
        C.set_shade(sl, lambda co, z=z, h=h, k=k: C.lerp(0.55 + 0.1 * k, 0.8 + 0.06 * k, C.clamp((co.z - z) / h)))
        L.add(sl)
        # the trace crosses the front-most face of this layer
        fa = ph + (math.floor((1.5 * PI - ph) / (PI / 3)) + 0.5) * (PI / 3)
        ap = r * math.cos(PI / 6) * 0.97
        nrm = Vector((math.cos(fa), math.sin(fa), 0.0))
        trace.append((nrm * (ap + 0.015), z + 0.15, z + h - 0.2, fa))
        z += h
        if k < len(layers) - 1:
            L.add(glow_intent(strata(ngon(6, r * 0.72, ph + 0.5), [(z - 0.03, 1, 0), (z + 0.2, 1, 0)], 'Glow')))
            z += 0.17
    L.add(crystal(1.75, 0.62, sides=6, tip=0.72, rng=C.rng_for('c4_tip'), loc=(0.0, 0.0, z - 0.1), jitter=0.04,
                  twist=0.3, shade=0.75))
    for i, (pos, z0, z1, fa) in enumerate(trace):
        x_off = Vector((-math.sin(fa), math.cos(fa), 0.0)) * (0.14 if i % 2 else -0.14)
        L.add(glow_intent(box((0.03, 0.06, z1 - z0), loc=pos + x_off + Vector((0, 0, (z0 + z1) / 2)), rot=(0, 0, fa),
                              slot='Glow')))
        L.add(glow_intent(box((0.05, 0.16, 0.16), loc=pos + x_off + Vector((0, 0, z1)), rot=(0, 0, fa), slot='Glow')))
    crystal_ring(L, 1.7, 4.2, (0.28, -0.1))
    L.poi('read', (0.0, -2.8, 0.0))
    L.label('title', (0.0, -0.6, 9.4))
    L.col_cyl('stack', (0, 0), 0.9, 1.0, 7.0)
    return L


# ---------------------------------------------------------------- build_log

def build_build_log():
    L = Landmark('build_log')
    L.ao = dict(distance=1.6, samples=48, floor=0.45)
    L.gradient = (-0.3, 2.5, 0.8)
    pad = poly_lathe([(1.8, -0.3), (1.8, 0.07), (1.72, 0.14), (1.2, 0.14), (0.6, 0.14)], slot='StoneDark', bevel=0.015)
    paint(pad, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(pad, ring_poly(hex_poly(1.42), 0.07, 0.12, 0.165, 'Trim'))
    # pedestal and sloped console deck
    L.add(strata(chamfer_poly(rect(0.92, 0.6), 0.08), [(0.1, 1, 0), (0.9, 0.95, 0)], 'Stone', bevel=0.02,
                 matrix=mat4((0, 0.02, 0))))
    deck = hull([(-0.55, -0.42, 0.86), (0.55, -0.42, 0.86), (-0.55, -0.42, 0.95), (0.55, -0.42, 0.95),
                 (-0.55, 0.3, 1.2), (0.55, 0.3, 1.2), (-0.55, 0.32, 0.86), (0.55, 0.32, 0.86)], 'Stone', smooth=True)
    L.add(paint(bev(deck, 0.02), lambda c, n: 'Trim' if n.z > 0.85 and c.y < -0.35 else None))
    tilt = math.atan2(0.25, 0.72)
    L.add(box((0.86, 0.5, 0.03), loc=(0.0, -0.05, 1.085), rot=(tilt, 0, 0), slot='Glass', bevel=0.008))
    for i in range(4):
        L.add(glow_intent(box((0.16, 0.06, 0.02), loc=(-0.3 + 0.2 * i, -0.33, 0.985 + 0.0), rot=(tilt, 0, 0),
                              slot='Glow')))
    # back pillar with a glow strip and an antenna
    L.add(strata(chamfer_poly(rect(0.62, 0.38), 0.07), [(0.85, 1, 0), (2.0, 0.92, 0), (2.05, 0.92, 0.035)], 'Stone',
                 bevel=0.02, matrix=mat4((0, 0.36, 0))))
    L.add(glow_intent(box((0.08, 0.03, 0.8), loc=(0.0, 0.36 - 0.18, 1.55), slot='Glow')))
    L.add(strata(chamfer_poly(rect(0.7, 0.46), 0.08), [(2.0, 1, 0), (2.12, 1, 0)], 'Trim', bevel=0.015,
                 matrix=mat4((0, 0.36, 0))))
    L.add(cyl(0.035, 2.1, 2.75, 8, 'Metal', loc=(0.2, 0.42)))
    L.add(glow_intent(lathe([(0.0, 2.7), (0.07, 2.76), (0.0, 2.84)], 10, 'Glow', sharp=None, loc=(0.2, 0.42, 0))))
    # floating holo screen
    screen = []
    W, H = 1.5, 0.9
    screen.append(box((W, 0.03, H), slot='StoneDark', bevel=0.008))
    fw = 0.05
    for (sx, sz, w_, h_) in ((0, H / 2, W + fw, fw), (0, -H / 2, W + fw, fw), (W / 2, 0, fw, H), (-W / 2, 0, fw, H)):
        screen.append(glow_intent(box((w_, 0.05, h_), loc=(sx, 0, sz), slot='Glow')))
    for i, ln in enumerate((0.9, 0.62, 1.1, 0.45, 0.8)):
        screen.append(glow_intent(box((ln, 0.012, 0.045), loc=(-W / 2 + 0.12 + ln / 2, -0.02, H / 2 - 0.16 - i * 0.14),
                                      slot='Glow')))
    pivot = Vector((0.0, -0.08, 1.95))
    for ob in screen:
        place(ob, rot=(-0.2, 0, 0))
        place(ob, loc=pivot)
    L.anim('ANIM_BOB_screen', screen, pivot)
    # a parts crate wired to the kiosk
    L.add(box((0.7, 0.55, 0.5), loc=(1.05, 0.45, 0.39), rot=(0, 0, 0.25), slot='Metal', bevel=0.03))
    L.add(box((0.74, 0.59, 0.07), loc=(1.05, 0.45, 0.5), rot=(0, 0, 0.25), slot='Trim', bevel=0.015))
    L.add(tube([(0.47, 0.15, 0.3), (0.62, 0.22, 0.17), (0.75, 0.3, 0.17), (0.8, 0.36, 0.32)], 0.035, sides=6,
               slot='Metal'))
    L.poi('read', (0.0, -1.8, 0.0))
    L.label('title', (0.0, -0.3, 3.3))
    L.col_cyl('pad', (0, 0), 1.6, -0.3, 0.14)
    L.col_box('kiosk', (0.0, 0.08, 1.07), (0.95, 0.85, 1.85))
    L.col_box('crate', (1.05, 0.45, 0.39), (0.66, 0.5, 0.5), rot_z=0.25)
    return L


# ============================================================================
# MISSION: azure ocean world, an observatory at the edge
# ============================================================================

def slit_dome(R, zc, az, half_w, elev0, past, thick, sides=56, rings=16, slot='Stone'):
    """Hemispherical dome shell (thickness inward) opened by a straight-edged slit that faces
    azimuth `az`, runs from elevation `elev0` over the zenith to `past` beyond it."""
    d = Vector((math.cos(az), math.sin(az), 0.0))
    n = Vector((-math.sin(az), math.cos(az), 0.0))
    prof = [(R * math.cos(PI / 2 * i / rings), zc + R * math.sin(PI / 2 * i / rings)) for i in range(rings)]
    prof.append((0.0, zc + R))
    bm, _ = C.lathe(prof, sides=sides, cap_bottom=False)
    C0 = Vector((0.0, 0.0, zc))
    z_start = R * math.sin(elev0)
    for co, no in ((C0 + n * half_w, n), (C0 - n * half_w, n), (C0 + Vector((0, 0, z_start)), UP), (C0 - d * past, d)):
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no, dist=1e-5)
    doomed = []
    for f in bm.faces:
        c = f.calc_center_median() - C0
        if abs(c.dot(n)) < half_w - 1e-4 and c.dot(d) > -past + 1e-4 and c.z > z_start + 1e-4:
            doomed.append(f)
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    ob = part(bm, slot)
    C.modifier(ob, 'SOLIDIFY', thickness=thick, offset=-1.0, use_rim=True, use_even_offset=True)
    sharpen(ob, 50.0)
    bev(ob, 0.03, 1, angle=50.0)
    return ob


def slit_rail(R, zc, az, off, elev0, past, sec, slot='Metal', segs=24):
    """An arched shutter rail running along one slit edge, just outside the dome."""
    d = Vector((math.cos(az), math.sin(az), 0.0))
    n = Vector((-math.sin(az), math.cos(az), 0.0))
    rr = math.sqrt(max(0.1, R * R - off * off))
    t1 = PI - math.acos(max(-1.0, min(1.0, past / rr)))
    t0 = math.asin(min(1.0, R * math.sin(elev0) / rr))
    pts = [Vector((0, 0, zc)) + n * off + d * (rr * math.cos(t)) + UP * (rr * math.sin(t))
           for t in [t0 + (t1 - t0) * i / segs for i in range(segs + 1)]]
    path = Path(pts, up=n)
    return sweep(path, sec, slot, bevel=0.015)


def build_observatory():
    L = Landmark('observatory', budget=25000)
    L.ao = dict(distance=4.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 14.0, 0.82)
    # --- plinth, drum and cornice ---
    p1 = lathe([(7.05, -0.3), (7.05, 0.33), (6.97, 0.4), (6.6, 0.4)], 64, 'StoneDark', bevel=0.025)
    p2 = lathe([(6.6, 0.2), (6.6, 0.73), (6.52, 0.8), (6.1, 0.8)], 64, 'Stone', bevel=0.025)
    paint(p2, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(p1, p2)
    L.add(lathe([(6.12, 0.75), (6.12, 1.55), (6.04, 1.65), (5.98, 1.65)], 64, 'StoneDark', bevel=0.02, cap_top=False))
    L.add(lathe([(6.0, 1.6), (6.0, 5.55), (0.0, 5.55)], 64, 'Stone', sharp=40.0))
    L.add(lathe([(6.0, 5.4), (6.18, 5.48), (6.32, 5.62), (6.32, 5.86), (6.0, 5.9)], 64, 'Stone', bevel=0.02))
    L.add(glow_intent(lathe([(6.07, 5.3), (6.07, 5.4)], 64, 'Glow', cap_bottom=False, cap_top=False, sharp=None)))
    # pilasters and tall windows around the drum (skipping the door and the lighthouse junction)
    for k in range(16):
        a = TAU * k / 16 + TAU / 32
        deg = math.degrees(a) % 360
        if 245 < deg < 295 or 145 < deg < 215:
            continue
        c, s_ = math.cos(a), math.sin(a)
        L.add(box((0.32, 0.5, 3.75), loc=(6.08 * c, 6.08 * s_, 3.5), rot=(0, 0, a), slot='Stone', bevel=0.04))
    for k in range(16):
        a = TAU * k / 16
        deg = math.degrees(a) % 360
        if 240 < deg < 300 or 140 < deg < 220:
            continue
        c, s_ = math.cos(a), math.sin(a)
        M = Matrix.Translation((6.0 * c, 6.0 * s_, 0.0)) @ Matrix.Rotation(a - PI / 2, 4, 'Z')
        win = [box((0.62, 0.12, 1.5), loc=(0, -0.01, 3.25), slot='StoneDark', bevel=0.02),
               box((0.44, 0.1, 1.3), loc=(0, -0.045, 3.2), slot='Glass', bevel=0.01),
               box((0.74, 0.18, 0.12), loc=(0, -0.03, 2.48), slot='Trim', bevel=0.02)]
        for w in win:
            L.add(place(w, matrix=M @ Matrix.Rotation(PI, 4, 'Z')))

    # --- the slit dome, its shutter rails and the telescope ---
    zc = 5.86
    R = 5.75
    az = math.radians(26)
    hw = 1.32
    L.add(slit_dome(R, zc, az, hw, math.radians(14), 1.6, 0.24))
    for off in (hw + 0.16, -(hw + 0.16)):
        L.add(slit_rail(R + 0.06, zc, az, off, math.radians(14), 1.45, rect_sec(0.12, 0.13), slot='StoneDark'))
    L.add(lathe([(5.95, 5.5), (5.95, 5.9), (0.0, 5.9)], 48, 'StoneDark'))          # observing floor
    L.add(lathe([(5.86, 5.84), (5.86, 6.12), (5.8, 6.2), (5.7, 6.2)], 64, 'StoneDark', bevel=0.012, cap_top=False))
    dn = Vector((-math.sin(az), math.cos(az), 0.0))
    for k in range(12):
        ra = az + TAU * (k + 0.5) / 12
        rd = Vector((math.cos(ra), math.sin(ra), 0.0))
        if abs(rd.dot(dn)) * R < hw + 0.6 and rd.dot(Vector((math.cos(az), math.sin(az), 0))) > 0:
            continue                                   # no rib across the slit
        top = 1.12 if abs(rd.dot(dn)) * R > hw + 0.6 else 0.8
        pts = [Vector((0, 0, zc)) + (rd * math.cos(t) + UP * math.sin(t)) * (R + 0.02)
               for t in [0.06 + (top - 0.06) * i / 10 for i in range(11)]]
        L.add(sweep(Path(pts, up=UP), lambda u: [(-0.02, -0.09), (0.07, -0.06), (0.07, 0.06), (-0.02, 0.09)], 'Stone',
                    bevel=0.01))
    d = Vector((math.cos(az), math.sin(az), 0.0))
    nrm = Vector((-math.sin(az), math.cos(az), 0.0))
    elev = math.radians(40)
    tdir = (d * math.cos(elev) + UP * math.sin(elev)).normalized()
    piv = Vector((0.0, 0.0, 7.0))
    L.add(cyl(0.9, 5.85, 6.25, 24, 'Metal', bevel=0.03))
    for side in (-1, 1):
        arm = box((0.5, 0.32, 1.25), loc=(0, 0, 0), slot='Metal', bevel=0.04)
        place(arm, matrix=Matrix.Translation(nrm * (1.22 * side) + Vector((0, 0, 6.6))) @ Matrix.Rotation(az, 4, 'Z'))
        L.add(arm)
    L.add(place(disc_y(0.32, -1.5, 1.5, 16, 'Trim', bevel=0.02), matrix=Matrix.Translation(piv) @ Matrix.Rotation(az, 4, 'Z')))
    A = C.align_z(tdir, piv)
    tube_parts = [
        lathe([(0.0, -2.85), (0.6, -2.8), (0.84, -2.6), (0.84, -1.95)], 32, 'Metal', bevel=0.02),
        lathe([(0.88, -2.0), (0.92, 5.9)], 32, 'StoneDark', cap_bottom=False, cap_top=False),
        lathe([(0.98, -2.05), (0.98, -1.45), (0.92, -1.4)], 32, 'Trim', bevel=0.012, cap_top=False),
        lathe([(0.99, 1.0), (0.99, 1.45)], 32, 'Trim', bevel=0.012, cap_bottom=False, cap_top=False),
        lathe([(0.99, 4.9), (0.99, 5.3)], 32, 'Trim', bevel=0.012, cap_bottom=False, cap_top=False),
        lathe([(1.0, 5.75), (1.04, 5.9), (1.04, 8.25), (1.1, 8.35), (1.1, 8.5), (1.0, 8.5), (0.95, 8.4), (0.95, 7.9)],
              32, 'Stone', bevel=0.012, cap_top=False),
        lathe([(0.95, 7.85), (0.0, 7.95)], 32, 'Glass', cap_bottom=False, sharp=None),
        glow_intent(lathe([(1.01, 8.52), (1.09, 8.52)], 32, 'Glow', cap_bottom=False, cap_top=False, sharp=None)),
    ]
    finder = lathe([(0.0, 0.2), (0.16, 0.25), (0.18, 2.6), (0.13, 2.65), (0.0, 2.6)], 12, 'Metal')
    place(finder, loc=(0.0, 1.22, 0.0))
    tube_parts.append(finder)
    for k in (0.9, 2.0):
        tube_parts.append(box((0.12, 0.3, 0.12), loc=(0.0, 1.05, k), slot='Metal'))
    for tp in tube_parts:
        L.add(place(tp, matrix=A))

    # --- the lighthouse tower on the left flank, joined to the drum by a vestibule ---
    tx, ty = -7.15, 1.4
    lh = (tx, ty, 0.0)
    L.add(boxz(-6.6, -5.3, -0.6, 3.0, 0.6, 3.9, 'Stone', bevel=0.04))
    L.add(boxz(-6.7, -5.3, -0.7, 3.1, 3.85, 4.15, 'Trim', bevel=0.02))
    L.add(place(box((0.08, 0.7, 1.1), slot='StoneDark', bevel=0.012), loc=(-6.62, 1.2, 2.2)))
    L.add(place(box((0.06, 0.5, 0.9), slot='Glass'), loc=(-6.65, 1.2, 2.2)))
    L.add(lathe([(2.55, -0.3), (2.55, 0.62), (2.42, 0.78), (2.2, 0.85)], 40, 'StoneDark', bevel=0.02, loc=lh))
    prof = [(2.12, 0.8)]
    for i in range(1, 9):
        t = i / 8
        prof.append((2.12 - 0.72 * t ** 0.9, 0.8 + 16.6 * t))
    L.add(lathe(prof + [(0.0, 17.4)], 40, 'Stone', loc=lh, sharp=50.0))
    rz = lambda z: 2.12 - 0.72 * ((z - 0.8) / 16.6) ** 0.9                       # noqa: E731
    for z0, z1 in ((6.4, 7.5), (11.8, 12.8)):
        L.add(lathe([(rz(z0) + 0.05, z0), (rz(z1) + 0.05, z1)], 40, 'StoneDark', loc=lh, cap_bottom=False, cap_top=False))
    # slit windows on the visitor-facing side
    for z, a_deg in ((4.2, 255), (9.0, 285), (14.6, 262)):
        a = math.radians(a_deg)
        rr = rz(z) + 0.02
        M = Matrix.Translation((tx + rr * math.cos(a), ty + rr * math.sin(a), z)) @ Matrix.Rotation(a - PI / 2, 4, 'Z')
        L.add(place(box((0.34, 0.12, 0.9), slot='StoneDark', bevel=0.02), matrix=M))
        L.add(place(box((0.2, 0.1, 0.72), loc=(0, -0.03, 0), slot='Glass'), matrix=M))
    # corbelled gallery, parapet, lantern frame, coral roof and finial
    L.add(lathe([(1.42, 16.9), (1.62, 17.25), (2.05, 17.5), (2.12, 17.62), (2.12, 17.75), (0.0, 17.75)], 40, 'Stone',
                bevel=0.02, loc=lh))
    L.add(lathe([(2.1, 17.7), (2.1, 18.25), (2.02, 18.3), (1.96, 18.3), (1.96, 17.75)], 40, 'StoneDark', bevel=0.015,
                loc=lh, cap_bottom=False, cap_top=False))
    L.add(lathe([(1.25, 17.7), (1.25, 18.05), (1.18, 18.1), (0.0, 18.1)], 32, 'Metal', loc=lh, bevel=0.015))
    for k in range(8):
        a = TAU * k / 8 + PI / 8
        L.add(box((0.1, 0.1, 2.2), loc=(tx + 1.17 * math.cos(a), ty + 1.17 * math.sin(a), 19.15), rot=(0, 0, a), slot='Metal',
                  bevel=0.015))
    L.add(lathe([(1.32, 20.2), (1.32, 20.38), (0.0, 20.38)], 32, 'Metal', loc=lh, bevel=0.015))
    L.add(lathe([(1.48, 20.3), (1.48, 20.45), (0.22, 21.75), (0.0, 21.8)], 24, 'Accent', loc=lh, bevel=0.015))
    L.add(lathe([(0.0, 21.7), (0.13, 21.85), (0.0, 22.0)], 10, 'Metal', loc=lh, sharp=None))
    L.add(cyl(0.035, 21.95, 22.6, 6, 'Metal', loc=(tx, ty)))
    # the lamp: a stacked fresnel lens of glowing rings
    lamp = []
    for i, (r0, z0, z1) in enumerate(((0.78, 18.15, 18.55), (0.9, 18.55, 19.05), (0.96, 19.05, 19.55), (0.88, 19.55, 19.95),
                                      (0.7, 19.95, 20.2))):
        lamp.append(glow_intent(lathe([(r0 * 0.94, z0), (r0, z0 + 0.06), (r0, z1 - 0.06), (r0 * 0.94, z1)], 24, 'Glow',
                                      loc=lh, sharp=None)))
    L.anim('ANIM_PULSE_lamp', lamp, (tx, ty, 19.2))

    # --- the entry: portico with an arched door, and a short stair ---
    L.add(boxz(-1.9, 1.9, -6.75, -5.2, 0.8, 4.35, 'Stone', bevel=0.05))
    L.add(boxz(-2.1, 2.1, -6.95, -5.2, 4.3, 4.75, 'Stone', bevel=0.05))
    L.add(boxz(-2.16, 2.16, -7.01, -5.2, 4.75, 4.87, 'Trim', bevel=0.02))
    ped = plate_xz([(-2.0, 0.0), (2.0, 0.0), (0.0, 0.95)], 0.5, 'Stone', bevel=0.03)
    paint(ped, lambda c, n: 'Trim' if n.z > 0.3 else ('StoneDark' if n.y < -0.9 else None))
    L.add(place(ped, loc=(0.0, -6.45, 4.87)))
    for side in (-1, 1):                     # raking cornices
        L.add(place(box((2.25, 0.16, 0.12), slot='Trim', bevel=0.02), rot=(0, side * math.atan2(0.95, 2.0), 0),
                    loc=(1.0 * side, -6.93, 4.87 + 0.5)))
    for side in (-1, 1):
        L.add(boxz(1.42 * side - 0.2, 1.42 * side + 0.2, -6.95, -6.6, 0.8, 4.3, 'Stone', bevel=0.03))
        L.add(boxz(1.42 * side - 0.26, 1.42 * side + 0.26, -7.0, -6.6, 0.8, 1.15, 'StoneDark', bevel=0.02))
    door = plate_xz([(-0.85, 0.0), (0.85, 0.0), (0.85, 2.2)] + [(0.85 * math.cos(t), 2.2 + 0.85 * math.sin(t)) for t in
                                                                   [PI * i / 10 for i in range(1, 10)]] + [(-0.85, 2.2)],
                    0.05, 'StoneDark', bevel=0.012)
    L.add(place(door, loc=(0.0, -6.78, 0.8)))
    frame = plate_xz([(-1.08, 0.0), (1.08, 0.0), (1.08, 2.2)] + [(1.08 * math.cos(t), 2.2 + 1.08 * math.sin(t)) for t in
                                                                  [PI * i / 10 for i in range(1, 10)]] + [(-1.08, 2.2)],
                     0.03, 'Trim', bevel=0.01)
    L.add(place(frame, loc=(0.0, -6.76, 0.8)))
    L.add(glow_intent(box((0.9, 0.04, 0.06), loc=(0.0, -6.84, 2.75), slot='Glow')))
    for i, (y0, z1) in enumerate(((-8.25, 0.27), (-7.85, 0.54), (-7.45, 0.8))):
        L.add(boxz(-1.7, 1.7, y0, -6.6, -0.3, z1, 'Stone' if i % 2 == 0 else 'Stone', bevel=0.03))
        L.add(glow_intent(box((2.6, 0.05, 0.03), loc=(0.0, y0 + 0.06, z1 + 0.005), slot='Glow')))
        L.col_box(f'step_{i}', (0.0, (y0 - 6.6) / 2, (z1 - 0.3) / 2), (3.3, -6.6 - y0, z1 + 0.3))
    for side in (-1, 1):
        L.add(boxz(1.7 * side - 0.25, 1.7 * side + 0.25, -8.4, -6.6, -0.3, 1.05, 'StoneDark', bevel=0.04))
        L.add(glow_intent(cyl(0.12, 1.05, 1.2, 12, 'Glow', loc=(1.7 * side, -8.2))))

    L.poi('archive', (0.0, -10.0, 0.0))
    L.label('title', (0.0, -4.0, 13.8))
    L.col_cyl('plinth_0', (0, 0), 6.95, -0.3, 0.4)
    L.col_cyl('plinth_1', (0, 0), 6.5, 0.4, 0.8)
    L.col_cyl('drum', (0, 0), 5.95, 0.8, 5.9)
    L.col_cyl('tower', (tx, ty), 2.0, -0.3, 17.6)
    L.col_box('portico', (0.0, -6.0, 2.6), (3.7, 1.4, 3.6))
    return L


# ---------------------------------------------------------------- principle beacons

def build_principle_beacons():
    out = []
    for v in range(4):
        L = Landmark(f'principle_beacon_{v}')
        L.ao = dict(distance=2.5, samples=48, floor=0.45)
        L.gradient = (-0.3, 12.0, 0.82)
        # flared foot
        foot = [(2.45, -0.3), (2.45, 0.25), (2.3, 0.4)]
        for i in range(1, 9):
            t = i / 8
            foot.append((0.6 + 1.7 * (1 - t) ** 2.2, 0.4 + 2.7 * t))
        L.add(lathe(foot + [(0.0, 3.1)], 32, 'Stone', sharp=50.0))
        L.add(lathe([(2.48, 0.05), (2.48, 0.3), (2.33, 0.45), (2.2, 0.45)], 32, 'StoneDark', bevel=0.02, cap_top=False))
        # shaft with blue daymark bands and cyan ribs
        top = 8.2
        L.add(lathe([(0.58, 2.9), (0.4, top), (0.0, top)], 16, 'Stone', bevel=0.015))
        rz = lambda z: 0.58 - 0.18 * (z - 2.9) / (top - 2.9)                  # noqa: E731
        for z0, z1 in ((4.2, 4.85), (6.2, 6.7)):
            L.add(lathe([(rz(z0) + 0.03, z0), (rz(z1) + 0.03, z1)], 16, 'StoneDark', cap_bottom=False, cap_top=False))
        for k in range(4):
            a = TAU * k / 4 + PI / 4
            L.add(box((0.05, 0.1, 4.4), loc=((rz(5.4) + 0.02) * math.cos(a), (rz(5.4) + 0.02) * math.sin(a), 5.4),
                      rot=(0, 0, a), slot='Trim'))
        # a lamp gallery: corbel, a ring deck and a cyan collar carrying the crown
        L.add(lathe([(0.38, top - 0.2), (0.5, top), (0.95, top + 0.32), (1.0, top + 0.42), (0.0, top + 0.42)], 24, 'Stone',
                    bevel=0.015))
        L.add(lathe([(1.02, top + 0.38), (1.02, top + 0.58), (0.96, top + 0.62), (0.9, top + 0.62), (0.9, top + 0.42)], 24,
                    'StoneDark', bevel=0.01, cap_bottom=False, cap_top=False))
        L.add(lathe([(0.42, top + 0.4), (0.62, top + 0.62), (0.7, top + 0.8), (0.0, top + 0.8)], 16, 'Trim', bevel=0.015))
        z0 = top + 0.8
        static, glow = principle_crown(v)
        S = Matrix.Translation((0, 0, z0)) @ Matrix.Diagonal((1.5, 1.5, 1.5, 1.0))
        for ob in static:
            L.add(place(ob, matrix=S))
        for ob in glow:
            place(ob, matrix=S)
        L.anim('ANIM_PULSE_top', glow, (0.0, 0.0, z0 + 1.6))
        L.label('title', (0.0, -1.4, 14.6))
        L.col_cyl('foot', (0, 0), 2.3, -0.3, 0.8)
        L.col_cyl('shaft', (0, 0), 0.55, 0.8, top + 0.8)
        out.append(L)
    return out


def principle_crown(v):
    """Four distinct crowns, one per principle, built at z = 0 (scaled by the caller).
    Returns (static parts, glowing parts); the glowing parts become the pulse node."""
    st, glow = [], []
    if v == 0:      # capability needs alignment: a glowing spire threaded through aligned rings
        glow.append(glow_intent(crystal(2.5, 0.32, sides=6, tip=0.42, rng=C.rng_for('pb0'), slot='Glow', loc=(0, 0, -0.1),
                                        jitter=0.04)))
        st.append(ring_xy(0.74, 0.9, 0.95, 1.1, segs=32, slot='Trim', bevel=0.012))
        for k in range(3):
            a = TAU * k / 3
            st.append(box((0.48, 0.07, 0.07), loc=(0.53 * math.cos(a), 0.53 * math.sin(a), 1.02), rot=(0, 0, a), slot='Metal'))
        st.append(ring_xy(0.48, 0.56, 1.65, 1.75, segs=24, slot='Trim', bevel=0.01))
    elif v == 1:    # alignment is not obedience: an open hand of prongs, the light floats free above
        for k in range(3):
            a = TAU * k / 3 + PI / 2
            out = Vector((math.cos(a), math.sin(a), 0.0))
            P = lambda r, z, out=out: out * r + Vector((0, 0, z))               # noqa: E731
            path = Path.bezier(P(0.3, -0.1), P(0.75, 0.2), P(1.05, 0.8), P(0.9, 1.5), 10, up=UP)
            st.append(sweep(path, lambda u: rect_sec(C.lerp(0.12, 0.06, u), C.lerp(0.1, 0.05, u)), 'Trim', bevel=0.01))
        glow.append(glow_intent(place(part(C.icosphere(2, 0.6), 'Glow'), loc=(0, 0, 1.62))))
    elif v == 2:    # safety belongs to the whole system: nested rings around a glowing core
        zc = 1.15
        glow.append(glow_intent(place(part(C.icosphere(1, 0.48), 'Glow', smooth=False), loc=(0, 0, zc))))
        for r, tilt in ((0.8, (0.0, 0.0)), (1.0, (PI / 2, 0.0)), (1.2, (PI / 2, PI / 2))):
            ob = ring_xy(r - 0.06, r + 0.06, -0.05, 0.05, segs=36, slot='Trim', bevel=0.01)
            place(ob, rot=(tilt[0], 0.0, tilt[1]))
            st.append(place(ob, loc=(0, 0, zc)))
        st.append(cyl(0.12, -0.05, zc - 0.42, 8, 'Metal'))
    else:           # build what deserves to exist: a cut gem seated on a stepped capital
        st.append(strata(ngon(8, 0.62, PI / 8), [(-0.05, 1, 0), (0.25, 1, 0), (0.3, 1, 0.05)], 'Stone', bevel=0.015))
        st.append(strata(ngon(8, 0.5, 0.0), [(0.28, 1, 0), (0.5, 1, 0), (0.54, 1, 0.04)], 'Trim', bevel=0.012))
        pts = []
        for i in range(8):
            a = TAU * i / 8
            pts += [(0.55 * math.cos(a), 0.55 * math.sin(a), 0.75), (0.32 * math.cos(a + PI / 8), 0.32 * math.sin(a + PI / 8), 1.35)]
        pts += [(0, 0, 0.0), (0, 0, 1.6)]
        glow.append(glow_intent(hull([(x, y, z + 0.5) for x, y, z in pts], 'Glow')))
    return st, glow


# ---------------------------------------------------------------- principle lenses

def build_principle_lenses():
    out = []
    for v in range(4):
        L = Landmark(f'principle_lens_{v}')
        L.ao = dict(distance=1.2, samples=48, floor=0.45)
        L.gradient = (-0.3, 1.6, 0.82)
        L.add(lathe([(0.95, -0.3), (0.95, 0.06), (0.88, 0.12), (0.6, 0.12)], 24, 'StoneDark', bevel=0.012))
        ph = front_phase(8)
        body = strata(ngon(8, 0.46, ph), [(0.05, 1, 0), (0.18, 1, 0), (0.24, 0.86, 0), (0.9, 0.74, 0), (0.98, 0.84, 0.0),
                                          (1.02, 0.84, 0.03)], 'Stone', bevel=0.012)
        paint(body, lambda c, n: 'Trim' if n.z > 0.3 and c.z > 0.9 else None)
        L.add(body)
        # numbered pips on the front face (principle 1..4)
        yfront = -0.46 * 0.8 * math.cos(PI / 8) - 0.012
        for k in range(v + 1):
            x = (k - v / 2) * 0.1
            L.add(glow_intent(box((0.05, 0.03, 0.05), loc=(x, yfront, 0.78), slot='Glow')))
        fr = Matrix.Translation((0.0, yfront + 0.012, 0.5)) @ Matrix.Rotation(-math.atan2(0.12 * 0.46, 0.66), 4, 'X')
        L.add(place(box((0.44, 0.03, 0.3), slot='Trim', bevel=0.008), matrix=fr))
        L.add(place(box((0.36, 0.03, 0.22), loc=(0, -0.012, 0), slot='StoneDark', bevel=0.004), matrix=fr))
        # pivot fork and the tilted telescope (eyepiece to the front, objective out to sea)
        L.add(cyl(0.14, 1.0, 1.12, 12, 'Metal', bevel=0.01))
        for side in (-1, 1):
            L.add(box((0.05, 0.14, 0.34), loc=(0.2 * side, 0.0, 1.27), slot='Metal', bevel=0.01))
        piv = Vector((0.0, 0.0, 1.36))
        tilt = math.radians(14)
        tdir = Vector((0.0, math.cos(tilt), math.sin(tilt)))
        A = C.align_z(tdir, piv)
        tparts = [lathe([(0.0, -0.78), (0.07, -0.78), (0.07, -0.62), (0.1, -0.58), (0.13, -0.52), (0.13, 0.1)], 16, 'Metal',
                        bevel=0.008),
                  lathe([(0.135, 0.05), (0.16, 0.3), (0.17, 0.62), (0.19, 0.66), (0.19, 0.78), (0.16, 0.78), (0.15, 0.7)], 16,
                        'Stone', bevel=0.008, cap_top=False),
                  lathe([(0.15, 0.68), (0.0, 0.7)], 16, 'Glass', cap_bottom=False, sharp=None),
                  glow_intent(lathe([(0.16, 0.785), (0.19, 0.785)], 16, 'Glow', cap_bottom=False, cap_top=False, sharp=None)),
                  lathe([(0.145, -0.12), (0.145, 0.04)], 16, 'Trim', cap_bottom=False, cap_top=False)]
        for tp in tparts:
            L.add(place(tp, matrix=A))
        L.add(place(disc_y(0.04, -0.2, 0.2, 8, 'Trim'), matrix=Matrix.Translation(piv) @ Matrix.Rotation(PI / 2, 4, 'Z')))
        L.poi('read', (0.0, -1.7, 0.0))
        L.label('title', (0.0, -0.3, 2.7))
        L.col_cyl('plinth', (0, 0), 0.42, -0.3, 1.1)
        out.append(L)
    return out


# ---------------------------------------------------------------- long_view_bench

def build_long_view_bench():
    L = Landmark('long_view_bench')
    L.ao = dict(distance=1.8, samples=48, floor=0.45)
    L.gradient = (-0.3, 2.6, 0.82)
    # a pale paved terrace with a blue border
    pad = strata(rrect(6.6, 3.6, 1.0, 3), [(-0.3, 1, 0), (0.06, 1, 0), (0.12, 1, 0.05)], 'StoneDark', bevel=0.015)
    paint(pad, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(pad, strata(rrect(6.0, 3.0, 0.75, 3), [(0.08, 1, 0), (0.145, 1, 0)], 'Stone', bevel=0.01))
    # a low curb along the sea side marks the edge of the view
    L.add(paint(boxz(-2.35, 2.35, 1.3, 1.6, 0.05, 0.44, 'StoneDark', bevel=0.03), lambda c, n: 'Trim' if n.z > 0.9 else None))
    # a curved stone bench embracing the view (concave toward the sea, +Y)
    bx, R = -1.0, 5.5
    cen = Vector((bx, R + 0.1, 0.0))
    span = math.radians(17)
    a0, a1 = -PI / 2 - span, -PI / 2 + span
    seat = ring_xy(R - 0.32, R + 0.32, 0.36, 0.5, a0, a1, 14, slot='Stone', bevel=0.03)
    L.add(place(seat, loc=cen))
    for t in (-0.8, 0.0, 0.8):
        a = -PI / 2 + span * t
        L.add(place(box((0.34, 0.52, 0.32), slot='StoneDark', bevel=0.02, rot=(0, 0, a + PI / 2)),
                    loc=(cen.x + R * math.cos(a), cen.y + R * math.sin(a), 0.28)))
    # the leaning monument stone: rough-hewn, a chiselled front face, a glowing horizon line
    mx, my = 1.8, 0.35
    rng = C.rng_for('long_view_stone')
    pts = []
    for i in range(26):
        u = rng.uniform(-1, 1)
        w = rng.uniform(-1, 1)
        z = rng.uniform(0.0, 2.85)
        taper = 1.0 - 0.32 * (z / 2.85) ** 1.4
        pts.append(Vector((u * 0.62 * taper, w * 0.32 * taper, z)))
    pts += [Vector((0.0, 0.0, 3.0)), Vector((0.32, 0.05, 2.9)), Vector((-0.6, 0.0, 0.0)), Vector((0.6, 0.0, 0.0)),
            Vector((0.0, -0.34, 0.0)), Vector((0.0, 0.34, 0.0))]
    bm = hull_bm(pts)
    C.chisel(bm, (0.0, -0.17, 0.0), (0.0, -1.0, 0.0))          # flat front face for the inscription
    stone = part(bm, 'Stone', smooth=False)
    M = Matrix.Translation((mx, my, -0.25)) @ Matrix.Rotation(math.radians(12), 4, 'X') @ Matrix.Rotation(-0.1, 4, 'Z')
    L.add(place(stone, matrix=M))
    L.add(place(box((0.7, 0.03, 0.95), loc=(0.0, -0.175, 1.35), slot='StoneDark', bevel=0.006), matrix=M))
    L.add(place(glow_intent(box((0.9, 0.03, 0.05), loc=(0.0, -0.182, 2.08), slot='Glow')), matrix=M))
    L.add(place(box((0.36, 0.03, 0.035), loc=(0.0, -0.183, 1.97), slot='Accent'), matrix=M))
    L.add(strata(chamfer_poly(rect(1.55, 1.0), 0.14), [(0.1, 1, 0), (0.26, 1, 0), (0.3, 1, 0.03)], 'StoneDark', bevel=0.012,
                 matrix=mat4((mx, my, 0))))
    L.poi('read', (1.6, -1.9, 0.0))
    L.label('title', (0.5, -0.6, 4.1))
    L.col_box('pad', (0.0, 0.0, -0.08), (6.4, 3.4, 0.44))
    L.col_box('bench', (bx, 0.1, 0.25), (3.1, 0.6, 0.5))
    L.col_box('stone', (mx, my + 0.2, 1.35), (1.1, 0.8, 2.7), rot_z=-0.1)
    L.col_box('curb', (0.0, 1.45, 0.25), (4.6, 0.26, 0.38))
    return L


# ============================================================================
# CONTACT: golden outpost, signals across the dunes
# ============================================================================

def disc_x(r, x0, x1, sides=24, slot='Metal', bevel=0.0, center=(0, 0, 0)):
    """Cylinder along the X axis from x0 to x1."""
    ob = lathe([(r, x0), (r, x1)], sides, slot, bevel=bevel)
    place(ob, rot=(0.0, PI / 2, 0.0))       # (x, y, z) -> (z, y, -x): the lathe axis +Z becomes +X
    return place(ob, loc=center)


def build_signal_dish():
    L = Landmark('signal_dish', budget=25000)
    L.ao = dict(distance=4.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 16.0, 0.82)
    # --- concrete base, pedestal and turntable ---
    b1 = lathe([(7.6, -0.3), (7.6, 0.28), (7.52, 0.35), (7.0, 0.35)], 48, 'StoneDark', bevel=0.025)
    b2 = lathe([(6.9, 0.1), (6.9, 0.63), (6.82, 0.7), (4.2, 0.7), (3.4, 0.7)], 48, 'Stone', bevel=0.025)
    paint(b2, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(b1, b2)
    L.add(lathe([(3.35, 0.5), (3.35, 0.9), (3.1, 2.6), (3.15, 2.75), (3.15, 3.1), (2.9, 3.2), (0.0, 3.2)], 32, 'Stone',
                bevel=0.03))
    L.add(lathe([(3.2, 1.55), (3.2, 2.0)], 32, 'StoneDark', cap_bottom=False, cap_top=False))
    L.add(lathe([(2.95, 3.15), (2.95, 3.45), (2.85, 3.55), (0.0, 3.55)], 40, 'Metal', bevel=0.02))
    L.add(ring_xy(2.98, 3.1, 3.2, 3.42, segs=40, slot='Trim', bevel=0.012))
    for k in range(16):
        a = TAU * k / 16
        L.add(box((0.14, 0.14, 0.12), loc=(3.14 * math.cos(a), 3.14 * math.sin(a), 3.3), rot=(0, 0, a), slot='Trim'))
    # --- the yoke ---
    L.add(boxz(-3.9, 3.9, -1.15, 1.15, 3.5, 4.35, 'StoneDark', bevel=0.06))
    for side in (-1, 1):
        x = 3.45 * side
        arm = strata(chamfer_poly(rect(0.8, 2.2), 0.18), [(4.3, 1, 0), (8.3, 0.62, 0), (8.6, 0.55, 0.05)], 'StoneDark',
                     bevel=0.04, matrix=mat4((x, 0.0, 0.0)))
        L.add(arm)
        L.add(disc_x(0.95, -0.25, 0.25, 28, 'Trim', bevel=0.02, center=(x - 0.55 * side, 0.0, 8.0)))
        L.add(disc_x(0.55, -0.3, 0.3, 20, 'Metal', bevel=0.015, center=(x - 0.85 * side, 0.0, 8.0)))
        L.add(box((0.86, 0.18, 2.6), loc=(x, -0.62, 5.9), rot=(0.12, 0, 0), slot='Trim', bevel=0.02))
        L.col_box(f'yoke_{"L" if side < 0 else "R"}', (x, 0.0, 6.2), (0.75, 1.8, 4.6))
    L.add(disc_x(0.42, -3.0, 3.0, 20, 'Metal', center=(0.0, 0.0, 8.0)))

    # --- the dish: an 18 m paraboloid tilted up toward the front ---
    elev = math.radians(38)
    a = Vector((0.0, -math.cos(elev), math.sin(elev)))
    axle = Vector((0.0, 0.0, 8.0))
    vertex = axle + a * 1.4
    Rd, f, t = 9.0, 7.2, 0.28
    D = C.align_z(a, vertex)
    zp = lambda r: r * r / (4 * f)                                              # noqa: E731
    rs = [0.0, 0.9, 1.8, 2.7, 3.6, 4.5, 5.4, 6.3, 7.2, 8.1, 9.0]
    prof = [(0.0, -t)] + [(r, zp(r) - t) for r in rs[1:]] + [(Rd + 0.22, zp(Rd) - 0.05), (Rd + 0.22, zp(Rd) + 0.12),
                                                           (Rd, zp(Rd) + 0.1)] + [(r, zp(r)) for r in reversed(rs[1:-1])] + [(0.0, 0.0)]
    # the bowl: ring seams are grooves in the profile, radial seams are narrow face columns
    seams = [1.8, 3.6, 5.4, 7.2]
    rs = []
    for i in range(1, 21):
        r = Rd * i / 20
        if all(abs(r - sr) > 0.12 for sr in seams):
            rs.append((r, 0.0))
    for sr in seams:
        rs += [(sr - 0.05, 0.0), (sr - 0.04, -0.03), (sr + 0.04, -0.03), (sr + 0.05, 0.0)]
    rs.sort()
    front = [(r, zp(r) + dz) for r, dz in rs if r < Rd - 1e-6] + [(Rd, zp(Rd))]
    prof = ([(0.0, -t)] + [(r, zp(r) - t) for r in [Rd * i / 10 for i in range(1, 11)]] +
            [(Rd + 0.22, zp(Rd) - 0.05), (Rd + 0.22, zp(Rd) + 0.12), (Rd, zp(Rd) + 0.1)] +
            list(reversed(front)) + [(0.0, 0.0)])
    angs = []
    for k in range(8):
        ph = TAU * k / 8 + PI / 8
        angs += [ph - 0.0055, ph + 0.0055] + [ph + 0.0055 + (TAU / 8 - 0.011) * i / 7 for i in range(1, 7)]
    dish = lathe_angles(prof, angs, 'Stone')
    sharpen(dish, 50.0)
    me = dish.data
    colv = me.attributes['col']
    trim, metal, dark = (C.slot_index(dish, k) for k in ('Trim', 'Metal', 'StoneDark'))
    for poly in me.polygons:
        c, nn = poly.center, poly.normal
        rr = c.xy.length
        if nn.z < -0.3:
            poly.material_index = dark                                  # the back of the bowl
        elif rr > Rd - 0.02:
            poly.material_index = trim                                  # rolled brass rim
        elif colv.data[poly.index].value % 8 == 0 and rr > 1.3:
            poly.material_index = trim                                  # radial seam
        elif any(abs(rr - sr) < 0.045 for sr in seams):
            poly.material_index = trim                                  # ring seam groove
    me.attributes.remove(colv)
    C.set_ao_weight(dish, lambda co: 0.55 if co.z > -t * 0.5 else 1.0)
    L.add(place(dish, matrix=D))
    # back structure: hub, radial ribs and the elevation trunnion block
    L.add(place(lathe([(1.7, -1.55), (1.7, -t - 0.02), (1.2, -t + 0.05), (0.0, -t + 0.05)], 24, 'Metal', bevel=0.03), matrix=D))
    for k in range(8):
        ph = TAU * k / 8 + PI / 8
        pts = [Vector((r * math.cos(ph), r * math.sin(ph), zp(r) - t - 0.2)) for r in [1.5 + 6.6 * i / 10 for i in range(11)]]
        L.add(place(sweep(Path(pts, up=Vector((0, 0, 1))), rect_sec(0.22, 0.12), 'Metal', bevel=0.02), matrix=D))
    L.add(boxz(-2.55, 2.55, -0.7, 0.7, 7.4, 8.6, 'StoneDark', bevel=0.05))
    # feed: quadripod legs, receiver cabin and the beacon at its tip
    rc = Vector((0.0, 0.0, f - 0.5))
    for k in range(4):
        ph = TAU * k / 4 + PI / 4
        foot = Vector((6.4 * math.cos(ph), 6.4 * math.sin(ph), zp(6.4)))
        L.add(place(tube([foot, rc + (foot - rc).normalized() * 0.5], 0.13, sides=8, slot='Metal'), matrix=D))
        L.add(place(cyl(0.3, -0.05, 0.14, 10, 'Trim', bevel=0.01, loc=(foot.x, foot.y)), matrix=D @ Matrix.Translation((0, 0, foot.z))))
    L.add(place(lathe([(0.0, f - 1.15), (0.55, f - 1.1), (0.78, f - 0.85), (0.78, f + 0.1), (0.55, f + 0.3), (0.3, f + 0.32)],
                      24, 'Metal', bevel=0.02), matrix=D))
    L.add(place(lathe([(0.8, f - 0.6), (0.8, f - 0.35)], 24, 'Trim', cap_bottom=False, cap_top=False), matrix=D))
    L.add(place(lathe([(0.0, f - 1.2), (0.3, f - 1.12), (0.3, f - 1.3), (0.0, f - 1.32)], 16, 'Trim'), matrix=D))
    beacon = [glow_intent(place(lathe([(0.3, f + 0.3), (0.34, f + 0.52), (0.2, f + 0.78), (0.0, f + 0.86)], 16, 'Glow', sharp=None),
                                matrix=D))]
    L.anim('ANIM_PULSE_beacon', beacon, D @ Vector((0.0, 0.0, f + 0.5)))

    # --- the control hut, its cables and a console at the front ---
    hx, hy = -9.4, -1.6
    H = Matrix.Translation((hx, hy, 0.0)) @ Matrix.Rotation(0.18, 4, 'Z')
    hut = [boxz(-1.95, 1.95, -1.6, 1.6, -0.3, 0.25, 'StoneDark', bevel=0.03),
           boxz(-1.8, 1.8, -1.45, 1.45, 0.2, 2.85, 'Stone', bevel=0.05),
           boxz(-2.1, 2.1, -1.8, 1.75, 2.85, 3.15, 'StoneDark', bevel=0.04),
           boxz(-1.9, 1.9, -1.6, 1.55, 3.12, 3.25, 'Trim', bevel=0.015),
           boxz(-0.5, 0.5, -1.5, -1.38, 0.25, 2.3, 'Metal', bevel=0.02),
           boxz(-0.62, 0.62, -1.52, -1.4, 2.28, 2.4, 'Trim', bevel=0.01),
           boxz(0.85, 1.55, -1.5, -1.4, 1.2, 2.1, 'Trim', bevel=0.012),
           boxz(0.93, 1.47, -1.53, -1.42, 1.28, 2.02, 'Glass', bevel=0.006),
           glow_intent(boxz(-0.3, 0.3, -1.62, -1.55, 2.5, 2.62, 'Glow')),
           boxz(-1.55, -0.85, -1.35, -0.45, 3.2, 3.7, 'Metal', bevel=0.03),
           cyl(0.05, 3.2, 5.2, 6, 'Metal', loc=(1.3, 0.9)),
           box((1.5, 0.75, 0.07), loc=(0.0, -1.85, 2.62), rot=(-0.28, 0, 0), slot='Accent', bevel=0.012),
           box((0.06, 0.06, 0.5), loc=(-0.68, -2.12, 2.36), slot='Metal'),
           box((0.06, 0.06, 0.5), loc=(0.68, -2.12, 2.36), slot='Metal'),
           boxz(-0.75, 0.75, -2.0, -1.45, -0.3, 0.32, 'Stone', bevel=0.025),
           boxz(-1.8, -1.2, 0.6, 1.2, 3.2, 3.42, 'Metal', bevel=0.02),
           place(lathe([(0.0, -0.12), (0.4, -0.05), (0.52, 0.06), (0.48, 0.08), (0.0, -0.02)], 16, 'Stone', sharp=None),
                 matrix=Matrix.Translation((0.35, 0.5, 3.75)) @ Matrix.Rotation(-0.9, 4, 'X')),
           cyl(0.06, 3.2, 3.62, 6, 'Metal', loc=(0.35, 0.62)),
           glow_intent(lathe([(0.0, 5.15), (0.1, 5.22), (0.0, 5.32)], 8, 'Glow', sharp=None, loc=(1.3, 0.9, 0)))]
    for hp in hut:
        L.add(place(hp, matrix=H))
    L.col_box('hut', (hx, hy, 1.4), (3.6, 2.9, 3.4), rot_z=0.18)
    # cables snaking from the hut to the pedestal, and up the right yoke arm
    for k, (dy, sag) in enumerate(((-0.25, 0.06), (0.25, 0.1))):
        p0 = H @ Vector((1.8, dy, 0.6))
        pts = [p0, p0 + Vector((1.2, 0.2, -0.55)), Vector((-5.0, dy - 0.2, 0.75 + sag)), Vector((-3.5, dy, 0.82)),
               Vector((-3.2, dy * 0.6, 1.4))]
        L.add(tube(pts, 0.11, sides=8, slot='Metal'))
    up = [Vector((3.9, 0.55, 3.9)), Vector((3.95, 0.45, 5.5)), Vector((3.75, 0.35, 7.2)), Vector((3.2, 0.3, 8.0))]
    L.add(tube(up, 0.09, sides=8, slot='StoneDark'))
    # the archive console out in front, beyond the dish's lower rim, facing the approach
    con = Matrix.Translation((0.0, -11.2, 0.0))
    for cp in (strata(chamfer_poly(rect(2.0, 1.4), 0.25), [(-0.3, 1, 0), (0.16, 1, 0), (0.2, 1, 0.04)], 'StoneDark', bevel=0.015),
               strata(chamfer_poly(rect(1.0, 0.62), 0.1), [(0.15, 1, 0), (0.95, 0.92, 0)], 'Stone', bevel=0.02),
               box((1.3, 0.8, 0.08), loc=(0, -0.05, 1.02), rot=(-0.42, 0, 0), slot='Trim', bevel=0.015),
               box((1.12, 0.62, 0.04), loc=(0, -0.07, 1.06), rot=(-0.42, 0, 0), slot='StoneDark', bevel=0.006),
               glow_intent(box((0.95, 0.46, 0.02), loc=(0, -0.08, 1.085), rot=(-0.42, 0, 0), slot='Glow'))):
        L.add(place(cp, matrix=con))
    L.col_box('console', (0.0, -11.2, 0.5), (1.0, 0.7, 1.1))

    L.poi('archive', (0.0, -13.2, 0.0))
    L.label('title', (0.0, -6.0, 19.3))
    L.col_cyl('base_0', (0, 0), 7.5, -0.3, 0.35)
    L.col_cyl('base_1', (0, 0), 6.8, 0.35, 0.7)
    L.col_cyl('pedestal', (0, 0), 3.1, 0.7, 3.55)
    return L


# ---------------------------------------------------------------- contact antennas

def antenna_base(L, r=1.5):
    L.add(lathe([(r + 0.25, -0.3), (r + 0.25, 0.18), (r + 0.18, 0.25), (r, 0.25)], 28, 'StoneDark', bevel=0.015))
    L.add(paint(lathe([(r, 0.1), (r, 0.36), (r - 0.07, 0.42), (0.0, 0.42)], 28, 'Stone', bevel=0.015),
                lambda c, n: 'Trim' if is_chamfer(n) else None))
    L.add(box((0.7, 0.42, 0.62), loc=(0.7, 0.75, 0.73), rot=(0, 0, 0.3), slot='Metal', bevel=0.03))
    L.add(box((0.5, 0.03, 0.18), loc=(0.62, 0.53, 0.82), rot=(0, 0, 0.3), slot='Trim'))
    L.col_cyl('base', (0, 0), r + 0.15, -0.3, 0.42)
    return 0.42


def antenna_landmark(name):
    L = Landmark(name)
    L.ao = dict(distance=2.2, samples=48, floor=0.45)
    L.gradient = (-0.3, 7.0, 0.8)
    return L


def build_contact_antenna_0():
    """email: a tower carrying an envelope-shaped transmitter panel, its flap open and light
    spilling out (a message going out)."""
    L = antenna_landmark('contact_antenna_0')
    z = antenna_base(L)
    L.add(strata(chamfer_poly(rect(0.9, 0.9), 0.15), [(z - 0.05, 1, 0), (1.2, 1, 0), (1.28, 1, 0.06)], 'Stone', bevel=0.02))
    L.add(strata(chamfer_poly(rect(0.56, 0.56), 0.09), [(1.2, 1, 0), (5.15, 0.7, 0), (5.25, 0.7, 0.03)], 'StoneDark', bevel=0.02))
    for zz in (2.3, 3.9):
        k = 1.0 - 0.3 * (zz - 1.2) / 3.95
        L.add(strata(chamfer_poly(rect(0.56 * k + 0.12, 0.56 * k + 0.12), 0.09), [(zz - 0.08, 1, 0), (zz + 0.08, 1, 0)], 'Trim',
                     bevel=0.01))
    for sx in (-1, 1):                                           # braces up to the panel
        L.add(tube([Vector((0.2 * sx, 0.05, 3.3)), Vector((1.05 * sx, 0.0, 5.05))], 0.05, sides=6, slot='Metal'))
    ez = 5.9
    W, Hh, T = 2.8, 1.8, 0.34
    E = Matrix.Translation((0.0, -0.3, ez))
    yf = -T / 2
    env = [box((W, T, Hh), slot='Stone', bevel=0.05)]
    for mid, size in (((0, 0, Hh / 2), (W + 0.1, T + 0.04, 0.14)), ((0, 0, -Hh / 2), (W + 0.1, T + 0.04, 0.14)),
                      ((-W / 2, 0, 0), (0.14, T + 0.04, Hh + 0.1)), ((W / 2, 0, 0), (0.14, T + 0.04, Hh + 0.1))):
        env.append(box(size, loc=mid, slot='Trim', bevel=0.02))
    # the flap: a raised V from the top corners to the seal, with a glowing seam beneath it
    apex = Vector((0.0, yf - 0.05, -0.2))
    for sx in (-1, 1):
        corner = Vector((sx * (W / 2 - 0.1), yf - 0.05, Hh / 2 - 0.1))
        dv = apex - corner
        mid = (apex + corner) / 2
        rot = (0, -math.atan2(dv.z, dv.x), 0)
        env.append(box((dv.length + 0.06, 0.1, 0.17), loc=mid, rot=rot, slot='StoneDark', bevel=0.025))
        env.append(glow_intent(box((dv.length - 0.1, 0.04, 0.05), loc=mid + Vector((0, 0.035, -0.12)), rot=rot, slot='Glow')))
    # lower folds: fine brass lines from the bottom corners toward the seal
    for sx in (-1, 1):
        corner = Vector((sx * (W / 2 - 0.1), yf - 0.02, -Hh / 2 + 0.1))
        tgt = Vector((sx * 0.35, yf - 0.02, -0.38))
        dv = tgt - corner
        env.append(box((dv.length, 0.04, 0.06), loc=(tgt + corner) / 2, rot=(0, -math.atan2(dv.z, dv.x), 0), slot='Trim'))
    env.append(place(disc_y(0.24, -0.1, 0.0, 20, 'Accent', bevel=0.025), loc=(0.0, yf - 0.06, -0.2)))
    # a glowing letter rising out of the top edge
    env.append(glow_intent(box((W - 0.7, 0.07, 0.6), loc=(0.0, 0.0, Hh / 2 + 0.12), slot='Glow')))
    env.append(box((W - 0.8, 0.32, 0.36), loc=(0, T / 2 + 0.16, 0), slot='Metal', bevel=0.03))
    for e in env:
        L.add(place(e, matrix=E))
    L.add(box((0.34, 0.5, 0.34), loc=(0.0, -0.02, ez), slot='Metal', bevel=0.03))
    L.add(cyl(0.04, ez + Hh / 2, 7.75, 6, 'Metal', loc=(0.9, -0.2)))
    L.add(glow_intent(lathe([(0.0, 7.7), (0.1, 7.77), (0.0, 7.87)], 8, 'Glow', sharp=None, loc=(0.9, -0.2, 0.0))))
    L.poi('read', (0.0, -2.5, 0.0))
    L.label('title', (0.0, -0.8, 8.6))
    L.col_box('mast', (0.0, 0.0, 2.8), (0.6, 0.6, 4.8))
    return L


def build_contact_antenna_1():
    """github: a branching tree-like antenna whose branches fork and merge like a version graph."""
    L = antenna_landmark('contact_antenna_1')
    z = antenna_base(L)
    L.add(lathe([(0.26, z - 0.05), (0.18, 7.1), (0.0, 7.1)], 12, 'StoneDark', bevel=0.01))
    nodes = [(0.0, 1.5), (0.0, 2.9), (0.0, 4.5), (0.0, 6.0), (0.0, 7.25)]
    # branches in the front plane (x, z): split, run parallel, merge back or end in a tip
    branches = [
        [(0.0, 1.5), (1.05, 2.25), (1.05, 3.85), (0.0, 4.5)],            # feature branch, merged
        [(0.0, 2.9), (-1.15, 3.65), (-1.15, 6.35)],                      # long-lived branch
        [(-1.15, 4.7), (-2.0, 5.3), (-2.0, 6.0)],                        # a fork of the fork
        [(0.0, 6.0), (0.85, 6.6), (0.85, 7.0)],                          # a fresh branch near the top
    ]
    for br in branches:
        pts = [Vector((x, 0.0, zz)) for x, zz in br]
        dense = []
        for a_, b_ in zip(pts, pts[1:]):
            for i in range(4):
                dense.append(a_.lerp(b_, i / 4))
        dense.append(pts[-1])
        L.add(tube(dense, 0.085, sides=8, slot='Trim'))
    node_pts = nodes + [(1.05, 2.25), (1.05, 3.85), (-1.15, 3.65), (-1.15, 4.7), (-1.15, 6.35), (-2.0, 5.3), (-2.0, 6.0),
                        (0.85, 7.0)]
    glow = []
    for k, (x, zz) in enumerate(node_pts):
        r = 0.34 if x == 0.0 else 0.22
        L.add(place(ring_xy(r * 0.95, r * 1.3, -0.05, 0.05, segs=16, slot='Metal'), rot=(PI / 2, 0, 0), loc=(x, 0.0, zz)))
        L.add(glow_intent(place(part(C.icosphere(2, r), 'Glow'), loc=(x, 0.0, zz))))
    # tips: short whip antennas at the open branch ends
    for x, zz in ((-1.15, 6.35), (-2.0, 6.0), (0.85, 7.0), (0.0, 7.25)):
        L.add(cyl(0.03, zz + 0.2, min(zz + 0.95, 7.85), 6, 'Metal', loc=(x, 0.0)))
    L.poi('read', (0.0, -2.5, 0.0))
    L.label('title', (0.0, -0.6, 9.0))
    L.col_cyl('trunk', (0, 0), 0.3, 0.42, 7.0)
    return L


def build_contact_antenna_2():
    """linkedin: a lattice tower crowned with linked rings."""
    L = antenna_landmark('contact_antenna_2')
    z = antenna_base(L, 1.6)
    h = 4.9
    wb, wt = 0.75, 0.28
    leg = lambda sx, sy, zz: Vector((sx * C.lerp(wb, wt, (zz - z) / (h - z)), sy * C.lerp(wb, wt, (zz - z) / (h - z)), zz))  # noqa: E731
    corners = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    for sx, sy in corners:
        L.add(tube([leg(sx, sy, z - 0.05), leg(sx, sy, h)], 0.07, sides=6, slot='Metal'))
        L.add(box((0.22, 0.22, 0.12), loc=leg(sx, sy, z + 0.02), slot='Trim', bevel=0.02))
    levels = [z + 0.05, 1.5, 2.6, 3.7, h]
    for i, zz in enumerate(levels[1:], 1):
        for j in range(4):
            a_, b_ = corners[j], corners[(j + 1) % 4]
            L.add(tube([leg(*a_, zz), leg(*b_, zz)], 0.045, sides=6, slot='Trim' if i % 2 else 'Metal'))
            z0 = levels[i - 1]
            L.add(tube([leg(*a_, z0), leg(*b_, zz)], 0.03, sides=5, slot='Metal'))
            L.add(tube([leg(*b_, z0), leg(*a_, zz)], 0.03, sides=5, slot='Metal'))
    L.add(strata(chamfer_poly(rect(0.7, 0.7), 0.1), [(h - 0.05, 1, 0), (h + 0.25, 1, 0), (h + 0.3, 1, 0.04)], 'Metal', bevel=0.015))
    # two linked rings: one facing the visitor, one turned 90 degrees, threaded through each other
    ra, rb = 0.74, 0.74
    za = h + 0.3 + ra + 0.05
    L.add(ring_sweep(ra, rect_sec(0.09, 0.12), segs=40, slot='Trim', bevel=0.012, center=(0.0, 0.0, za)))
    rb_ring = ring_sweep(rb, rect_sec(0.09, 0.12), segs=40, slot='Trim', bevel=0.012)
    place(rb_ring, rot=(0, 0, PI / 2))
    L.add(place(rb_ring, loc=(0.0, 0.0, za + 0.95)))
    glow = [glow_intent(ring_sweep(ra - 0.12, rect_sec(0.025, 0.05), segs=40, slot='Glow', center=(0.0, 0.0, za))),
            glow_intent(place(place(ring_sweep(rb - 0.12, rect_sec(0.025, 0.05), segs=40, slot='Glow'), rot=(0, 0, PI / 2)),
                              loc=(0.0, 0.0, za + 0.95)))]
    L.add(*glow)
    L.add(glow_intent(lathe([(0.0, za + 0.95 + rb + 0.05), (0.12, za + 0.95 + rb + 0.14), (0.0, za + 0.95 + rb + 0.26)], 10,
                            'Glow', sharp=None)))
    L.poi('read', (0.0, -2.6, 0.0))
    L.label('title', (0.0, -0.6, 9.2))
    L.col_box('tower', (0.0, 0.0, 2.6), (1.2, 1.2, 4.4))
    return L


def build_contact_antenna_3():
    """public square: a mast carrying an array of brass horns."""
    L = antenna_landmark('contact_antenna_3')
    z = antenna_base(L)
    L.add(lathe([(0.42, z - 0.05), (0.38, 1.4), (0.3, 1.5), (0.0, 1.5)], 16, 'Stone', bevel=0.02))
    L.add(lathe([(0.26, 1.45), (0.19, 5.6), (0.0, 5.6)], 12, 'StoneDark', bevel=0.01))
    for zz in (2.4, 3.8):
        L.add(lathe([(0.24, zz - 0.08), (0.24, zz + 0.08)], 12, 'Trim', cap_bottom=False, cap_top=False))
    L.add(strata(ngon(8, 0.55, PI / 8), [(5.3, 0.8, 0), (5.45, 1, 0), (5.75, 1, 0), (5.85, 0.85, 0)], 'Metal', bevel=0.015))
    horns = ((-0.75, -0.15, 0.95), (0.75, -0.15, 0.95), (-2.3, 0.0, 0.85), (2.3, 0.0, 0.85), (0.0, 0.55, 1.15))
    for k, (az, el, sc) in enumerate(horns):
        d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))).normalized()
        if k == 4:
            d = Vector((0.0, -0.45, 0.9)).normalized()
        base = Vector((0.0, 0.0, 5.6)) + d * 0.35
        A = C.align_z(d, base)
        horn = lathe([(0.12, 0.0), (0.14, 0.4), (0.24, 0.85), (0.46, 1.2), (0.72, 1.38), (0.78, 1.42), (0.7, 1.4),
                      (0.62, 1.36), (0.0, 1.1)], 20, 'Trim', sharp=None)
        paint(horn, lambda c, n: 'Accent' if c.z < 0.5 else None)
        L.add(place(place(horn, scale=sc), matrix=A))
        L.add(place(glow_intent(lathe([(0.55, 1.33), (0.0, 1.12)], 20, 'Glow', cap_bottom=False, sharp=None)), matrix=A @
                    Matrix.Diagonal((sc, sc, sc, 1.0))))
        L.add(place(cyl(0.18, -0.1, 0.12, 12, 'Metal'), matrix=A))
    L.poi('read', (0.0, -2.6, 0.0))
    L.label('title', (0.0, -0.8, 8.4))
    L.col_cyl('mast', (0, 0), 0.4, 0.42, 5.6)
    return L


# ---------------------------------------------------------------- closing_monolith

def build_closing_monolith():
    """Two halves of one sunset-facing monolith, parted by a narrow glowing seam, with a
    recessed brass-framed panel for the closing line."""
    L = Landmark('closing_monolith')
    L.ao = dict(distance=2.0, samples=48, floor=0.45)
    L.gradient = (-0.3, 6.0, 0.8)
    s1 = strata(chamfer_poly(rect(5.2, 3.4), 0.5), [(-0.3, 1, 0), (0.18, 1, 0), (0.24, 1, 0.05)], 'StoneDark', bevel=0.02)
    s2 = strata(chamfer_poly(rect(4.0, 2.4), 0.4), [(0.0, 1, 0), (0.42, 1, 0), (0.48, 1, 0.05)], 'Stone', bevel=0.02)
    for ob in (s1, s2):
        paint(ob, lambda c, n: 'Trim' if is_chamfer(n) else None)
    L.add(s1, s2)
    for side, top, tilt in ((-1, 5.05, 0.22), (1, 4.6, -0.18)):
        x0, x1 = (0.05, 1.34) if side > 0 else (-1.34, -0.05)
        poly = [(x0, -0.46), (x1, -0.46), (x1, 0.46), (x0, 0.46)]
        half = strata(poly, [(0.4, 1, 0), (top - 0.6, 0.93, 0), (top, 0.86, 0.0)], 'Stone', bevel=0.035, center=(0.0, 0.0))
        # an angled cut across the top, falling away from the seam
        bm = bmesh.new()
        bm.from_mesh(half.data)
        C.chisel(bm, (0.0, 0.0, top - 0.25), (math.sin(tilt) * side * -1.0, 0.0, math.cos(tilt)))
        bm.to_mesh(half.data)
        bm.free()
        half.data.update()
        paint(half, lambda c, n: 'Trim' if n.z > 0.8 and c.z > 4.0 else None)
        L.add(half)
    L.add(glow_intent(boxz(-0.055, 0.055, -0.38, 0.38, 0.55, 4.85, 'Glow')))
    L.add(boxz(-1.05, 1.05, -0.5, -0.4, 1.3, 3.7, 'Trim', bevel=0.012))
    L.add(boxz(-0.95, 0.95, -0.51, -0.41, 1.4, 3.6, 'StoneDark', bevel=0.008))
    L.add(glow_intent(boxz(-0.95, 0.95, -0.525, -0.51, 3.42, 3.46, 'Glow')))
    L.poi('read', (0.0, -2.8, 0.0))
    L.label('title', (0.0, -1.0, 6.5))
    L.col_box('plinth_0', (0.0, 0.0, -0.03), (5.0, 3.2, 0.54))
    L.col_box('plinth_1', (0.0, 0.0, 0.24), (3.8, 2.2, 0.48))
    L.col_box('monolith', (0.0, 0.0, 2.8), (2.5, 0.85, 4.6))
    return L


# ============================================================================
# World registry and CLI
# ============================================================================

WORLDS = {
    'projects': [build_workshop_core, build_project_beacn, build_project_heard, build_project_crystal_0,
                 build_project_crystal_1, build_project_crystal_2, build_project_crystal_3, build_project_crystal_4,
                 build_build_log],
    'mission': [build_observatory, build_principle_beacons, build_principle_lenses, build_long_view_bench],
    'contact': [build_signal_dish, build_contact_antenna_0, build_contact_antenna_1, build_contact_antenna_2,
                build_contact_antenna_3, build_closing_monolith],
}


def build_world(world, only_nodes=None, pack=True):
    C.reset_scene()
    _serial[0] = 0
    make_materials(world)
    lms = []
    for fn in WORLDS[world]:
        name = fn.__name__.replace('build_', '')
        if only_nodes and not any(name.startswith(n) or n.startswith(name) for n in only_nodes):
            continue
        res = fn()
        for lm in (res if isinstance(res, (list, tuple)) else [res]):
            if only_nodes and lm.name not in only_nodes and not any(lm.name.startswith(n) for n in only_nodes):
                continue
            lm.build()
            lms.append(lm)
    return export_world(world, lms, pack=pack, qa=bool(only_nodes))


def main(argv):
    ap = argparse.ArgumentParser(description='Landmarks B: projects, mission, contact')
    ap.add_argument('--only', default=None, help='comma-separated worlds (projects,mission,contact)')
    ap.add_argument('--nodes', default=None, help='comma-separated landmark names (QA builds)')
    ap.add_argument('--no-pack', action='store_true')
    args = ap.parse_args(argv)
    worlds = args.only.split(',') if args.only else list(WORLDS)
    nodes = args.nodes.split(',') if args.nodes else None
    for w in worlds:
        build_world(w, nodes, pack=not args.no_pack)


if __name__ == '__main__':
    main(sys.argv[1:] if '--' not in sys.argv else sys.argv[sys.argv.index('--') + 1:])
