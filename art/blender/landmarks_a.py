"""
The Unfolding: landmark set A -- the Shared, Philosophy and Experience landmarks.

Builds every landmark in art/specs/LANDMARKS.md sections "Shared", "Philosophy" and "Experience"
and exports one GLB per set:

    art/build/landmarks-<set>.raw.glb      Blender glTF export (node names fixed, see below)
    public/models/landmarks-<set>.glb      gltfpack -cc -kn -km -kv -ke -vpf

Run headless (deterministic, Blender 5 as a Python module; about 12 s for all three sets):

    /home/claude/blender/.venv/bin/python art/blender/landmarks_a.py              # all three sets
    ... landmarks_a.py --only philosophy                                          # one set
    ... landmarks_a.py --only experience --landmarks arena                        # QA subset ->
                                                       art/build/landmarks-experience.qa.glb
    LM_MARKERS=1 ... --out art/build/landmarks-<set>.qa.glb    # QA only: small pyramids at every
                                                       POI/LABEL/SPAWN/PLAQUE empty (never ship)
    LM_PARTS=1 ...                                     # print the heaviest parts per landmark

Each run also writes art/build/landmarks-<set>.report.json (triangles, sizes, child names), and
fails if a landmark exceeds its budget (15k, main archives 25k) or a contract node is missing or
meshless in the raw or packed GLB.

Node contract (LANDMARKS.md):
  * One top-level node per landmark, named exactly like the spec (snake_case). It is the static
    body mesh, origin at ground level in the middle of the footprint, front facing -Y (glTF +Z).
  * Children of that node: ANIM_SPIN_/ANIM_BOB_/ANIM_PULSE_ meshes (origin at the pivot; SPIN
    meshes are centred on their local up axis), POI_/LABEL_/SPAWN_ empties, and COL_BOX_/COL_CYL_
    collider proxies (no material; the node transform is the box centre + yaw, the mesh is the
    axis-aligned box/cylinder around it). COL_BOX rotations are yaw-only so they map onto the
    game's footprint colliders, and every collider reaches down to z = -0.3 or rests on another
    collider's walkable top (nothing floats over open ground, so 2.5D physics reads them right).
    Overhead parts the visitor walks under (arches, roofs, the Origin's frame) have no collider.
  * Extra empties beyond the spec, harmless if unused: PLAQUE_numeral on each pillar (centre of
    the recessed plaque face, facing -Y: where the game draws the roman numeral) and SCREEN_score
    on the arena scoreboard (centre of its recessed screen, facing -Y).
  * Several landmarks in one file share child names (POI_read, LABEL_title). Blender forces unique
    object names (POI_read.001), so the exported glTF JSON is rewritten to drop the ".NNN" suffix:
    the GLB holds the exact names. three.js keeps them in object.userData.name (object.name gets
    a uniquified copy such as POI_read_1), so the game should match on userData.name.
  * -vpf keeps positions as floats so every named node holds its own mesh. With quantized
    positions gltfpack moves each mesh into an unnamed child node that carries the dequantization
    transform, and name-based checks such as /^COL_/.test(mesh.name) stop working (the art preview
    then draws the colliders as solid geometry).

Materials are referenced by slot name only (Stone, StoneDark, Trim, Accent, Glow, Metal, Glass,
Wood); the colors written here are the per-world defaults from LANDMARKS.md (shared props use the
site identity colors). COLOR_0 holds grayscale AO x a soft vertical gradient. The AO is baked per
landmark with back-face-aware rays (bake_ao_bf): landmarks are built from overlapping solid parts,
and plain per-vertex AO turns every vertex buried inside a neighbouring part black. Glow faces get
no AO or gradient. Long edges are split before the bake (LM.densify) so long faces get AO samples.

Modelling kit: bevelled boxes/prisms/lathes/sweeps with real chamfers, coplanar inlay bands (no
z-fighting), recessed panels cut before bevelling (inset_face), a triangle sweep for the Origin's
mitred frame, and Chaikin-smoothed outlines for organic silhouettes (the bass body).
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
from mathutils import Matrix, Vector  # noqa: E402

TAU = math.tau
UP = Vector((0.0, 0.0, 1.0))
BUILD_DIR = os.path.join(C.REPO_ROOT, 'art', 'build')
PACK_ARGS = '-cc -kn -km -kv -ke -vpf'

# ----------------------------------------------------------------------------
# Palettes (defaults only: the game swaps materials by slot name)
# ----------------------------------------------------------------------------

PALETTES = {
    # Shared props appear on several worlds: default to the site identity colors.
    'shared': {
        'Stone': ('#e9e4d5', {}), 'StoneDark': ('#32636a', {}), 'Trim': ('#8cf0d1', dict(metallic=0.35, roughness=0.42)),
        'Accent': ('#f0744e', dict(roughness=0.55)), 'Glow': ('#8cf0d1', {}),
        'Metal': ('#5d6b75', dict(metallic=0.45, roughness=0.45)), 'Glass': ('#1d4a52', dict(roughness=0.12)),
    },
    'philosophy': {
        'Stone': ('#e6ece6', {}), 'StoneDark': ('#2f5d5a', {}), 'Trim': ('#8cf0d1', dict(metallic=0.35, roughness=0.42)),
        'Accent': ('#e8c27a', dict(metallic=0.35, roughness=0.4)), 'Glow': ('#8cf0d1', {}),
        'Metal': ('#7d918e', dict(metallic=0.45, roughness=0.45)), 'Glass': ('#3c8c86', dict(roughness=0.1)),
    },
    'experience': {
        'Stone': ('#d9a07a', {}), 'StoneDark': ('#6e3a30', {}), 'Trim': ('#f0c27a', dict(metallic=0.4, roughness=0.4)),
        'Accent': ('#f0744e', dict(roughness=0.5)), 'Glow': ('#ff9a62', {}),
        'Metal': ('#4a3a33', dict(metallic=0.45, roughness=0.42)), 'Glass': ('#5a3428', dict(roughness=0.12)),
        'Wood': ('#9a6542', dict(roughness=0.8)),
    },
}


def make_materials(set_name):
    for slot, (hex_, style) in PALETTES[set_name].items():
        C.material(slot, color=hex_, **style)


# ----------------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------------

LANDMARKS = []


def landmark(name, set_name, budget=15000):
    def deco(fn):
        LANDMARKS.append(dict(name=name, set=set_name, budget=budget, fn=fn))
        return fn
    return deco


# ----------------------------------------------------------------------------
# Small math
# ----------------------------------------------------------------------------

def V(x, y=0.0, z=0.0):
    return Vector((x, y, z)) if not isinstance(x, (tuple, list, Vector)) else Vector(x)


def polar(r, a, z=0.0):
    return Vector((r * math.cos(a), r * math.sin(a), z))


def rot(yaw=0.0, pitch=0.0, roll=0.0):
    """Rotation matrix: roll about Y (front axis), then pitch about X, then yaw about Z."""
    return (Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(pitch, 4, 'X')
            @ Matrix.Rotation(roll, 4, 'Y'))


def place(ob, loc=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0, scale=None):
    m = Matrix.Translation(V(loc)) @ rot(yaw, pitch, roll)
    if scale is not None:
        s = scale if isinstance(scale, (tuple, list)) else (scale, scale, scale)
        m = m @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))
    C.transform(ob, m)
    return ob


def rrect(w, h, r, n=3):
    """CCW rounded rectangle outline (w x h, corner radius r, n segments per corner)."""
    pts = []
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0.0), (-w / 2 + r, h / 2 - r, 90.0),
                       (-w / 2 + r, -h / 2 + r, 180.0), (w / 2 - r, -h / 2 + r, 270.0)):
        for i in range(n + 1):
            a = math.radians(a0 + 90.0 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def chamfer_rect(w, h, c):
    """CCW rectangle with 45-degree corner chamfers of size c (an octagon)."""
    x, y = w / 2, h / 2
    return [(x, -y + c), (x, y - c), (x - c, y), (-x + c, y), (-x, y - c), (-x, -y + c),
            (-x + c, -y), (x - c, -y)]


def ngon(n, r, phase=0.0, rx=None, ry=None):
    rx = rx if rx is not None else r
    ry = ry if ry is not None else r
    return [(rx * math.cos(phase + TAU * i / n), ry * math.sin(phase + TAU * i / n)) for i in range(n)]


# ----------------------------------------------------------------------------
# Part builders (each returns a linked object with one material slot)
# ----------------------------------------------------------------------------

_counter = [0]


def _pname():
    _counter[0] += 1
    return f'_p{_counter[0]:05d}'


def obj(bm, slot, smooth=True):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return C.mesh_object(_pname(), bm, slot, smooth=smooth)


def bm_box(size, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    c = V(center)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz)) + c
    return bm


def box(size, center=(0, 0, 0), slot='Stone', bevel=0.0, segs=2, yaw=0.0, pitch=0.0, roll=0.0,
        angle=30.0, pre=None):
    """Bevelled box: size (x, y, z) centred at `center`, rotated yaw/pitch/roll about its centre.
    pre(ob) runs before the bevel (e.g. inset_face for recessed panels)."""
    ob = obj(bm_box(size), slot)
    if pre:
        pre(ob)
    if bevel > 0.0:
        C.bevel(ob, bevel, segments=segs, angle=angle)
    place(ob, center, yaw, pitch, roll)
    return ob


def prism(poly, z0, z1, slot='Stone', bevel=0.0, segs=2, angle=30.0, loc=(0, 0, 0), yaw=0.0,
          pitch=0.0, roll=0.0, levels=None, pre=None):
    """Extrude a CCW 2D outline between z0 and z1 (or through explicit `levels`), then bevel."""
    lv = levels or [(z0, 1.0, 0.0), (z1, 1.0, 0.0)]
    bm, _ = C.extrude_profile(poly, lv)
    ob = obj(bm, slot)
    if pre:
        pre(ob)
    if bevel > 0.0:
        C.bevel(ob, bevel, segments=segs, angle=angle)
    place(ob, loc, yaw, pitch, roll)
    return ob


def side_profile(poly_yz, x0, x1, slot='Stone', bevel=0.0, segs=2, angle=30.0, loc=(0, 0, 0), yaw=0.0,
                 pre=None, taper=None):
    """Extrude a 2D side profile [(y, z), ...] across x from x0 to x1 (a 'cookie cutter' in YZ).

    taper(z) -> x scale lets the part narrow with height. pre(ob) runs before the bevel.
    """
    bm = bmesh.new()
    a = []
    b = []
    for y, z in poly_yz:
        s = taper(z) if taper else 1.0
        a.append(bm.verts.new((x0 * s, y, z)))
        b.append(bm.verts.new((x1 * s, y, z)))
    n = len(poly_yz)
    for i in range(n):
        k = (i + 1) % n
        bm.faces.new((a[i], a[k], b[k], b[i]))
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    ob = obj(bm, slot)
    if pre:
        pre(ob)
    if bevel > 0.0:
        C.bevel(ob, bevel, segments=segs, angle=angle)
    place(ob, loc, yaw)
    return ob


def lathe(profile, sides=32, slot='Stone', loc=(0, 0, 0), phase=0.0, yaw=0.0, pitch=0.0, roll=0.0,
          bevel=0.0, segs=2, angle=40.0):
    bm, _ = C.lathe(profile, sides=sides, phase=phase)
    ob = obj(bm, slot)
    if bevel > 0.0:
        C.bevel(ob, bevel, segments=segs, angle=angle)
    place(ob, loc, yaw, pitch, roll)
    return ob


def cylinder(r, z0, z1, sides=24, slot='Stone', chamfer=0.0, loc=(0, 0, 0), bottom_chamfer=None,
             yaw=0.0, pitch=0.0, roll=0.0, phase=0.0):
    """Vertical cylinder with optional 45-degree chamfered rims (real geometry)."""
    cb = chamfer if bottom_chamfer is None else bottom_chamfer
    prof = [(0.0, z0)]
    if cb > 0:
        prof += [(r - cb, z0), (r, z0 + cb)]
    else:
        prof += [(r, z0)]
    if chamfer > 0:
        prof += [(r, z1 - chamfer), (r - chamfer, z1)]
    else:
        prof += [(r, z1)]
    prof += [(0.0, z1)]
    return lathe(prof, sides, slot, loc, phase, yaw, pitch, roll)


def sphere(r, center=(0, 0, 0), slot='Stone', subdiv=3, scale=(1, 1, 1)):
    bm = C.icosphere(subdiv, r)
    for v in bm.verts:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
    ob = obj(bm, slot)
    place(ob, center)
    return ob


def uvsphere(r, center=(0, 0, 0), slot='Stone', segs=24, rings=12, scale=(1, 1, 1)):
    """UV sphere built from explicit triangles (fixed diagonals). bmesh.ops.create_uvsphere's planar
    quads triangulate differently from run to run, which made the GLBs non-deterministic."""
    bm = bmesh.new()
    sx, sy, sz = scale
    top = bm.verts.new((0.0, 0.0, r * sz))
    bot = bm.verts.new((0.0, 0.0, -r * sz))
    ring = []
    for i in range(1, rings):
        th = math.pi * i / rings
        ring.append([bm.verts.new((r * math.sin(th) * math.cos(TAU * j / segs) * sx,
                                   r * math.sin(th) * math.sin(TAU * j / segs) * sy, r * math.cos(th) * sz))
                     for j in range(segs)])
    for j in range(segs):
        k = (j + 1) % segs
        bm.faces.new((top, ring[0][j], ring[0][k]))
        bm.faces.new((bot, ring[-1][k], ring[-1][j]))
        for i in range(len(ring) - 1):
            a, b, c, d = ring[i][j], ring[i][k], ring[i + 1][k], ring[i + 1][j]
            bm.faces.new((a, d, c))
            bm.faces.new((a, c, b))
    ob = obj(bm, slot)
    place(ob, center)
    return ob


def torus(R, r, center=(0, 0, 0), slot='Stone', major=48, minor=12, yaw=0.0, pitch=0.0, roll=0.0,
          section=None):
    """Torus in the XY plane (axis +Z). section: optional CCW 2D (radial, z) profile instead of a circle."""
    prof = section or [(r * math.cos(TAU * j / minor), r * math.sin(TAU * j / minor)) for j in range(minor)]
    bm = bmesh.new()
    rings = []
    for i in range(major):
        a = TAU * i / major
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new(((R + u) * ca, (R + u) * sa, w)) for u, w in prof])
    m = len(prof)
    for i in range(major):
        r0, r1 = rings[i], rings[(i + 1) % major]
        for j in range(m):
            k = (j + 1) % m
            bm.faces.new((r0[j], r1[j], r1[k], r0[k]))
    ob = obj(bm, slot)
    place(ob, center, yaw, pitch, roll)
    return ob


def sweep(path, profile, slot='Stone', closed=False, normals=None, binormal=None, cap=True,
          scale=None, slots=None):
    """Sweep a closed 2D profile [(u, v), ...] along a 3D path.

    For each path point i the profile is placed at P + N*u*s + B*v*s, where N and B come from
    `normals`/`binormal` (explicit, e.g. for planar arches) or from parallel transport frames,
    and s = scale(i) (optional taper). Faces are oriented outward afterwards.
    """
    n = len(path)
    if normals is None:
        _, nor, bino = C.frames(path)
    else:
        nor = normals
        bino = [binormal] * n if isinstance(binormal, Vector) else binormal
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(path):
        s = scale(i) if scale else 1.0
        su, sv = (s if not isinstance(s, tuple) else s[0]), (s if not isinstance(s, tuple) else s[1])
        rings.append([bm.verts.new(p + nor[i] * (u * su) + bino[i] * (v * sv)) for u, v in profile])
    m = len(profile)
    segs = n if closed else n - 1
    names = []
    for i in range(segs):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for j in range(m):
            k = (j + 1) % m
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
            names.append(slots[j] if slots else None)
    if cap and not closed:
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
        names += [None, None]
    ob = obj(bm, slot)
    if slots:
        idx = {s: C.slot_index(ob, s) for s in dict.fromkeys(x for x in names if x)}
        for p, s in zip(ob.data.polygons, names):
            if s:
                p.material_index = idx[s]
    return ob


def planar_arch(points_xz, profile, slot='Stone', y=0.0, scale=None, cap=True, slots=None):
    """Sweep a profile (u = outward in-plane offset, v = depth along +Y) along a curve in the XZ plane."""
    pts = [Vector((x, y, z)) for x, z in points_xz]
    n = len(pts)
    nors = []
    for i in range(n):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        t = (b - a).normalized()
        nors.append(Vector((-t.z, 0.0, t.x)))
    return sweep(pts, profile, slot, normals=nors, binormal=Vector((0, 1, 0)), cap=cap, scale=scale, slots=slots)


def ring_frame(outer, inner, y0, y1, slot='Stone'):
    """Planar ring (outer and inner CCW outlines in XZ, same vertex count) extruded along Y."""
    bm = bmesh.new()
    n = len(outer)
    of = [bm.verts.new((x, y0, z)) for x, z in outer]
    ob_ = [bm.verts.new((x, y1, z)) for x, z in outer]
    inf = [bm.verts.new((x, y0, z)) for x, z in inner]
    inb = [bm.verts.new((x, y1, z)) for x, z in inner]
    for i in range(n):
        k = (i + 1) % n
        bm.faces.new((of[i], of[k], inf[k], inf[i]))      # front
        bm.faces.new((ob_[k], ob_[i], inb[i], inb[k]))    # back
        bm.faces.new((of[k], of[i], ob_[i], ob_[k]))      # outer wall
        bm.faces.new((inf[i], inf[k], inb[k], inb[i]))    # inner wall
    return obj(bm, slot)


def inset_face(ob, pick, thickness, depth, slot=None, wall_slot=None, border=None):
    """Recess the faces chosen by pick(BMFace) -> bool: a flat border of `thickness`, then
    near-vertical walls `depth` deep. `slot` paints the recessed floor, `wall_slot` the walls and
    `border` the flat border ring (each optional). A negative depth embosses instead.
    """
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    faces = [f for f in bm.faces if pick(f)]
    if not faces:
        bm.free()
        return 0
    r1 = {'faces': []}
    if thickness > 0.0:
        r1 = bmesh.ops.inset_region(bm, faces=faces, thickness=thickness, depth=0.0, use_even_offset=True)
    r2 = bmesh.ops.inset_region(bm, faces=faces, thickness=min(0.004, max(thickness, 0.01) * 0.2),
                                depth=-depth, use_even_offset=True)
    for s, group in ((slot, faces), (wall_slot, r2['faces']), (border, r1['faces'])):
        if s:
            idx = C.slot_index(ob, s)
            for f in group:
                f.material_index = idx
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(faces)


def inset_rings(ob, pick, rings, inner=None):
    """Concentric coplanar inset rings on the faces chosen by pick(BMFace): rings = [(thickness, slot
    or None), ...] from the outside in; `inner` paints what remains. No z-fighting: same plane."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    faces = [f for f in bm.faces if pick(f)]
    for t, s in rings:
        res = bmesh.ops.inset_region(bm, faces=faces, thickness=t, depth=0.0, use_even_offset=True)
        if s:
            idx = C.slot_index(ob, s)
            for f in res['faces']:
                f.material_index = idx
    if inner:
        idx = C.slot_index(ob, inner)
        for f in faces:
            f.material_index = idx
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def rubble(center, size, rng, slot='Stone', squash=0.6):
    """A small chiselled rock (flat shaded), lying on the ground around a landmark's foot."""
    bm = C.icosphere(1, 1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size * rng.uniform(0.8, 1.15), v.co.y * size * rng.uniform(0.7, 1.0),
                       v.co.z * size * squash))
    ob = obj(bm, slot, smooth=False)
    place(ob, center, rng.uniform(0, TAU), rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2))
    return ob


def paint(ob, fn):
    """fn(center: Vector, normal: Vector) -> slot or None."""
    C.paint_faces(ob, lambda p: fn(Vector(p.center), Vector(p.normal)))


def mark_sharp(ob, angle=40.0):
    """Mark edges whose dihedral angle exceeds `angle` degrees as sharp (crisp shading there)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    lim = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
            e.smooth = False
    bm.to_mesh(ob.data)
    bm.free()


def copy(ob, loc=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0, scale=None):
    new = C.duplicate(ob, _pname())
    place(new, loc, yaw, pitch, roll, scale)
    return new


def mirror_x(ob):
    """Duplicate mirrored across x = 0 (normals fixed)."""
    new = C.duplicate(ob, _pname())
    C.transform(new, Matrix.Diagonal((-1.0, 1.0, 1.0, 1.0)))
    bm = bmesh.new()
    bm.from_mesh(new.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(new.data)
    bm.free()
    return new


# ----------------------------------------------------------------------------
# Landmark assembly
# ----------------------------------------------------------------------------

class LM:
    """Collects the parts of one landmark and turns them into the exported node tree."""

    def __init__(self, name):
        self.name = name
        self.parts = []
        self.anims = []
        self.empties = []
        self.cols = []
        self.ao = dict(distance=2.0, samples=48, floor=0.42)
        self.grad = (0.0, 2.5, 0.84)   # z0, z1, shade at z0 (soft vertical gradient)
        self.densify = 1.2             # split longer edges before the AO bake (None = off)

    def add(self, *obs):
        for o in obs:
            if o is None:
                continue
            if isinstance(o, (list, tuple)):
                self.parts.extend(o)
            else:
                self.parts.append(o)
        return obs[0] if len(obs) == 1 else obs

    def anim(self, name, parts, pivot, ao=None):
        self.anims.append((name, [p for p in parts if p is not None], V(pivot), ao))

    def empty(self, name, loc, yaw=0.0):
        self.empties.append((name, V(loc), yaw))

    def empty_shift(self, name, delta):
        """Move the most recent empty called `name` by delta (for parts built locally then placed)."""
        for i in range(len(self.empties) - 1, -1, -1):
            if self.empties[i][0] == name:
                n, loc, yaw = self.empties[i]
                self.empties[i] = (n, loc + V(delta), yaw)
                return
        raise KeyError(name)

    def col_box(self, name, center, size, yaw=0.0):
        assert name.startswith('COL_BOX_'), name
        self.cols.append((name, 'BOX', V(center), V(size), yaw))

    def col_cyl(self, name, center_xy, radius, z0, z1, sides=16):
        assert name.startswith('COL_CYL_'), name
        cx, cy = center_xy[0], center_xy[1]
        self.cols.append((name, 'CYL', V(cx, cy, (z0 + z1) / 2), V(radius * 2, radius * 2, z1 - z0), sides))


def _glow_vertices(ob):
    me = ob.data
    glow = {i for i, m in enumerate(me.materials) if m and m.name == 'Glow'}
    vs = set()
    for p in me.polygons:
        if p.material_index in glow:
            vs.update(p.vertices)
    return vs


def _shade_and_weights(ob, grad):
    """Vertical gradient everywhere, no AO darkening / gradient on emissive faces."""
    C.ensure_intent(ob)
    me = ob.data
    glow = _glow_vertices(ob)
    z0, z1, v0 = grad
    sh = me.attributes['shade']
    aw = me.attributes['aow']
    for v in me.vertices:
        if v.index in glow:
            sh.data[v.index].value = 1.0
            aw.data[v.index].value = 0.0
        else:
            t = C.clamp((v.co.z - z0) / (z1 - z0)) if z1 != z0 else 1.0
            sh.data[v.index].value = C.lerp(v0, 1.0, C.smoothstep(0.0, 1.0, t))


def bake_ao_bf(ob, distance, samples=48, ground=True, ground_z=0.0, smooth=1, bias=None):
    """Per-vertex ray-traced AO like common.bake_ao, but rays ignore back-face hits.

    Landmarks are built from overlapping solid parts, so many vertices sit buried inside a
    neighbouring part (a column ring inside a band, a beam corner inside a cap). With plain AO
    those vertices read fully occluded and darken every visible face they belong to. Skipping hits
    on faces seen from behind lets a buried vertex see past the part that buries it.
    """
    from mathutils.bvhtree import BVHTree
    me = ob.data
    cos = [v.co.copy() for v in me.vertices]
    tree = BVHTree.FromPolygons(cos, [tuple(p.vertices) for p in me.polygons])
    dirs = C._hemisphere(samples)
    eps = bias if bias is not None else distance * 0.004 + 1e-4
    vals = []
    for i, co in enumerate(cos):
        n = Vector(me.vertex_normals[i].vector)
        if n.length_squared < 1e-12:
            n = UP.copy()
        if ground and co.z < ground_z - 1e-4:
            vals.append(0.0)
            continue
        rot_ = n.to_track_quat('Z', 'Y').to_matrix()
        o0 = co + n * eps
        occ = 0.0
        for d in dirs:
            w = rot_ @ d
            o, left, t_hit, travelled = o0, distance, None, 0.0
            for _ in range(8):
                hit = tree.ray_cast(o, w, left)
                if hit[0] is None:
                    break
                if hit[1].dot(w) < 0.0:          # front face: a real occluder
                    t_hit = travelled + hit[3]
                    break
                step = hit[3] + 1e-4             # back face: we are inside that part, keep going
                travelled += step
                left -= step
                if left <= 0.0:
                    break
                o = hit[0] + w * 1e-4
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
    """common.finalize (triangulate, weighted normals, intent normals, strip helpers) with the
    back-face-aware AO above folded into COLOR_0 (shade x AO, per-vertex AO weight)."""
    C.ensure_intent(ob)
    me = ob.data
    C.apply_transform(ob)
    shade = [d.value for d in me.attributes['shade'].data]
    aow = [d.value for d in me.attributes['aow'].data]
    info = C.finalize(ob, ao=None, weighted=weighted)    # vertex order is preserved
    if ao is not None:
        opts = dict(ao)
        floor = opts.pop('floor', 0.35)
        gamma = opts.pop('gamma', 1.0)
        raw = bake_ao_bf(ob, **opts)
        vals = [s * C.lerp(1.0, C.lerp(floor, 1.0, C.clamp(a) ** gamma), w) for s, w, a in zip(shade, aow, raw)]
        C.write_vertex_colors(ob, vals)
    return info


def _named(name, data):
    ob = bpy.data.objects.new(name, data)  # Blender appends .001 on clashes; fixed in the GLB JSON
    C.link(ob)
    return ob


def _collider_mesh(kind, size, sides):
    bm = bmesh.new()
    if kind == 'BOX':
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * size.x, v.co.y * size.y, v.co.z * size.z))
    else:
        r, h = size.x / 2, size.z
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sides, radius1=r, radius2=r,
                              depth=h)
    me = bpy.data.meshes.new('_col')
    bm.to_mesh(me)
    bm.free()
    return me


def densify(ob, max_len=1.0):
    """Split edges longer than max_len so per-vertex AO and gradients have samples along long faces
    (planar faces stay planar, so flat shading is unaffected)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    groups = {}
    for e in bm.edges:
        ln = e.calc_length()
        if ln > max_len:
            groups.setdefault(int(math.ceil(ln / max_len)) - 1, []).append(e)
    for cuts in sorted(groups, reverse=True):
        edges = [e for e in groups[cuts] if e.is_valid]
        if edges:
            bmesh.ops.subdivide_edges(bm, edges=edges, cuts=cuts, use_grid_fill=False)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def assemble(L, budget):
    """Join, finalize and parent everything. Returns (root, objects, info)."""
    tmp = _pname()
    if os.environ.get('LM_PARTS'):
        rows = sorted(((C.tri_count(p), p.data.materials[0].name if p.data.materials else '-') for p in L.parts),
                      reverse=True)
        print(f'  [{L.name}] parts: {len(rows)}, tris before join: {sum(r[0] for r in rows)}; top: {rows[:12]}')
    root = C.join(L.parts, tmp)
    if L.densify:
        densify(root, L.densify)
    _shade_and_weights(root, L.grad)
    info = finalize_lm(root, ao=L.ao, weighted=True)
    root.name = L.name
    root.data.name = L.name
    assert root.name == L.name, (root.name, L.name)
    objs = [root]
    anim_tris = 0
    for name, parts, pivot, ao in L.anims:
        ob = C.join(parts, _pname())
        C.transform(ob, Matrix.Translation(-pivot))
        _shade_and_weights(ob, (-pivot.z - 1.0, -pivot.z, 1.0))
        opts = dict(ao) if ao else None
        if opts is not None:
            opts.setdefault('ground_z', -pivot.z)
        ai = finalize_lm(ob, ao=opts, weighted=True)
        anim_tris += ai['triangles']
        ob.name = name
        ob.location = pivot
        ob.parent = root
        objs.append(ob)
    if os.environ.get('LM_MARKERS'):
        for name, loc, yaw in L.empties:
            col = 'Accent' if name.startswith('POI_') else ('Glow' if name.startswith('LABEL_') else 'Trim')
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.35, radius2=0.0, depth=0.7)
            mk = obj(bm, col)
            place(mk, loc + V(0, 0, 0.35))
            mk.name = 'QA_' + name
            mk.parent = root
            objs.append(mk)
    for name, loc, yaw in L.empties:
        e = _named(name, None)
        e.empty_display_type = 'PLAIN_AXES'
        e.empty_display_size = 0.5
        e.location = loc
        e.rotation_euler = (0.0, 0.0, yaw)
        e.parent = root
        objs.append(e)
    for name, kind, center, size, extra in L.cols:
        me = _collider_mesh(kind, size, extra if kind == 'CYL' else 16)
        c = _named(name, me)
        c.location = center
        if kind == 'BOX':
            c.rotation_euler = (0.0, 0.0, extra)
        c.parent = root
        objs.append(c)
    info['anim_triangles'] = anim_tris
    info['total_triangles'] = info['triangles'] + anim_tris
    if info['total_triangles'] > budget:
        raise RuntimeError(f"{L.name}: {info['total_triangles']} triangles exceeds budget {budget}")
    return root, objs, info


# ----------------------------------------------------------------------------
# GLB post-processing and verification
# ----------------------------------------------------------------------------

def _read_glb(path):
    with open(path, 'rb') as fh:
        b = fh.read()
    magic, ver, _ = struct.unpack('<III', b[:12])
    clen, ctype = struct.unpack('<II', b[12:20])
    return magic, ver, ctype, json.loads(b[20:20 + clen]), b[20 + clen:]


def fix_names(path):
    """Strip Blender's .NNN uniqueness suffixes from node names in place (glTF allows duplicates)."""
    magic, ver, ctype, j, rest = _read_glb(path)
    for n in j.get('nodes', []):
        if 'name' in n:
            n['name'] = re.sub(r'\.\d{3}$', '', n['name'])
    js = json.dumps(j, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', magic, ver, 12 + 8 + len(js) + len(rest)))
        fh.write(struct.pack('<II', len(js), ctype))
        fh.write(js)
        fh.write(rest)


def glb_tree(path):
    """{landmark: {'children': [names], 'mesh': bool}} from a GLB's JSON."""
    _, _, _, j, _ = _read_glb(path)
    nodes = j['nodes']
    out = {}
    for i in j['scenes'][j.get('scene', 0)]['nodes']:
        n = nodes[i]
        kids = [nodes[c].get('name', '') for c in n.get('children', [])]
        out[n.get('name', '')] = dict(children=kids, mesh='mesh' in n,
                                      child_mesh={nodes[c].get('name', ''): 'mesh' in nodes[c]
                                                  for c in n.get('children', [])})
    return out


def verify(path, expected):
    """expected: {landmark: [child names]}; raises on any missing or meshless node."""
    tree = glb_tree(path)
    problems = []
    for name, kids in expected.items():
        if name not in tree:
            problems.append(f'missing top-level node {name}')
            continue
        t = tree[name]
        if not t['mesh']:
            problems.append(f'{name} has no mesh')
        for k in kids:
            if k not in t['children']:
                problems.append(f'{name}: missing child {k}')
            elif (k.startswith('COL_') or k.startswith('ANIM_')) and not t['child_mesh'].get(k):
                problems.append(f'{name}: child {k} lost its mesh')
    if problems:
        raise RuntimeError('GLB verification failed:\n  ' + '\n  '.join(problems))
    return tree


# ----------------------------------------------------------------------------
# Build + export
# ----------------------------------------------------------------------------

def build_set(set_name, only=None):
    C.reset_scene()
    _counter[0] = 0
    make_materials(set_name)
    built = []
    for spec in LANDMARKS:
        if spec['set'] != set_name or (only and spec['name'] not in only):
            continue
        L = spec['fn']()
        assert L.name == spec['name'], (L.name, spec['name'])
        root, objs, info = assemble(L, spec['budget'])
        built.append((spec, L, root, objs, info))
        print(f"  {spec['name']:<18} {info['total_triangles']:>6}/{spec['budget']:<6} tris"
              f"  size {info['size'][0]:.2f} x {info['size'][1]:.2f} x {info['size'][2]:.2f}"
              f"  {info['materials']}")
    return built


def child_names(L):
    names = [a[0] for a in L.anims] + [e[0] for e in L.empties] + [c[0] for c in L.cols]
    return names


def export_set(set_name, built, out=None, pack_args=PACK_ARGS):
    raw = os.path.join(BUILD_DIR, f'landmarks-{set_name}.raw.glb')
    dst = out or os.path.join(C.MODELS_DIR, f'landmarks-{set_name}.glb')
    if out:
        raw = out[:-4] + '.raw.glb'
    objs = [o for b in built for o in b[3]]
    C.export_glb(raw, objs)
    fix_names(raw)
    C.gltfpack(raw, dst, pack_args.split())
    expected = {b[1].name: child_names(b[1]) for b in built}
    verify(raw, expected)
    verify(dst, expected)
    return raw, dst


def report(set_name, built, dst, qa=False):
    rows = []
    for spec, L, root, objs, info in built:
        kids = child_names(L)
        rows.append(dict(name=L.name, tris=info['total_triangles'], body=info['triangles'],
                         anim=info['anim_triangles'], size=[round(s, 2) for s in info['size']],
                         materials=info['materials'], children=kids))
    path = os.path.join(BUILD_DIR, f'landmarks-{set_name}{".qa" if qa else ""}.report.json')
    C.write_json(path, dict(set=set_name, glb=os.path.relpath(dst, C.REPO_ROOT),
                            bytes=os.path.getsize(dst), landmarks=rows))
    return path


# ============================================================================
# SHARED
# ============================================================================

def sector(r0, r1, a0, a1, n=8):
    """CCW annular sector outline between radii r0 < r1 and angles a0 < a1 (radians)."""
    outer = [(r1 * math.cos(a0 + (a1 - a0) * i / (n - 1)), r1 * math.sin(a0 + (a1 - a0) * i / (n - 1)))
             for i in range(n)]
    inner = [(r0 * math.cos(a1 - (a1 - a0) * i / (n - 1)), r0 * math.sin(a1 - (a1 - a0) * i / (n - 1)))
             for i in range(n)]
    return outer + inner


def ccw(poly):
    return poly if _area(poly) > 0 else list(reversed(poly))


@landmark('landing_pad', 'shared')
def landing_pad():
    L = LM('landing_pad')
    L.densify = 2.4
    L.ao = dict(distance=1.4, samples=48, floor=0.5)
    L.grad = (-0.3, 0.25, 0.78)
    R = 7.0
    top = 0.25
    sides = 96
    g = top - 0.035   # floor of the inset Trim ring
    # Core disc (r, z) from the underside up: a dark recessed foot band under a floating rim lip,
    # the rim panels sit on a lower shelf (top - 0.05) between r 6.2 and 6.95.
    shelf = top - 0.06
    prof = [(0.0, -0.3), (6.85, -0.3), (6.85, 0.1), (6.9, 0.12), (6.9, shelf),
            (6.2, shelf), (6.2, top), (6.15, top), (6.11, g), (5.88, g), (5.58, g), (5.36, g), (5.32, top),
            (3.15, top), (3.0, top), (2.85, top), (1.35, top), (1.15, top), (0.0, top)]
    disc = lathe(prof, sides, 'Stone')

    def slot_for(c, n):
        r = math.hypot(c.x, c.y)
        if r > 6.19 and c.z < top - 0.02:
            return 'StoneDark'      # recessed foot band under the rim lip + the seams between panels
        if n.z < 0.5:
            return None
        if 5.34 < r < 6.12 and c.z < top - 0.01:
            a = (math.atan2(c.y, c.x) / TAU) % 1.0
            if 5.58 < r < 5.88 and int(a * 48) % 2 == 0:
                return 'Accent'                      # painted dashes in the inset ring
            return 'Trim'
        if r < 5.32 and c.z > top - 0.005:
            if 2.85 < r < 3.0 or 1.15 < r < 1.35:
                return 'Trim'
            return 'StoneDark'
        return None
    paint(disc, slot_for)
    L.add(disc)
    # 16 bevelled rim panels with 6 cm gaps; the four cardinal ones carry approach lights
    gap = 0.06
    for k in range(16):
        a0 = TAU * k / 16 + gap / 6.6 / 2 - TAU / 32
        a1 = TAU * (k + 1) / 16 - gap / 6.6 / 2 - TAU / 32
        pnl = prism(sector(6.24, 7.0, a0, a1, 7), 0.1, top, 'Stone', bevel=0.022, segs=2)
        L.add(pnl)
        if k % 4 == 0:
            ac = (a0 + a1) / 2
            lamp = prism(sector(6.5, 6.78, ac - 0.07, ac + 0.07, 5), top - 0.03, top + 0.012, 'Glow',
                         bevel=0.008, segs=1)
            L.add(lamp)
    # bold chevron pointing +Y (the back), raised 2.5 cm
    w, d, t = 1.3, 1.05, 0.72
    chev = ccw([(0.0, d), (-w, d - w * 0.8), (-w, d - w * 0.8 - t), (0.0, d - t), (w, d - w * 0.8 - t),
                (w, d - w * 0.8)])
    L.add(prism(chev, top - 0.02, top + 0.025, 'Accent', bevel=0.014, segs=1, loc=(0, 3.85, 0)))
    # crosshair ticks between the target rings and the dashed ring (front and sides only)
    for a in (-math.pi / 2, 0.0, math.pi):
        c = polar(4.05, a, top)
        L.add(box((1.1, 0.16, 0.04), c, 'Trim', bevel=0.012, segs=1, yaw=a))
    # centre hub: a low bevelled disc with a glowing seam
    L.add(cylinder(0.85, top - 0.02, top + 0.03, 32, 'Stone', chamfer=0.02))
    L.add(torus(0.585, 0.0, (0, 0, top + 0.03), 'Glow', major=40,
                section=[(-0.035, -0.004), (0.035, -0.004), (0.035, 0.006), (-0.035, 0.006)]))
    # four light posts on the rim panels at the diagonals: tapered octagonal posts, crystal lamps
    for k in range(4):
        a = math.radians(45 + 90 * k)
        p = polar(6.6, a)
        post = prism(ngon(8, 0.2, TAU / 16), 0, 0, 'StoneDark', bevel=0.02, segs=1,
                     levels=[(top - 0.02, 1.0, 0.0), (0.33, 1.0, 0.0), (0.38, 0.78, 0.0), (0.92, 0.66, 0.0)],
                     loc=p, yaw=a)
        foot = prism(ngon(8, 0.26, TAU / 16), top - 0.02, 0.33, 'Stone', bevel=0.02, segs=2, loc=p, yaw=a)
        collar = prism(ngon(8, 0.17, TAU / 16), 0.9, 0.97, 'Trim', bevel=0.012, segs=1, loc=p, yaw=a)
        lamp = prism(ngon(8, 0.13, TAU / 16), 0, 0, 'Glow', bevel=0.01, segs=1,
                     levels=[(0.96, 1.0, 0.0), (1.12, 1.0, 0.0), (1.2, 0.55, 0.0), (1.23, 0.2, 0.0)],
                     loc=p, yaw=a)
        L.add(post, foot, collar, lamp)
    L.empty('POI_board', (5.0, 0.0, top))
    L.col_cyl('COL_CYL_pad', (0, 0), R - 0.1, -0.3, top, sides=24)
    return L


def _area(poly):
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))


def front_profile(poly_xz, y0, y1, slot='Stone', bevel=0.0, segs=2, angle=30.0, pre=None):
    """Extrude a 2D front profile [(x, z), ...] along y from y0 to y1."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in poly_xz]
    b = [bm.verts.new((x, y1, z)) for x, z in poly_xz]
    n = len(poly_xz)
    for i in range(n):
        k = (i + 1) % n
        bm.faces.new((a[i], a[k], b[k], b[i]))
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    ob = obj(bm, slot)
    if pre:
        pre(ob)
    if bevel > 0.0:
        C.bevel(ob, bevel, segments=segs, angle=angle)
    return ob


def open_book(center, size=1.0, tilt=0.36, cover='Accent', yaw=0.0, ribbon=None, ribbon_len=0.11):
    """An open hardcover book in a shallow V: glowing pages with ivory page edges, a round spine,
    and a ribbon bookmark hanging from the near end of the spine. Tilted toward the reader (-Y).
    Returns the parts in landmark space; `center` is the book's own pivot."""
    s = size
    parts = []
    W, H = 0.30 * s, 0.42 * s
    rise = math.radians(11)
    for side in (-1, 1):
        cw = W + 0.03 * s
        cv = box((cw, H + 0.04 * s, 0.02 * s), (cw / 2 - 0.006 * s, 0.0, 0.0), cover, bevel=0.0075 * s, segs=1)
        n = 9
        bot, top_ = [], []
        for i in range(n):
            t = i / (n - 1)
            x = 0.012 * s + t * (W - 0.016 * s)
            bot.append((x, 0.008 * s))
            top_.append((x, 0.026 * s + 0.034 * s * (1.0 - t) ** 1.8 - 0.004 * s * t))
        pg = front_profile(bot + list(reversed(top_)), -H / 2, H / 2, 'Stone')
        paint(pg, lambda c, nn: 'Glow' if nn.z > 0.35 else None)
        for o in (cv, pg):
            C.transform(o, Matrix.Rotation(-rise, 4, 'Y'))
            if side < 0:
                C.transform(o, Matrix.Diagonal((-1, 1, 1, 1)))
                bmo = bmesh.new()
                bmo.from_mesh(o.data)
                bmesh.ops.reverse_faces(bmo, faces=bmo.faces[:])
                bmo.to_mesh(o.data)
                bmo.free()
            parts.append(o)
    spine = cylinder(0.026 * s, -H / 2 - 0.02 * s, H / 2 + 0.02 * s, 10, cover, pitch=math.pi / 2,
                     loc=(0, 0, -0.008 * s))
    parts.append(spine)
    M = Matrix.Translation(V(center)) @ rot(yaw, tilt, 0.0)
    for o in parts:  # positive pitch turns the page normal toward the reader at -Y
        C.transform(o, M)
    if ribbon:
        a = M @ V(0.12 * s, -H / 2 + 0.01 * s, 0.035 * s)
        b = a + V(0.012 * s, -0.012 * s, -ribbon_len * s)
        d = (b - a)
        rb = box((0.028 * s, 0.004 * s, d.length), (a + b) / 2, ribbon, bevel=0.0, yaw=yaw,
                 pitch=math.atan2(d.y, -d.z))
        parts.append(rb)
    return parts


@landmark('essay_plinth', 'shared')
def essay_plinth():
    L = LM('essay_plinth')
    L.ao = dict(distance=0.9, samples=48, floor=0.45)
    L.grad = (-0.1, 1.1, 0.8)
    foot = prism(chamfer_rect(1.0, 0.9, 0.12), -0.3, 0.14, 'StoneDark', bevel=0.025)
    step = prism(chamfer_rect(0.86, 0.76, 0.1), 0.1, 0.22, 'Stone', bevel=0.018)
    panel = lambda ob: inset_face(ob, lambda f: f.normal.y < -0.9, 0.075, 0.02, slot='StoneDark',
                                  wall_slot='Trim')
    shaft = prism(chamfer_rect(0.66, 0.56, 0.09), 0, 0, 'Stone', bevel=0.014, segs=2,
                  levels=[(0.2, 1.0, 0.0), (0.9, 0.8, 0.0)], pre=panel)
    collar = prism(chamfer_rect(0.6, 0.51, 0.08), 0.88, 0.95, 'Trim', bevel=0.01, segs=1)
    cap = prism(chamfer_rect(0.74, 0.64, 0.1), 0.95, 1.1, 'Stone', bevel=0.022)
    lens = cylinder(0.17, 1.09, 1.112, 20, 'Glow', chamfer=0.006)
    lens_ring = torus(0.195, 0.0, (0, 0, 1.1), 'Trim', major=20,
                      section=[(-0.028, -0.01), (0.028, -0.01), (0.028, 0.012), (0.018, 0.02), (-0.018, 0.02),
                               (-0.028, 0.012)])
    L.add(foot, step, shaft, collar, cap, lens, lens_ring)
    pivot = (0.0, -0.02, 1.5)
    L.anim('ANIM_BOB_book', open_book(pivot, 1.0, tilt=0.36), pivot, ao=None)
    L.empty('POI_read', (0.0, -1.6, 0.0))
    L.empty('LABEL_title', (0.0, -0.15, 2.45))
    L.col_box('COL_BOX_plinth', (0, 0, 0.4), (0.84, 0.74, 1.4))
    return L


def console_parts(scale=1.0, body='Stone', foot='StoneDark', cheek='Accent'):
    """The reading console (1.3 m at scale 1), facing -Y, origin on the ground. Returns parts."""
    S = Matrix.Diagonal((scale, scale, scale, 1.0))
    foot_ = prism(chamfer_rect(1.0, 0.8, 0.14), -0.3 / scale, 0.12, foot, bevel=0.025)
    plate = prism(chamfer_rect(0.74, 0.56, 0.1), 0.08, 0.17, 'Trim', bevel=0.012, segs=1)
    prof = [(-0.17, 0.05), (0.21, 0.05), (0.21, 0.18), (0.155, 0.32), (0.15, 0.62), (0.17, 0.88),
            (0.23, 1.17), (0.255, 1.27), (0.225, 1.325), (-0.355, 0.995), (-0.37, 0.94), (-0.31, 0.875),
            (-0.2, 0.76), (-0.13, 0.55), (-0.115, 0.32), (-0.17, 0.18)]
    screen = lambda ob: inset_face(ob, lambda f: f.normal.z > 0.6 and f.normal.y < -0.2, 0.045, 0.018,
                                   slot='Glow', wall_slot='StoneDark', border='Trim')
    body_ = side_profile(prof, -0.27, 0.27, body, bevel=0.02, segs=2, pre=screen)
    ck = [(-0.33, 0.955), (-0.28, 0.885), (-0.17, 0.80), (0.15, 0.86), (0.2, 1.1), (0.205, 1.24)]
    cheeks = [side_profile(ck, sx * 0.262, sx * 0.292, cheek, bevel=0.008, segs=1) for sx in (-1, 1)]
    lip = box((0.42, 0.02, 0.026), (0.0, -0.372, 0.935), 'Glow', bevel=0.006, segs=1)
    spine = side_profile([(0.14, 0.3), (0.165, 0.3), (0.175, 0.86), (0.15, 0.86)], -0.03, 0.03, 'Trim',
                         bevel=0.006, segs=1)
    parts = [foot_, plate, body_, lip, spine] + cheeks
    if scale != 1.0:
        for p in parts:
            C.transform(p, S)
    return parts


@landmark('archive_console', 'shared')
def archive_console():
    L = LM('archive_console')
    L.ao = dict(distance=0.9, samples=48, floor=0.45)
    L.grad = (-0.1, 1.3, 0.8)
    L.add(*console_parts())
    L.empty('POI_read', (0.0, -1.5, 0.0))
    L.empty('LABEL_title', (0.0, -0.1, 2.35))
    L.col_box('COL_BOX_console', (0, 0, 0.5), (0.8, 0.6, 1.6))
    return L


# ============================================================================
# PHILOSOPHY  (calm, sacred, luminous)
# ============================================================================

def tri_corners(r_in, cz, cx=0.0):
    """Upright equilateral triangle (apex up) with inradius r_in and centroid (cx, cz): [(x, z)] CCW."""
    return [(cx + 2 * r_in * math.cos(a), cz + 2 * r_in * math.sin(a))
            for a in (math.pi / 2, math.pi / 2 + TAU / 3, math.pi / 2 + 2 * TAU / 3)]


def _bw_layer(bm):
    return bm.edges.layers.float.get('bevel_weight_edge') or bm.edges.layers.float.new('bevel_weight_edge')


def tri_ring_points(r_in, cz, sub=1):
    """Corners of the centred upright triangle with `sub` points per side (corner first)."""
    cs = tri_corners(r_in, cz)
    pts = []
    for k in range(3):
        (x0, z0), (x1, z1) = cs[k], cs[(k + 1) % 3]
        for j in range(sub):
            t = j / sub
            pts.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    return pts


def tri_sweep(r_out, cz, profile, slot='Stone', slots=None, weights=None, wall_weight=1.0, bevel=0.16,
              segs=3, sub=1):
    """Sweep a closed cross-section [(d, y), ...] round an upright equilateral triangle in the XZ plane.

    Each profile point becomes a triangle ring of inradius r_out - d (d >= 0 measured inward from
    the outer edge) at depth y, so the corners come out mitred. slots[i] paints profile edge i -> i+1
    (None = `slot`). weights[i] is the bevel weight of ring i; the corner edges of wall-type profile
    edges (constant d) get `wall_weight`. The bevel is width x weight (limit method WEIGHT).
    """
    bm = bmesh.new()
    bw = _bw_layer(bm)
    rings = [[bm.verts.new((x, y, z)) for x, z in tri_ring_points(r_out - d, cz, sub)] for d, y in profile]
    n = len(profile)
    m = 3 * sub
    names = []
    for i in range(n):
        A, B = rings[i], rings[(i + 1) % n]
        for k in range(m):
            bm.faces.new((A[k], A[(k + 1) % m], B[(k + 1) % m], B[k]))
            names.append(slots[i] if slots else None)
        if abs(profile[i][0] - profile[(i + 1) % n][0]) < 1e-6:
            for k in range(0, m, sub):            # only the three true corners crease
                e = bm.edges.get((A[k], B[k]))
                if e:
                    e[bw] = wall_weight
    for i in range(n):
        w = weights[i] if weights else 1.0
        for k in range(m):
            e = bm.edges.get((rings[i][k], rings[i][(k + 1) % m]))
            if e:
                e[bw] = w
    ob = obj(bm, slot)
    me = ob.data
    idx = {s: C.slot_index(ob, s) for s in dict.fromkeys(x for x in names if x)}
    for p, s in zip(me.polygons, names):   # faces keep their creation order bmesh -> mesh
        if s:
            p.material_index = idx[s]
    if bevel > 0.0:
        C.bevel_weighted(ob, bevel, segments=segs)
    return ob


def tri_tip(r_out, cz, k, length=1.7, inward=1.0, margin=0.09, depth=1.0, slot='Accent', bevel=0.06):
    """A gilded cap over corner k of the triangle (0 = apex, 1 = bottom left, 2 = bottom right)."""
    pts = [Vector((x, 0.0, z)) for x, z in tri_corners(r_out, cz)]
    c = Vector((0.0, 0.0, cz))
    T = pts[k]
    out = (T - c).normalized()
    Tm = T + out * (2.0 * margin)
    e1 = (pts[(k + 1) % 3] - T).normalized()
    e2 = (pts[(k - 1) % 3] - T).normalized()
    A = Tm + e1 * length
    B = Tm + e2 * length
    n1 = c - (T + e1 * length)
    n1 = (n1 - e1 * n1.dot(e1)).normalized()
    n2 = c - (T + e2 * length)
    n2 = (n2 - e2 * n2.dot(e2)).normalized()
    Ai = A + n1 * (inward + margin)
    Bi = B + n2 * (inward + margin)
    poly = [(p.x, p.z) for p in (Tm, A, Ai, Bi, B)]
    ob = front_profile(ccw(poly), -depth, depth, slot)
    C.bevel(ob, bevel, segments=2, angle=30)
    return ob


def tri_prism(r_in, cz, depth, slot='Glass', edge_slot='Glow', bevel=0.18, cx=0.0, outline=None):
    """Solid equilateral triangular prism (triangle in XZ, extruded along Y) whose bevelled edges
    use edge_slot (glowing edges on a glass body). outline = (inset, width, height) adds an
    embossed glowing triangle outline on the front and back faces. Returns a list of parts."""
    ob = front_profile(tri_corners(r_in, cz, cx), -depth / 2, depth / 2, slot)
    C.bevel(ob, bevel, segments=1, angle=30)
    mains = [Vector((0, -1, 0)), Vector((0, 1, 0)), Vector((0, 0, -1)),
             Vector((math.cos(math.pi / 6), 0, 0.5)), Vector((-math.cos(math.pi / 6), 0, 0.5))]
    paint(ob, lambda c, n: None if max(n.dot(m) for m in mains) > 0.995 else edge_slot)
    parts = [ob]
    if outline:
        ins, w, h = outline
        for side in (-1, 1):
            y0 = side * depth / 2
            prof = [(ins, y0 - side * 0.01), (ins, y0 + side * h), (ins + w, y0 + side * h),
                    (ins + w, y0 - side * 0.01)]
            parts.append(tri_sweep(r_in, cz, prof, edge_slot, bevel=0.0, sub=1))
    return parts


@landmark('origin_monument', 'philosophy', budget=25000)
def origin_monument():
    L = LM('origin_monument')
    L.ao = dict(distance=3.0, samples=48, floor=0.45)
    L.grad = (-0.3, 3.0, 0.82)
    # --- three-step circular plinth, 15 m across, 0.35 m steps -------------------------------------
    radii = [7.5, 6.55, 5.6]
    tops = [0.35, 0.70, 1.05]
    prof = [(0.0, -0.3)]
    for i, (r, t) in enumerate(zip(radii, tops)):
        b = -0.3 if i == 0 else tops[i - 1]
        g0, g1 = (t - 0.22, t - 0.15)            # inset light line in the riser
        prof += [(r, b), (r, g0), (r - 0.05, g0), (r - 0.05, g1), (r, g1), (r, t - 0.06), (r - 0.06, t)]
        if i + 1 < len(radii):
            prof += [(radii[i + 1] + 0.14, t)]   # extra ring near the next riser (AO falloff)
    top = tops[-1]
    prof += [(5.12, top), (5.08, top - 0.025), (4.9, top - 0.025), (4.86, top), (2.6, top), (2.2, top),
             (0.0, top)]
    prof = [p for i, p in enumerate(prof) if i == 0 or p != prof[i - 1]]
    plinth = lathe(prof, 72, 'Stone')

    def plinth_slot(c, n):
        r = math.hypot(c.x, c.y)
        if abs(n.z) < 0.5 and any(abs(r - (rr - 0.05)) < 0.01 for rr in radii):
            return 'Trim'                                  # inset Trim light lines in the risers (spec)
        if n.z > 0.5 and 4.86 < r < 5.12 and c.z < top - 0.01:
            return 'Trim'                                  # inlaid ring on the top tier
        if n.z > 0.5 and r < 2.6 and c.z > top - 0.01:
            return 'StoneDark'                             # dark disc round the stem socket
        return None
    paint(plinth, plinth_slot)
    L.add(plinth)
    # dark socket drum (gold rim) where the stem is planted, and six inlaid rays across the top tier
    drum = lathe([(0.0, top - 0.05), (2.55, top - 0.05), (2.55, top + 0.26), (2.47, top + 0.34), (2.0, top + 0.34),
                  (1.95, top + 0.36), (1.95, top + 0.5), (1.88, top + 0.56), (0.0, top + 0.56)], 48, 'StoneDark')
    paint(drum, lambda c, n: 'Accent' if c.z > top + 0.345 and math.hypot(c.x, c.y) > 1.5 else None)
    L.add(drum)
    for k in range(6):
        a = math.radians(30 + 60 * k)
        L.add(box((2.0, 0.16, 0.05), polar(3.7, a, top), 'Accent', bevel=0.015, segs=1, yaw=a))
    # --- stem, cradle and crossbar (the small cross under the triangle in the site mark) -----------
    stem_top = 4.45
    cradle_h = 0.85
    stem = prism(chamfer_rect(2.0, 1.75, 0.26), 0, 0, 'StoneDark', bevel=0.07, segs=2,
                 levels=[(top, 1.0, 0.0), (stem_top - cradle_h, 0.84, 0.0)])
    cradle = side_profile([(-0.95, 0.0), (0.95, 0.0), (0.95, cradle_h), (-0.95, cradle_h)], -1.0, 1.0, 'Accent',
                          bevel=0.06, segs=2, loc=(0, 0, stem_top - cradle_h),
                          taper=lambda z: 1.0 + 0.95 * (z / cradle_h) ** 1.6)
    bar_z = 2.95
    bar_poly = [(-3.7, 0.0), (-3.25, -0.42), (3.25, -0.42), (3.7, 0.0), (3.25, 0.42), (-3.25, 0.42)]
    bar = front_profile(ccw(bar_poly), -0.55, 0.55, 'StoneDark', bevel=0.07, segs=2)
    place(bar, (0, 0, bar_z))
    tips = []
    for sx in (-1, 1):
        tip_poly = [(sx * 3.25, -0.5), (sx * 3.9, 0.0), (sx * 3.25, 0.5), (sx * 3.0, 0.5), (sx * 3.0, -0.5)]
        t_ = front_profile(ccw(tip_poly), -0.62, 0.62, 'Accent', bevel=0.05, segs=2)
        place(t_, (0, 0, bar_z))
        tips.append(t_)
    collar = prism(chamfer_rect(2.12, 1.9, 0.28), bar_z - 0.55, bar_z + 0.55, 'Accent', bevel=0.05, segs=2)
    L.add(stem, cradle, bar, collar, *tips)
    L.add(box((0.18, 0.06, 0.8), (0, -0.84, 2.0), 'Glow', bevel=0.02, segs=1, pitch=-0.045))
    L.add(box((4.9, 0.06, 0.12), (0, -0.56, bar_z), 'Glow', bevel=0.02, segs=1))
    # --- the triangle frame: 15 m sides (13 m tall) with a stepped, bevelled beam section -----------
    s = 15.0
    r_out = s / (2 * math.sqrt(3))
    W, D = 1.55, 1.1
    cz = stem_top + r_out
    fp = [(0.0, D), (0.0, -D), (0.62, -D), (0.62, -D + 0.12), (0.86, -D + 0.12), (0.86, -D + 0.2),
          (1.1, -D + 0.2), (1.1, -D + 0.12), (W, -D + 0.12), (W, D - 0.12), (1.1, D - 0.12), (1.1, D - 0.2),
          (0.86, D - 0.2), (0.86, D - 0.12), (0.62, D - 0.12), (0.62, D)]
    fs = [None] * 16
    for i in (4, 5, 6, 11, 12, 13):
        fs[i] = 'Trim'
    fw = [1.0, 1.0, 0.45, 0.12, 0.2, 0.08, 0.08, 0.2, 0.7, 0.7, 0.2, 0.08, 0.08, 0.2, 0.12, 0.45]
    frame = tri_sweep(r_out, cz, fp, 'Stone', slots=fs, weights=fw, wall_weight=1.0, bevel=0.18, segs=3, sub=10)
    L.add(frame)
    for k in range(3):
        L.add(tri_tip(r_out, cz, k, length=1.75 if k else 1.95, inward=0.66, margin=0.1, depth=D + 0.08))
    # --- floating, spinning glass core (the inner triangle of the mark) ------------------------------
    core = tri_prism(1.62, cz, 1.3, 'Glass', 'Glow', bevel=0.28, outline=(0.62, 0.13, 0.03))
    L.anim('ANIM_SPIN_core', core, (0.0, 0.0, cz), ao=None)
    L.empty('POI_archive', (0.0, -9.3, 0.0))
    L.empty('LABEL_title', (0.0, -0.6, cz + 2 * r_out + 1.6))
    # colliders: stacked step cylinders, the stem and the crossbar (the frame is overhead)
    for i, (r, t) in enumerate(zip(radii, tops)):
        L.col_cyl(f'COL_CYL_step_{i}', (0, 0), r - 0.08, -0.3, t, sides=24)
    L.col_box('COL_BOX_stem', (0, 0, (top + stem_top) / 2), (1.8, 1.55, stem_top - top))
    L.col_box('COL_BOX_crossbar', (0, 0, (top + bar_z + 0.42) / 2), (7.2, 0.95, bar_z + 0.42 - top))
    return L


def twisted_prism(poly, z0, z1, twist=0.0, scale1=1.0, steps=6, slot='Stone', smooth=True):
    """Extrude a CCW outline from z0 to z1 while rotating it by `twist` radians and scaling to scale1."""
    bm = bmesh.new()
    rings = []
    for i in range(steps + 1):
        t = i / steps
        z = z0 + (z1 - z0) * t
        a = twist * t
        s = 1.0 + (scale1 - 1.0) * t
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((s * (x * ca - y * sa), s * (x * sa + y * ca), z)) for x, y in poly])
    n = len(poly)
    for i in range(steps):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    return obj(bm, slot, smooth=smooth)


def shard(base, direction, length, radius, sides=6, belt=0.22, shoulder=0.62, tip_r=0.0, phase=0.0,
          slot='Glow', bend=None):
    """Faceted crystal shard: a short lower point, a column, a long upper point. Flat shaded.
    bend: optional Vector added (scaled by t^2) to bow the upper part (flame tongues)."""
    d = Vector(direction).normalized()
    u, v = C.basis(d)
    b = Vector(base)
    bm = bmesh.new()

    def ring(t, r):
        p = b + d * (length * t)
        if bend is not None:
            p += Vector(bend) * (t * t)
        return [bm.verts.new(p + (u * math.cos(phase + TAU * j / sides) + v * math.sin(phase + TAU * j / sides)) * r)
                for j in range(sides)]
    bot = bm.verts.new(b)
    r1 = ring(belt, radius)
    r2 = ring(shoulder, radius * 0.92)
    tip = b + d * length + (Vector(bend) if bend is not None else Vector())
    top = bm.verts.new(tip)
    for j in range(sides):
        k = (j + 1) % sides
        bm.faces.new((bot, r1[k], r1[j]))
        bm.faces.new((r1[j], r1[k], r2[k], r2[j]))
        bm.faces.new((r2[j], r2[k], top))
    return obj(bm, slot, smooth=False)


def pillar_base(L, top_z=0.62):
    """Shared stepped base of the three pillars: 3 m square, two steps, deep teal lower step."""
    s1 = prism(chamfer_rect(3.0, 3.0, 0.22), -0.3, 0.32, 'StoneDark', bevel=0.05, segs=2)
    s2 = prism(chamfer_rect(2.5, 2.5, 0.18), 0.28, top_z, 'Stone', bevel=0.045, segs=2)
    band = prism(chamfer_rect(2.62, 2.62, 0.19), 0.3, 0.36, 'Accent', bevel=0.015, segs=1)
    L.add(s1, s2, band)
    L.col_box('COL_BOX_step_0', (0, 0, (-0.3 + 0.32) / 2), (2.9, 2.9, 0.62))
    L.col_box('COL_BOX_step_1', (0, 0, (-0.3 + top_z) / 2), (2.4, 2.4, top_z + 0.3))


PLAQUE_Z = 1.6


def plaque_block(L, w, d, z0, z1, pw=1.1, ph=0.95, pz=PLAQUE_Z, slot='Stone', chamfer=0.18, taper=0.96,
                 bevel=0.06):
    """A chamfered block (z0..z1) whose front face carries an exact pw x ph recessed plaque centred
    at height pz, framed in gold. The game draws the roman numeral there: PLAQUE_numeral marks the
    centre of the recessed face (facing -Y)."""
    def sc(z):
        return 1.0 - (1.0 - taper) * (z - z0) / (z1 - z0)
    za, zb = pz - ph / 2, pz + ph / 2
    lv = [(z0, 1.0, 0.0), (za, sc(za), 0.0), (zb, sc(zb), 0.0), (z1, taper, 0.0)]
    poly = chamfer_rect(w, d, chamfer)
    x, y = w / 2, d / 2
    poly = poly[:7] + [(-pw / 2 / sc(pz), -y), (pw / 2 / sc(pz), -y)] + poly[7:]
    depth = 0.07

    def pre(ob):
        inset_face(ob, lambda f: f.normal.y < -0.9 and abs(f.calc_center_median().x) < 0.05
                   and za < f.calc_center_median().z < zb, 0.0, depth, slot='StoneDark', wall_slot='Accent')
    blk = prism(poly, 0, 0, slot, bevel=bevel, segs=2, levels=lv, pre=pre)
    L.empty('PLAQUE_numeral', (0.0, -y * sc(pz) + depth, pz))
    return blk


def stone_block(w, d, h, z, yaw=0.0, off=(0.0, 0.0), rng=None, slot='Stone', bevel=0.1, taper=0.97,
                chamfer=0.22):
    j = (lambda a: rng.uniform(-a, a)) if rng else (lambda a: 0.0)
    poly = [(px + j(0.03), py + j(0.03)) for px, py in chamfer_rect(w, d, chamfer + j(0.05))]
    blk = prism(poly, 0.0, h, slot, bevel=bevel, segs=3,
                levels=[(0.0, 1.0, 0.0), (h * 0.5, 1.0 - (1 - taper) * 0.3, 0.0), (h, taper, 0.0)])
    place(blk, (off[0], off[1], z), yaw)
    return blk


@landmark('pillar_health', 'philosophy')
def pillar_health():
    L = LM('pillar_health')
    L.ao = dict(distance=1.8, samples=48, floor=0.45)
    L.grad = (-0.3, 3.0, 0.82)
    rng = C.rng_for('pillar_health')
    pillar_base(L)
    z = 0.62
    blk = plaque_block(L, 2.2, 2.0, 0.0, 1.85, pz=PLAQUE_Z - z, chamfer=0.24, taper=0.975, bevel=0.1)
    place(blk, (0, 0, z))
    L.empty_shift('PLAQUE_numeral', (0, 0, z))
    L.add(blk)
    z += 1.85
    # alternating wide slabs and tall stones: a stacked-stone silhouette that steps in and out
    stack = [('slab', 2.42, 2.22, 0.34), ('stone', 1.96, 1.8, 1.28), ('slab', 2.16, 1.98, 0.3),
             ('stone', 1.74, 1.62, 1.08), ('slab', 1.94, 1.8, 0.27), ('stone', 1.54, 1.44, 0.84)]
    for kind, w, d, h in stack:
        yaw = rng.uniform(-0.1, 0.1) if kind == 'slab' else rng.uniform(-0.045, 0.045)
        off = (rng.uniform(-0.05, 0.05), rng.uniform(-0.04, 0.04))
        L.add(stone_block(w, d, h, z - 0.02, yaw, off, rng, bevel=0.085 if kind == 'slab' else 0.11,
                          taper=0.99 if kind == 'slab' else 0.965, chamfer=0.26 if kind == 'slab' else 0.22))
        z += h - 0.02
    top = z
    cup = lathe([(0.0, top - 0.06), (0.6, top - 0.06), (0.66, top + 0.05), (0.93, top + 0.3), (1.0, top + 0.42),
                 (0.92, top + 0.45), (0.0, top + 0.45)], 32, 'Accent')
    R = 1.12
    rim_r, rim_z = 0.92, top + 0.45
    cz = rim_z + math.sqrt(R * R - rim_r * rim_r)
    orb = uvsphere(R, (0, 0, cz), 'StoneDark', segs=40, rings=20)
    seam = torus(R * 0.995, 0.035, (0, 0, cz), 'Glow', major=48, minor=6)
    L.add(cup, orb, seam)
    L.empty('POI_read', (0.0, -3.3, 0.0))
    L.empty('LABEL_title', (0.0, -0.9, cz + R + 1.2))
    L.col_box('COL_BOX_shaft', (0, 0, (0.62 + top) / 2), (2.0, 1.8, top - 0.62))
    L.col_cyl('COL_CYL_crown', (0, 0), 0.95, top, cz + R)
    return L


@landmark('pillar_family', 'philosophy')
def pillar_family():
    L = LM('pillar_family')
    L.ao = dict(distance=1.8, samples=48, floor=0.45)
    L.grad = (-0.3, 3.0, 0.82)
    pillar_base(L)
    z0 = 0.62
    pb_top = 2.6
    blk = plaque_block(L, 2.05, 1.65, 0.0, pb_top - z0, pz=PLAQUE_Z - z0, chamfer=0.2, taper=0.95)
    place(blk, (0, 0, z0))
    L.empty_shift('PLAQUE_numeral', (0, 0, z0))
    L.add(blk)
    L.add(prism(chamfer_rect(1.86, 1.5, 0.2), pb_top - 0.06, pb_top + 0.1, 'Accent', bevel=0.03, segs=2))
    # twin columns leaning gently together (two lives, one centre), each with a teal line: "II"
    col_top = 6.15
    hgt = col_top - pb_top
    lean = 0.032
    for sx in (-1, 1):
        c = prism(chamfer_rect(0.74, 0.7, 0.11), 0.0, hgt + 0.2, 'Stone', bevel=0.045, segs=2,
                  levels=[(0.0, 1.0, 0.0), (hgt + 0.2, 0.9, 0.0)])
        line = box((0.12, 0.05, hgt - 0.9), (0.0, -0.335, hgt / 2 + 0.05), 'Trim', bevel=0.015, segs=1,
                   pitch=-0.016)
        for o in (c, line):          # tops lean in toward each other
            place(o, (sx * 0.5, 0.0, pb_top + 0.02), roll=-sx * lean)
        L.add(c, line)
    for zb in (3.55, 5.05):
        w = 2 * (0.5 - (zb - pb_top) * math.tan(lean)) + 0.86
        L.add(prism(chamfer_rect(w, 0.86, 0.12), zb - 0.13, zb + 0.13, 'Accent', bevel=0.03, segs=2))
    L.add(prism(chamfer_rect(1.9, 1.15, 0.16), col_top - 0.05, col_top + 0.38, 'Stone', bevel=0.06, segs=2))
    L.add(prism(chamfer_rect(1.66, 0.98, 0.13), col_top + 0.38, col_top + 0.48, 'Accent', bevel=0.02, segs=1))
    L.add(cylinder(0.38, col_top + 0.46, col_top + 0.51, 24, 'Glow', chamfer=0.01))
    R, r = 0.86, 0.13
    za = col_top + 0.51 + 0.3 + R + r
    zb = za + R
    sec = [(r * math.cos(TAU * j / 10), r * 1.25 * math.sin(TAU * j / 10)) for j in range(10)]
    ring_a = torus(R, r, (0, 0, za), 'Accent', major=40, minor=10, pitch=math.pi / 2, section=sec)
    ring_b = torus(R, r, (0, 0, zb), 'Trim', major=40, minor=10, pitch=math.pi / 2, yaw=math.pi / 2, section=sec)
    L.anim('ANIM_SPIN_rings', [ring_a, ring_b], (0.0, 0.0, (za + zb) / 2), ao=None)
    L.empty('POI_read', (0.0, -3.3, 0.0))
    L.empty('LABEL_title', (0.0, -0.9, zb + R + r + 1.2))
    L.col_box('COL_BOX_shaft', (0, 0, (0.62 + col_top + 0.5) / 2), (1.85, 1.45, col_top + 0.5 - 0.62))
    return L


@landmark('pillar_mission', 'philosophy')
def pillar_mission():
    L = LM('pillar_mission')
    L.ao = dict(distance=1.8, samples=48, floor=0.45)
    L.grad = (-0.3, 3.0, 0.82)
    pillar_base(L)
    z0 = 0.62
    pb_top = 2.6
    blk = plaque_block(L, 2.05, 1.7, 0.0, pb_top - z0, pz=PLAQUE_Z - z0, chamfer=0.2, taper=0.95)
    place(blk, (0, 0, z0))
    L.empty_shift('PLAQUE_numeral', (0, 0, z0))
    L.add(blk)
    tri = [(math.cos(a) * 0.86, math.sin(a) * 0.86) for a in (math.pi / 2, math.pi / 2 + TAU / 3, math.pi / 2 + 2 * TAU / 3)]
    hexa = []
    for i in range(3):
        p0, p1, p2 = Vector(tri[i - 1] + (0,)), Vector(tri[i] + (0,)), Vector(tri[(i + 1) % 3] + (0,))
        a = p1 + (p0 - p1).normalized() * 0.3
        b = p1 + (p2 - p1).normalized() * 0.3
        hexa += [(a.x, a.y), (b.x, b.y)]
    shaft_top = 6.0
    shaft = twisted_prism(ccw(hexa), pb_top - 0.05, shaft_top, twist=math.radians(60), scale1=0.72, steps=10)
    C.bevel(shaft, 0.045, segments=2, angle=25)
    L.add(shaft)
    L.add(prism(chamfer_rect(1.6, 1.32, 0.22), pb_top - 0.06, pb_top + 0.14, 'Accent', bevel=0.03, segs=2))
    bz = shaft_top - 0.1
    L.add(lathe([(0.0, bz), (0.55, bz), (0.62, bz + 0.12), (0.95, bz + 0.5), (1.03, bz + 0.62), (0.95, bz + 0.65),
                 (0.0, bz + 0.65)], 30, 'Accent'))
    # three curved claws hold the flame (one behind, two at the front corners)
    for k in range(3):
        a = math.pi / 2 + TAU * k / 3
        path = [polar(0.9, a, bz + 0.5), polar(1.06, a, bz + 0.95), polar(1.02, a, bz + 1.4), polar(0.8, a, bz + 1.8)]
        bm, _ = C.tube(path, [0.12, 0.11, 0.085, 0.05], sides=6, end_tip=polar(0.68, a, bz + 2.0))
        L.add(obj(bm, 'Accent', smooth=True))
    # faceted flame crystal: a tall core and tongues that bow out and curl back in
    fz = bz + 0.4
    rng = C.rng_for('pillar_mission_flame')
    flame = [shard((0, 0, fz), (0.0, 0.03, 1.0), 3.0, 0.46, sides=6, belt=0.16, shoulder=0.48, phase=0.3,
                   bend=(0.08, -0.05, 0.0))]
    for k in range(6):
        a = math.radians(10 + 60 * k) + rng.uniform(-0.2, 0.2)
        ln = rng.uniform(1.5, 2.3)
        flame.append(shard(polar(0.3, a, fz + 0.04), (math.cos(a) * 0.38, math.sin(a) * 0.38, 1.0), ln,
                           rng.uniform(0.22, 0.28), sides=5, belt=0.18, shoulder=0.48, phase=a,
                           bend=(-math.cos(a) * 0.5, -math.sin(a) * 0.5, 0.05)))
    for k in range(4):
        a = math.radians(40 + 90 * k)
        flame.append(shard(polar(0.5, a, fz + 0.06), (math.cos(a) * 0.5, math.sin(a) * 0.5, 1.0), 0.8, 0.16,
                           sides=5, belt=0.25, shoulder=0.5, phase=a, bend=(-math.cos(a) * 0.2, -math.sin(a) * 0.2, 0.0)))
    L.anim('ANIM_PULSE_flame', flame, (0.0, 0.0, fz), ao=None)
    L.empty('POI_read', (0.0, -3.3, 0.0))
    L.empty('LABEL_title', (0.0, -0.9, fz + 3.0 + 1.2))
    L.col_box('COL_BOX_shaft', (0, 0, (0.62 + bz + 0.6) / 2), (1.8, 1.45, bz + 0.6 - 0.62))
    return L


@landmark('depth_span', 'philosophy')
def depth_span():
    L = LM('depth_span')
    L.ao = dict(distance=2.0, samples=48, floor=0.42)
    L.grad = (-0.3, 2.0, 0.84)
    # --- the well: a raised ring on a low plinth, terraces stepping down to a dark centre ------------
    terr = [(3.3, 0.92), (2.78, 0.78), (2.26, 0.64), (1.76, 0.5), (1.28, 0.38), (0.84, 0.28)]
    prof = [(0.0, -0.3), (4.75, -0.3), (4.75, 0.12), (4.67, 0.2), (4.08, 0.2), (4.0, 0.26), (4.0, 0.86),
            (4.06, 0.9), (4.06, 0.98), (4.0, 1.02), (3.98, 1.08), (3.92, 1.12), (3.42, 1.12), (3.36, 1.08),
            (3.3, 1.02)]
    for i, (r, z) in enumerate(terr):
        prof.append((r, z))
        nr = terr[i + 1][0] if i + 1 < len(terr) else 0.24
        prof.append((nr + 0.03, z))
        if i + 1 < len(terr):
            prof.append((nr, z - 0.012))
    prof += [(0.24, 0.28), (0.0, 0.28)]
    prof = [p for i, p in enumerate(prof) if i == 0 or p != prof[i - 1]]
    well = lathe(prof, 72, 'Stone')

    def well_slot(c, n):
        r = math.hypot(c.x, c.y)
        if r < 3.32:
            if abs(n.z) < 0.6 or r < 0.24:
                return 'Glow'          # glowing risers: rings of light receding into the dark
            return 'StoneDark'
        if 3.98 < r < 4.07 and 0.88 < c.z < 1.0:
            return 'Trim'
        if r > 4.07 and c.z < 0.21:
            return 'StoneDark'         # low plinth ring
        if 3.45 < r < 3.9 and n.z > 0.9:
            return 'Accent'            # gold coping on the rim
        return None
    paint(well, well_slot)
    L.add(well)
    # --- the span: a graceful tapered arch over the well, 9 m high ----------------------------------
    X, H = 11.3, 9.0
    n = 48
    pts = []
    for i in range(n + 1):
        t = -1.0 + 2.0 * i / n
        z = H * math.cos(math.pi / 2 * t) ** 0.9 if abs(t) < 1.0 else 0.0
        pts.append((X * t, z))
    pts[0] = (pts[0][0], -0.4)
    pts[-1] = (pts[-1][0], -0.4)

    def taper(i):
        t = abs(-1.0 + 2.0 * i / n)
        return (0.58 + 0.42 * t ** 1.5, 0.74 + 0.26 * t ** 1.3)
    h, d, c = 0.82, 0.72, 0.2
    sec = [(h, -d + c), (h, d - c), (h - c, d), (-h + c, d), (-h, d - c), (-h, -d + c), (-h + c, -d), (h - c, -d)]
    arch = planar_arch(pts, sec, 'Stone', scale=taper)
    L.add(arch)
    inner = pts[3:-3]
    L.add(planar_arch(inner, [(-0.76, -0.17), (-0.76, 0.17), (-0.86, 0.17), (-0.86, -0.17)], 'Glow',
                      scale=lambda i: taper(i + 3)))
    for side in (-1, 1):
        L.add(planar_arch(inner, [(0.14, side * 0.7), (0.14, side * 0.76), (-0.14, side * 0.76), (-0.14, side * 0.7)],
                          'Trim', scale=lambda i: taper(i + 3)))
    # plumb line from the crown of the arch to a glowing drop hanging over the centre of the well
    apex_under = H - h * 0.58
    L.add(cylinder(0.035, 3.75, apex_under + 0.05, 8, 'Trim'))
    L.add(lathe([(0.0, apex_under - 0.25), (0.12, apex_under - 0.25), (0.2, apex_under - 0.08),
                 (0.24, apex_under + 0.05), (0.0, apex_under + 0.05)], 12, 'Accent'))
    L.add(lathe([(0.0, 3.6), (0.13, 3.62), (0.16, 3.72), (0.08, 3.8), (0.0, 3.8)], 12, 'Accent'))
    L.add(shard((0, 0, 3.66), (0, 0, -1), 1.15, 0.27, sides=6, belt=0.22, shoulder=0.42, phase=0.0))
    for sx in (-1, 1):
        p = (sx * X, 0, 0)
        L.add(prism(chamfer_rect(3.0, 2.5, 0.34), -0.3, 0.42, 'StoneDark', bevel=0.06, segs=2, loc=p))
        L.add(prism(chamfer_rect(2.45, 2.05, 0.28), 0.36, 0.92, 'Stone', bevel=0.06, segs=2, loc=p))
        L.add(prism(chamfer_rect(2.0, 1.72, 0.24), 0.88, 1.06, 'Accent', bevel=0.035, segs=2, loc=p))
        L.add(box((0.5, 0.06, 0.14), (sx * X, -1.06, 0.62), 'Glow', bevel=0.02, segs=1))
        L.col_box(f'COL_BOX_foot_{0 if sx < 0 else 1}', (sx * X, 0, 0.38), (2.85, 2.35, 1.36))
    for k in range(12):
        a = TAU * (k + 0.5) / 12
        L.col_box(f'COL_BOX_rim_{k}', polar(3.68, a, 0.4), (2.0, 0.66, 1.4), yaw=a + math.pi / 2)
    L.empty('POI_read', (0.0, -6.6, 0.0))
    L.empty('LABEL_title', (0.0, -0.6, H + 1.6))
    return L


def glyph_strokes(n):
    """Abstract glyph n (1..5), as strokes [(x0, z0, x1, z1)] and dots [(x, z, r)] in a ~0.6 x 0.8 m field.
    Complexity grows with n: one stroke, a chevron, a triangle, a diamond, the triangle-over-cross mark."""
    if n == 1:
        return [(0.0, -0.32, 0.0, 0.32)], []
    if n == 2:
        return [(-0.24, 0.26, 0.0, -0.24), (0.0, -0.24, 0.24, 0.26)], []
    if n == 3:
        c = [(0.0, 0.3), (-0.29, -0.22), (0.29, -0.22)]
        return [(c[i][0], c[i][1], c[(i + 1) % 3][0], c[(i + 1) % 3][1]) for i in range(3)], []
    if n == 4:
        c = [(0.0, 0.36), (0.27, 0.0), (0.0, -0.36), (-0.27, 0.0)]
        return [(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1]) for i in range(4)], [(0.0, 0.0, 0.06)]
    c = [(0.0, 0.38), (-0.27, -0.08), (0.27, -0.08)]
    s = [(c[i][0], c[i][1], c[(i + 1) % 3][0], c[(i + 1) % 3][1]) for i in range(3)]
    s += [(0.0, -0.08, 0.0, -0.38), (-0.15, -0.25, 0.15, -0.25)]
    return s, []


def glyph_parts(n, origin, yaw, w=0.075, t=0.05, slot='Glow', scale=1.0):
    strokes, dots = glyph_strokes(n)
    parts = []
    M = Matrix.Translation(V(origin)) @ rot(yaw)
    for x0, z0, x1, z1 in strokes:
        x0, z0, x1, z1 = x0 * scale, z0 * scale, x1 * scale, z1 * scale
        dx, dz = x1 - x0, z1 - z0
        ln = math.hypot(dx, dz)
        b = box((ln + w, t, w), ((x0 + x1) / 2, 0.0, (z0 + z1) / 2), slot, bevel=0.014, segs=1,
                roll=-math.atan2(dz, dx))
        C.transform(b, M)
        parts.append(b)
    for x, z, r in dots:
        d = cylinder(r * scale, -t / 2, t / 2, 12, slot, chamfer=0.01, pitch=math.pi / 2, loc=(x * scale, 0.0, z * scale))
        C.transform(d, M)
        parts.append(d)
    return parts


@landmark('filter_stones', 'philosophy')
def filter_stones():
    L = LM('filter_stones')
    L.ao = dict(distance=1.6, samples=48, floor=0.42)
    L.grad = (-0.3, 2.5, 0.8)
    rng = C.rng_for('filter_stones')
    xs = [-11.0, -5.5, 0.0, 5.5, 11.0]
    hs = [2.5, 3.05, 3.6, 3.2, 2.45]
    ws = [1.5, 1.62, 1.78, 1.6, 1.46]
    pw, ph = 0.9, 1.22
    for i, (x, h, w) in enumerate(zip(xs, hs, ws)):
        y = -0.02 * x * x
        yaw = math.atan2(-x, 25.0 + y)
        lean = (rng.uniform(-0.035, 0.035), rng.uniform(-0.035, 0.035))
        d = 0.92 + rng.uniform(-0.05, 0.06)
        pz = min(1.65, h * 0.5)
        za, zb = pz - ph / 2, pz + ph / 2

        def sc(z):
            return 1.06 - 0.16 * max(0.0, z) / h
        hw = d / 2
        cc = 0.3
        poly = [(w / 2, -hw + cc), (w / 2, hw - cc), (w / 2 - cc, hw), (-w / 2 + cc, hw), (-w / 2, hw - cc),
                (-w / 2, -hw + cc), (-w / 2 + cc, -hw), (-pw / 2 / sc(pz), -hw), (pw / 2 / sc(pz), -hw), (w / 2 - cc, -hw)]
        poly = [(px + rng.uniform(-0.02, 0.02), py) for px, py in poly]
        lv = [(-0.3, sc(-0.3), 0.0), (za, sc(za), 0.0), (zb, sc(zb), 0.0), (h * 0.86, sc(h * 0.86), 0.0), (h, sc(h), 0.0)]
        bm, _ = C.extrude_profile(poly, lv)
        tilt = rng.choice((-1, 1)) * rng.uniform(0.25, 0.4)
        C.chisel(bm, (0.0, 0.0, h - 0.16), (math.sin(tilt), rng.uniform(-0.25, -0.05), 1.0))
        C.chisel(bm, (0.0, -hw * 0.8, h - 0.3), (0.0, -0.75, 1.0))
        C.chisel(bm, (-math.copysign(w * 0.42, tilt), 0.0, h - 0.25), (-math.copysign(0.8, tilt), 0.0, 1.0))
        stone = obj(bm, 'Stone')
        inset_face(stone, lambda f: f.normal.y < -0.9 and abs(f.calc_center_median().x) < 0.06
                   and za < f.calc_center_median().z < zb, 0.0, 0.08, slot='StoneDark', wall_slot='Trim')
        C.bevel(stone, 0.075, segments=2, angle=30)
        y_face = -hw * sc(pz) + 0.08
        glyph = glyph_parts(i + 1, (0.0, y_face - 0.03, pz), 0.0, w=0.1, t=0.06, scale=1.28)
        collar = prism(chamfer_rect(w + 0.7, d + 0.62, 0.34), -0.3, 0.1, 'StoneDark', bevel=0.04, segs=2)
        band = prism(chamfer_rect(w * 1.06 + 0.06, d * 1.06 + 0.06, 0.32), 0.0, 0.16, 'Accent', bevel=0.02, segs=1)
        rocks = [rubble((rng.uniform(-1, 1) * (w / 2 + 0.5), rng.choice((-1, 1)) * (d / 2 + 0.45), 0.05),
                        rng.uniform(0.16, 0.28), rng, slot='Stone') for _ in range(3)]
        for o in [stone, collar, band] + glyph:
            C.transform(o, Matrix.Translation((x, y, 0.0)) @ rot(yaw, lean[0], lean[1]))
        for o in rocks:
            C.transform(o, Matrix.Translation((x, y, 0.0)) @ rot(yaw))
        L.add(stone, collar, band, *glyph, *rocks)
        L.col_box(f'COL_BOX_stone_{i}', (x, y, (h - 0.3) / 2), (w - 0.1, d - 0.05, h + 0.3), yaw=yaw)
    L.empty('POI_read', (0.0, -2.7, 0.0))
    L.empty('LABEL_title', (0.0, -0.8, 3.6 + 1.4))
    return L


def lectern(x, y, z0, book_name, L, yaw=0.0, height=1.18):
    """A slender reading lectern on the pavilion floor holding a bobbing, glowing book."""
    parts = []
    parts.append(prism(chamfer_rect(0.62, 0.52, 0.1), z0 - 0.02, z0 + 0.1, 'StoneDark', bevel=0.02, segs=1))
    parts.append(prism(chamfer_rect(0.3, 0.26, 0.06), 0, 0, 'Stone', bevel=0.02, segs=1,
                       levels=[(z0 + 0.08, 1.0, 0.0), (z0 + height - 0.2, 0.86, 0.0)]))
    tilt = math.radians(26)
    head = box((0.62, 0.46, 0.08), (0.0, 0.0, z0 + height - 0.08), 'Stone', bevel=0.025, segs=2, pitch=tilt)
    lip = box((0.56, 0.04, 0.06), (0.0, -0.215, z0 + height - 0.155), 'Accent', bevel=0.012, segs=1, pitch=tilt)
    collar = prism(chamfer_rect(0.36, 0.32, 0.07), z0 + height - 0.24, z0 + height - 0.17, 'Accent', bevel=0.01, segs=1)
    parts += [head, lip, collar]
    for o in parts:
        C.transform(o, Matrix.Translation((x, y, 0.0)) @ rot(yaw))
    L.add(*parts)
    pivot = Vector((x, y, z0 + height + 0.24))
    L.anim(book_name, open_book(pivot, 0.86, tilt=0.5, yaw=yaw), pivot, ao=None)


def _curve_strip(pts, w, h, slot='Glow'):
    """A thin rectangular bar swept along points lying in a vertical XZ-ish plane (width across Y)."""
    nors = []
    n = len(pts)
    for i in range(n):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        nors.append(Vector((-t.z, 0.0, t.x)).normalized())
    return sweep(pts, [(h / 2, -w / 2), (h / 2, w / 2), (-h / 2, w / 2), (-h / 2, -w / 2)], slot, normals=nors,
                 binormal=Vector((0, 1, 0)))


@landmark('reading_pavilion', 'philosophy')
def reading_pavilion():
    L = LM('reading_pavilion')
    L.ao = dict(distance=2.2, samples=48, floor=0.45)
    L.grad = (-0.3, 3.0, 0.84)
    fz = 0.3
    # coplanar inlay bands on the floor top (same-height levels scaled about the centre)
    bands = [0.86, 0.845, 0.79, 0.778]
    floor = prism(chamfer_rect(9.0, 7.0, 0.5), 0, 0, 'Stone', bevel=0.05, segs=2,
                  levels=[(-0.3, 1.0, 0.0), (fz, 1.0, 0.0)] + [(fz, s, 0.0) for s in bands])

    def floor_slot(c, n):
        if n.z < 0.99 or c.z < fz - 0.01:
            return None
        e = max(abs(c.x) / 4.5, abs(c.y) / 3.5)
        if bands[1] < e < bands[0] or bands[3] < e < bands[2]:
            return 'Accent'
        if bands[2] < e < bands[1]:
            return 'StoneDark'
        return None
    paint(floor, floor_slot)
    step = prism(chamfer_rect(3.4, 0.9, 0.1), -0.3, 0.15, 'Stone', bevel=0.04, segs=2, loc=(0, -3.8, 0))
    L.add(floor, step)
    # columns (their capitals rise into the curved roof slab)
    cx, cy = 3.85, 2.85
    col_h = 5.5
    RX = 5.1

    def lift(x):
        return 0.42 * (x / RX) ** 2
    for sx in (-1, 1):
        for sy in (-1, 1):
            p = (sx * cx, sy * cy, 0.0)
            base = prism(chamfer_rect(0.72, 0.72, 0.12), fz - 0.02, fz + 0.28, 'Stone', bevel=0.03, segs=2, loc=p)
            ring = lathe([(0.0, fz + 0.26), (0.28, fz + 0.26), (0.28, fz + 0.34), (0.0, fz + 0.34)], 20, 'Accent', loc=p)
            shaft = lathe([(0.0, fz + 0.3), (0.21, fz + 0.3), (0.2, fz + 2.6), (0.175, fz + col_h - 0.45),
                           (0.0, fz + col_h - 0.45)], 20, 'Stone', loc=p)
            capr = lathe([(0.0, fz + col_h - 0.5), (0.2, fz + col_h - 0.5), (0.26, fz + col_h - 0.38),
                          (0.3, fz + col_h - 0.3), (0.0, fz + col_h - 0.3)], 20, 'Accent', loc=p)
            cap = prism(chamfer_rect(0.74, 0.74, 0.12), fz + col_h - 0.32, fz + col_h + lift(cx) + 0.06, 'Stone',
                        bevel=0.03, segs=2, loc=p)
            L.add(base, ring, shaft, capr, cap)
            L.col_cyl(f'COL_CYL_column_{"lr"[sx > 0]}{"fb"[sy > 0]}', (p[0], p[1]), 0.3, -0.3, fz + col_h)
    # gently curved roof slab: the ends lift, the edge thins, a gold fascia band and a glowing coffer
    RY = 4.1
    nx_, ny_ = 26, 12
    z_roof = fz + col_h

    def thick(x, y):
        e = max(abs(x) / RX, abs(y) / RY)
        return 0.42 - 0.2 * e ** 2
    bm = bmesh.new()
    topv, botv = {}, {}
    for i in range(nx_ + 1):
        for j in range(ny_ + 1):
            x = -RX + 2 * RX * i / nx_
            y = -RY + 2 * RY * j / ny_
            zb = z_roof + lift(x)
            botv[i, j] = bm.verts.new((x, y, zb))
            topv[i, j] = bm.verts.new((x, y, zb + thick(x, y)))
    for i in range(nx_):
        for j in range(ny_):
            bm.faces.new((topv[i, j], topv[i + 1, j], topv[i + 1, j + 1], topv[i, j + 1]))
            bm.faces.new((botv[i, j + 1], botv[i + 1, j + 1], botv[i + 1, j], botv[i, j]))
    edge = [(i, 0) for i in range(nx_)] + [(nx_, j) for j in range(ny_)] + \
           [(i, ny_) for i in range(nx_, 0, -1)] + [(0, j) for j in range(ny_, 0, -1)]
    for a, b in zip(edge, edge[1:] + edge[:1]):
        bm.faces.new((botv[a], botv[b], topv[b], topv[a]))
    roof = obj(bm, 'Stone')
    C.bevel(roof, 0.05, segments=2, angle=50)
    paint(roof, lambda c, n: 'Accent' if abs(n.z) < 0.5 else None)
    L.add(roof)
    # a small lantern crowns the roof: the reading light of the pavilion
    lz = z_roof + thick(0.0, 0.0)
    L.add(prism(chamfer_rect(0.9, 0.9, 0.2), lz - 0.05, lz + 0.14, 'Accent', bevel=0.03, segs=2))
    L.add(uvsphere(0.3, (0, 0, lz + 0.42), 'Glow', segs=16, rings=8))
    L.add(lathe([(0.0, lz + 0.62), (0.28, lz + 0.62), (0.3, lz + 0.68), (0.12, lz + 0.8), (0.0, lz + 0.86)], 16, 'Accent'))
    for k in range(4):
        a = TAU * k / 4 + TAU / 8
        L.add(box((0.06, 0.06, 0.52), polar(0.3, a, lz + 0.4), 'Accent', bevel=0.01, segs=1))
    # glowing coffer line under the roof
    for y0 in (-3.2, 3.2):          # coffer lines follow the curved underside
        pts = [Vector((x, y0, z_roof + lift(x) - 0.012)) for x in [-4.25 + 8.5 * i / 16 for i in range(17)]]
        L.add(sweep(pts, [(0.05, 0.02), (-0.05, 0.02), (-0.05, -0.02), (0.05, -0.02)], 'Glow', up=None)
              if False else _curve_strip(pts, 0.1, 0.04))
    for x0 in (-4.2, 4.2):
        L.add(box((0.1, 6.5, 0.04), (x0, 0, z_roof + lift(x0) - 0.01), 'Glow', bevel=0.0))
    # three lecterns with bobbing books
    for k, x in enumerate((-2.55, 0.0, 2.55)):
        lectern(x, 0.9, fz, f'ANIM_BOB_book_{k}', L, yaw=0.0, height=1.22)
        L.empty(f'POI_essay_{k}', (x, -0.75, fz))
        L.col_box(f'COL_BOX_lectern_{k}', (x, 0.9, fz + 0.55), (0.5, 0.42, 1.1))
    L.col_box('COL_BOX_floor', (0, 0, 0.0), (8.9, 6.9, 0.6))
    L.col_box('COL_BOX_step', (0, -3.8, -0.075), (3.3, 0.85, 0.45))
    L.empty('LABEL_title', (0.0, -3.4, z_roof + 0.42 + 1.9))
    return L


# ============================================================================
# EXPERIENCE  (warm copper, theatre and workshop)
# ============================================================================

def chaikin(poly, iters=3):
    """Corner-cutting smoothing of a closed 2D polygon."""
    for _ in range(iters):
        out = []
        n = len(poly)
        for i in range(n):
            p, q = poly[i], poly[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        poly = out
    return poly


def stilted_arch(R, z_spring, n_leg=6, n_arc=44, z_foot=-0.4):
    """Centre line of a round arch on vertical legs: [(x, z)] from the left foot to the right foot."""
    pts = [(-R, z_foot + (z_spring - z_foot) * i / n_leg) for i in range(n_leg)]
    pts += [(R * math.cos(math.pi - math.pi * i / n_arc), z_spring + R * math.sin(math.pi - math.pi * i / n_arc))
            for i in range(n_arc + 1)]
    pts += [(R, z_spring - (z_spring - z_foot) * i / n_leg) for i in range(1, n_leg + 1)]
    return pts


def band_section(t, y0, y1, c=0.18, groove=None):
    """Chamfered rectangular arch section (u = outward, v = depth) with an optional front groove
    groove = (centre u, half width, depth). Returns (profile, slots) with the groove faces 'Glow'."""
    p = [(t / 2, y0 + c), (t / 2, y1 - c), (t / 2 - c, y1), (-t / 2 + c, y1), (-t / 2, y1 - c), (-t / 2, y0 + c),
         (-t / 2 + c, y0)]
    slots = [None] * 7
    if groove:
        gc, gw, gd = groove
        p += [(gc - gw, y0), (gc - gw, y0 + gd), (gc + gw, y0 + gd), (gc + gw, y0)]
        slots += ['StoneDark', 'Glow', 'StoneDark']   # dark walls frame the glowing floor
    p += [(t / 2 - c, y0)]
    slots += [None, None]
    assert len(slots) == len(p)
    return p, slots


@landmark('arc_gate', 'experience', budget=25000)
def arc_gate():
    L = LM('arc_gate')
    L.ao = dict(distance=3.0, samples=48, floor=0.42)
    L.grad = (-0.3, 4.0, 0.8)
    zs = 9.0
    # three receding bands (front, middle, back) like the layered arches of a proscenium
    bands = [  # centre radius, thickness, y0, y1, slot, groove (centre u, half width, depth, glowing?)
        (11.5, 3.0, -2.3, -1.0, 'Stone', (0.15, 0.34, 0.14, False)),
        (10.6, 3.0, -1.0, 0.35, 'StoneDark', (-1.04, 0.16, 0.1, True)),
        (9.75, 3.0, 0.35, 1.7, 'Stone', (-1.05, 0.16, 0.1, True)),
    ]
    for R, t, y0, y1, slot, (gc, gw, gd, glow) in bands:
        prof, slots = band_section(t, y0, y1, c=0.2, groove=(gc, gw, gd))
        if not glow:
            slots = ['StoneDark' if s == 'Glow' else s for s in slots]
        L.add(planar_arch(stilted_arch(R, zs), prof, slot, slots=slots))
    # theatre marquee: glowing bulbs along the dark channel of the front band
    path = stilted_arch(11.5 + 0.15, zs, n_leg=6, n_arc=44, z_foot=1.9)
    seg = [Vector((x, 0, z)) for x, z in path]
    lens = [0.0]
    for a, b in zip(seg, seg[1:]):
        lens.append(lens[-1] + (b - a).length)
    nb = 44
    for k in range(nb + 1):
        s = lens[-1] * k / nb
        i = max(j for j in range(len(lens)) if lens[j] <= s + 1e-9)
        i = min(i, len(seg) - 2)
        t = (s - lens[i]) / max(1e-9, lens[i + 1] - lens[i])
        p = seg[i].lerp(seg[i + 1], t)
        L.add(uvsphere(0.17, (p.x, -2.3 + 0.1, p.z), 'Glow', segs=8, rings=5, scale=(1, 0.8, 1)))
    # stepped brass keystone and impost bands on the front band
    for k, (w0, w1, h, z0, slot) in enumerate(((2.3, 1.9, 1.1, 0.0, 'Trim'), (1.7, 1.4, 1.0, 1.05, 'Accent'),
                                                 (1.2, 0.9, 1.0, 2.0, 'Trim'))):
        ks = front_profile(ccw([(-w0 / 2, 0.0), (w0 / 2, 0.0), (w1 / 2, h), (-w1 / 2, h)]), -2.6 + 0.1 * k, -1.0,
                           slot, bevel=0.07, segs=2)
        place(ks, (0, 0, zs + 11.5 - 1.55 + z0))
        L.add(ks)
    for sx in (-1, 1):
        L.add(box((3.5, 1.65, 0.5), (sx * 11.5, -1.65, zs - 0.25), 'Trim', bevel=0.07, segs=2))
        L.add(box((3.2, 1.5, 0.22), (sx * 11.5, -1.65, zs + 0.11), 'Accent', bevel=0.04, segs=1))
    # feet: two-tier plinths carrying all three legs
    for sx in (-1, 1):
        cx = sx * 10.85
        L.add(prism(chamfer_rect(6.0, 5.6, 0.5), -0.3, 0.75, 'StoneDark', bevel=0.08, segs=2, loc=(cx, -0.3, 0)))
        L.add(prism(chamfer_rect(5.3, 4.9, 0.42), 0.7, 1.45, 'Stone', bevel=0.07, segs=2, loc=(cx, -0.3, 0)))
        L.add(prism(chamfer_rect(5.4, 5.0, 0.43), 1.42, 1.56, 'Trim', bevel=0.03, segs=1, loc=(cx, -0.3, 0)))
        L.add(box((3.8, 0.08, 0.16), (cx, -3.12, 0.45), 'Glow', bevel=0.02, segs=1))
        L.col_box(f'COL_BOX_foot_{0 if sx < 0 else 1}', (cx, -0.3, 0.6), (5.9, 5.5, 1.8))
    # a low stage under the arch with footlights; the archive lectern stands on it
    dz = 0.22
    L.add(prism(chamfer_rect(15.0, 5.2, 0.6), -0.3, dz, 'StoneDark', bevel=0.04, segs=2, loc=(0, -0.2, 0)))
    L.add(prism(chamfer_rect(14.6, 4.8, 0.55), dz - 0.02, dz + 0.012, 'Wood', bevel=0.0, loc=(0, -0.2, 0)))
    for k in range(9):
        L.add(box((0.5, 0.06, 0.07), (-6.0 + 1.5 * k, -2.82, dz - 0.07), 'Glow', bevel=0.015, segs=1))
    cons = console_parts(1.15)
    for p in cons:
        C.transform(p, Matrix.Translation((0.0, 0.0, dz)))
    L.add(*cons)
    L.col_box('COL_BOX_stage', (0, -0.2, (dz - 0.3) / 2), (14.9, 5.1, dz + 0.3))
    L.col_box('COL_BOX_lectern', (0, 0, dz + 0.6), (0.9, 0.7, 1.4))
    L.empty('POI_archive', (0.0, -2.0, dz))
    L.empty('LABEL_title', (0.0, -2.6, zs + 11.5 + 1.5 + 1.6))
    return L


def bass_guitar(scale=1.0):
    """An original, stylised 4-string electric bass standing upright, strings facing -Y.
    Offset-waist body (the two waists sit at different heights, the upper horn reaches further),
    chunky neck with glowing inlays and four glowing strings. Origin at the bottom of the body.
    Depth stack (front = -Y): body -0.21, guard -0.235, pickups/bridge -0.29, board -0.28, strings -0.32."""
    parts = []
    body_ctrl = [(0.0, -1.42), (0.72, -1.32), (1.02, -0.98), (1.08, -0.45), (0.9, 0.0), (0.82, 0.36), (0.94, 0.72),
                 (1.0, 1.08), (0.84, 1.26), (0.62, 1.08), (0.4, 0.84), (0.26, 0.76), (-0.26, 0.76), (-0.42, 0.98),
                 (-0.64, 1.34), (-0.84, 1.68), (-1.04, 1.6), (-1.02, 0.98), (-0.84, 0.46), (-0.9, 0.04), (-1.1, -0.4),
                 (-1.04, -0.92), (-0.72, -1.3)]
    body = ccw(chaikin(body_ctrl, 2))
    yf = -0.21
    parts.append(front_profile(body, yf, 0.21, 'Accent', bevel=0.08, segs=1))
    guard_ctrl = [(0.26, 0.7), (0.58, 0.94), (0.8, 0.86), (0.72, 0.3), (0.54, -0.34), (0.2, -0.56), (-0.38, -0.44),
                  (-0.6, 0.08), (-0.55, 0.55), (-0.28, 0.72)]
    parts.append(front_profile(ccw(chaikin(guard_ctrl, 2)), yf - 0.025, yf + 0.02, 'StoneDark', bevel=0.01, segs=1))
    for z, ang in ((0.1, 0.08), (-0.34, 0.05)):
        parts.append(box((0.62, 0.05, 0.18), (0.0, -0.255, z), 'Trim', bevel=0.02, segs=1, roll=ang))
    parts.append(box((0.66, 0.07, 0.17), (0.0, -0.265, -0.82), 'Trim', bevel=0.025, segs=1))
    for x, z in ((0.62, -0.62), (0.74, -0.9), (0.48, -1.0)):
        parts.append(cylinder(0.07, 0.0, 0.07, 12, 'Trim', chamfer=0.015, pitch=math.pi / 2, loc=(x, yf + 0.01, z)))
    # neck (rounded back), fretboard, frets, glowing inlays, nut
    n0, n1 = 0.5, 4.6
    neck = prism(ccw([(-0.29, -0.115), (0.29, -0.115), (0.25, 0.1), (-0.25, 0.1)]), 0, 0, 'StoneDark', bevel=0.06,
                 segs=2, levels=[(n0, 1.0, 0.0), (n1, 0.8, 0.0)])
    place(neck, (0.0, -0.115, 0.0))
    board = prism(ccw([(-0.28, -0.025), (0.28, -0.025), (0.28, 0.025), (-0.28, 0.025)]), 0, 0, 'Stone', bevel=0.012,
                  segs=1, levels=[(0.72, 1.0, 0.0), (n1, 0.8, 0.0)])
    place(board, (0.0, -0.255, 0.0))
    parts += [neck, board]
    bridge_z = -0.82
    L_scale = n1 - bridge_z
    for f in range(1, 21):
        zf = n1 - L_scale * (1 - 2 ** (-f / 12))
        if zf < 0.78:
            break
        w = 0.56 * (0.8 + 0.2 * (zf - 0.72) / (n1 - 0.72)) if False else 0.56 * (1.0 - 0.2 * (zf - 0.72) / (n1 - 0.72))
        parts.append(box((w, 0.022, 0.026), (0.0, -0.284, zf), 'Trim', bevel=0.0))
        if f in (3, 5, 7, 9, 12, 15):
            zd = zf + L_scale * (2 ** (-(f - 1) / 12) - 2 ** (-f / 12)) * 0.5
            for dx in ((-0.1, 0.1) if f == 12 else (0.0,)):
                parts.append(cylinder(0.045, -0.006, 0.006, 10, 'Glow', pitch=math.pi / 2, loc=(dx, -0.282, zd)))
    parts.append(box((0.48, 0.06, 0.06), (0.0, -0.28, n1 - 0.02), 'Trim', bevel=0.015, segs=1))
    # headstock (asymmetric paddle) with four in-line tuners on its right edge
    hs_ctrl = [(-0.24, 0.0), (0.22, 0.0), (0.38, 0.36), (0.48, 0.86), (0.34, 1.24), (0.04, 1.32), (-0.24, 1.14),
               (-0.3, 0.6)]
    H = front_profile(ccw(chaikin(hs_ctrl, 2)), -0.24, -0.06, 'Accent', bevel=0.04, segs=2)
    place(H, (0.0, 0.0, n1 - 0.04))
    parts.append(H)
    for k in range(4):
        zt = n1 + 0.26 + 0.24 * k
        xe = 0.38 + 0.03 * k
        parts.append(cylinder(0.055, 0.0, 0.24, 10, 'Trim', chamfer=0.012, roll=math.pi / 2, loc=(xe - 0.08, -0.15, zt)))
        parts.append(box((0.07, 0.05, 0.15), (xe + 0.19, -0.15, zt), 'Trim', bevel=0.015, segs=1))
        parts.append(cylinder(0.045, -0.07, 0.0, 10, 'Trim', pitch=math.pi / 2, loc=(xe - 0.24, -0.24, zt)))
    # strings: four glowing lines from the bridge to the nut
    for k in range(4):
        xb = -0.24 + 0.16 * k
        xn = -0.16 + 0.107 * k
        a = Vector((xb, -0.325, bridge_z))
        b = Vector((xn, -0.325, n1 - 0.02))
        d = b - a
        parts.append(box((0.03, 0.03, d.length), (a + b) / 2, 'Glow', bevel=0.0, roll=math.atan2(d.x, d.z)))
    S = Matrix.Diagonal((scale, scale, scale, 1.0)) @ Matrix.Translation((0, 0, 1.42))
    for p in parts:
        C.transform(p, S)
    return parts


def speaker_cabinet(center, w, d, h, cones, yaw=0.0):
    """A bevelled speaker cabinet with round drivers on its front face. cones: [(x, z, r)] local."""
    parts = [box((w, d, h), (0, 0, 0), 'StoneDark', bevel=0.06, segs=2),
             box((w * 0.94, 0.04, h * 0.9), (0, -d / 2 - 0.0, 0), 'Metal', bevel=0.015, segs=1)]
    for x, z, r in cones:
        prof = [(0.0, 0.0), (r, 0.0), (r, 0.05), (r * 0.9, 0.07), (r * 0.8, 0.045), (r * 0.6, 0.06),
                (r * 0.26, 0.03), (r * 0.2, 0.075), (0.0, 0.09)]
        cone = lathe(prof, 16, 'Metal', pitch=math.pi / 2, loc=(x, -d / 2 - 0.02, z))
        paint(cone, lambda c, n, x=x, z=z, r=r: 'Glow' if 0.79 * r < math.hypot(c.x - x, c.z - z) < 0.9 * r else
              ('Trim' if math.hypot(c.x - x, c.z - z) < 0.26 * r else None))
        parts.append(cone)
    M = Matrix.Translation(V(center)) @ rot(yaw)
    for p in parts:
        C.transform(p, M)
    return parts


def semi_ellipse(a, c, z0, n=22):
    return [(a * math.cos(math.pi - math.pi * i / n), z0 + c * math.sin(math.pi - math.pi * i / n)) for i in range(n + 1)]


@landmark('bass_stage', 'experience')
def bass_stage():
    L = LM('bass_stage')
    L.densify = 1.8
    L.ao = dict(distance=2.5, samples=48, floor=0.42)
    L.grad = (-0.3, 3.0, 0.8)
    top = 1.0
    # --- platform, steps, footlights ---------------------------------------------------------------
    L.add(prism(chamfer_rect(14.0, 8.0, 0.4), -0.3, top - 0.12, 'StoneDark', bevel=0.06, segs=2))
    L.add(prism(chamfer_rect(14.1, 8.1, 0.42), top - 0.14, top - 0.03, 'Trim', bevel=0.03, segs=1))
    L.add(prism(chamfer_rect(13.9, 7.9, 0.38), top - 0.05, top, 'Wood', bevel=0.02, segs=1))
    for k in range(10):
        L.add(box((0.42, 0.06, 0.1), (-6.3 + 1.4 * k, -4.03, top - 0.32), 'Glow', bevel=0.02, segs=1))
    for k in range(3):
        st = 0.25 * (k + 1)
        y1 = -4.0 - 0.42 * (2 - k)
        y0 = y1 - 0.42
        L.add(box((4.6, y1 - y0 + 0.02, st + 0.3), (0, (y0 + y1) / 2, (st - 0.3) / 2), 'Stone', bevel=0.04, segs=2))
        L.add(box((4.4, 0.05, 0.05), (0, y0 + 0.03, st - 0.03), 'Trim', bevel=0.0))
        L.col_box(f'COL_BOX_step_{k}', (0, (y0 + y1) / 2, (st - 0.3) / 2), (4.5, y1 - y0, st + 0.3))
    L.col_box('COL_BOX_platform', (0, 0, (top - 0.3) / 2), (13.9, 7.9, top + 0.3))
    # --- ribbed quarter-dome shell: five concentric arches stepping back, dark panels between --------
    ribs = [(-0.9, 6.7, 9.8), (0.25, 5.95, 8.6), (1.35, 5.1, 7.35), (2.35, 4.15, 5.95), (3.25, 3.1, 4.45)]
    th, dp = 0.72, 0.8
    for i, (y, a, c) in enumerate(ribs):
        prof, slots = band_section(th, -dp / 2, dp / 2, c=0.12, groove=(-0.12, 0.09, 0.07))
        rib = planar_arch(semi_ellipse(a, c, top - 0.1), prof, 'Stone', y=y, slots=slots)
        L.add(rib)
        if i + 1 < len(ribs):
            y2, a2, c2 = ribs[i + 1]
            A = [Vector((x, y + dp / 2 - 0.05, z)) for x, z in semi_ellipse(a - th / 2 + 0.05, c - th / 2 + 0.05, top - 0.1)]
            Bq = [Vector((x, y2 - dp / 2 + 0.05, z)) for x, z in semi_ellipse(a2 + th / 2 - 0.05, c2 + th / 2 - 0.05, top - 0.1)]
            L.add(_shell_panel(A, Bq, 0.16))
    yb, ab, cb = ribs[-1]
    back = front_profile(ccw([(0.0, top - 0.1)] + semi_ellipse(ab - 0.3, cb - 0.3, top - 0.1)[1:-1]),
                         yb + 0.1, yb + 0.4, 'StoneDark')
    L.add(back)
    for k in range(7):     # deco sunburst on the back wall
        ang = math.radians(15 + 25 * k)
        r0 = 0.6
        p0 = Vector((math.cos(ang) * r0, yb + 0.08, top + math.sin(ang) * r0))
        p1 = Vector((math.cos(ang) * (ab - 0.75) * 0.95, yb + 0.08, top + math.sin(ang) * (cb - 0.75) * 0.95))
        d = p1 - p0
        L.add(box((0.09, 0.05, d.length), (p0 + p1) / 2, 'Glow', bevel=0.0, roll=math.atan2(d.x, d.z)))
    L.add(lathe([(0.0, 0.0), (0.5, 0.0), (0.5, 0.06), (0.0, 0.08)], 20, 'Trim', pitch=-math.pi / 2,
                loc=(0, yb + 0.1, top + 0.02)))
    # --- the bass sculpture on its stand -----------------------------------------------------------
    by = -0.75
    L.add(prism(chamfer_rect(2.7, 1.7, 0.3), top - 0.05, top + 0.45, 'StoneDark', bevel=0.05, segs=2, loc=(0, by + 0.2, 0)))
    L.add(prism(chamfer_rect(2.75, 1.75, 0.31), top + 0.38, top + 0.5, 'Trim', bevel=0.02, segs=1, loc=(0, by + 0.2, 0)))
    bz = top + 0.55
    bass = bass_guitar(1.08)
    for p in bass:
        C.transform(p, Matrix.Translation((0.0, by, bz)))
    L.add(*bass)
    for sx in (-1, 1):   # cradle arms under the lower bout
        L.add(box((0.16, 0.5, 0.75), (sx * 0.85, by - 0.05, bz + 0.2), 'Metal', bevel=0.03, segs=1, roll=sx * 0.35))
        L.add(box((0.32, 0.6, 0.12), (sx * 1.0, by - 0.05, bz + 0.6), 'Metal', bevel=0.03, segs=1))
    mast_top = bz + 1.42 * 1.08 + 3.1
    L.add(box((0.2, 0.2, mast_top - bz), (0.0, by + 0.55, (bz + mast_top) / 2), 'Metal', bevel=0.04, segs=1))
    L.add(box((0.62, 0.62, 0.2), (0.0, by + 0.25, mast_top), 'Trim', bevel=0.04, segs=1))
    L.col_box('COL_BOX_bass_stand', (0, by + 0.2, top + 1.2), (2.6, 1.6, 2.4))
    # --- speaker stacks on the ground, flanking the front corners of the stage ----------------------
    for sx in (-1, 1):
        x, y = sx * 7.72, -2.9
        z = 0.0
        for (h, cones) in ((1.2, [(-0.27, 0.0, 0.3), (0.27, 0.0, 0.3)]), (1.2, [(0.0, 0.0, 0.45)]),
                           (0.9, [(-0.3, 0.0, 0.17), (0.3, 0.0, 0.17)])):
            L.add(*speaker_cabinet((x, y, z + 0.06 + h / 2), 1.26, 1.0, h, cones, yaw=-sx * 0.18))
            z += h + 0.02
        L.col_box(f'COL_BOX_speaker_{"lr"[sx > 0]}', (x, y, (z - 0.3) / 2), (1.2, 0.95, z + 0.3), yaw=-sx * 0.18)
        L.add(prism(chamfer_rect(1.5, 1.25, 0.12), -0.3, 0.06, 'StoneDark', bevel=0.03, segs=1, loc=(x, y, 0), yaw=-sx * 0.18))
    # --- shell walls (colliders along the shell's footprint) ---------------------------------------
    foot = [(r[1], r[0]) for r in ribs]
    for sx in (-1, 1):
        for i in range(len(foot) - 1):
            (a0, y0), (a1, y1) = foot[i], foot[i + 1]
            cx, cy = sx * (a0 + a1) / 2, (y0 + y1) / 2
            ln = math.hypot(a1 - a0, y1 - y0)
            L.col_box(f'COL_BOX_shell_{"lr"[sx > 0]}{i}', (cx, cy, top + 1.5), (0.6, ln + 0.3, 3.0),
                      yaw=math.atan2(sx * (a1 - a0), y1 - y0) * -1.0)
    L.col_box('COL_BOX_shell_back', (0, yb + 0.25, top + 1.5), (2 * ab, 0.6, 3.0))
    # --- glowing note pads set into the floor -------------------------------------------------------
    for k in range(8):
        x = -5.25 + 1.5 * k
        L.add(prism(chamfer_rect(1.36, 1.36, 0.12), top - 0.02, top + 0.02, 'Trim', bevel=0.012, segs=1, loc=(x, -2.7, 0)))
        pad = prism(chamfer_rect(1.2, 1.2, 0.1), top + 0.0, top + 0.035, 'Glow', bevel=0.01, segs=1, loc=(x, -2.7, 0))
        L.anim(f'ANIM_PULSE_pad_{k}', [pad], (x, -2.7, top), ao=None)
        L.empty(f'POI_pad_{k}', (x, -2.7, top))
    L.empty('POI_read', (0.0, -6.7, 0.0))
    L.empty('LABEL_title', (0.0, -1.6, top + 9.8 + 1.6))
    return L


def _shell_panel(A, B, thick):
    """Closed thin panel between two matching curves A and B (lists of Vectors), offset outward
    (away from the shell's centre line) by `thick`."""
    bm = bmesh.new()
    n = len(A)

    def off(p):
        d = Vector((p.x, 0.0, p.z - 1.0))
        return p + (d.normalized() * thick if d.length > 1e-6 else Vector((0, 0, thick)))
    a = [bm.verts.new(p) for p in A]
    b = [bm.verts.new(p) for p in B]
    a2 = [bm.verts.new(off(p)) for p in A]
    b2 = [bm.verts.new(off(p)) for p in B]
    for i in range(n - 1):
        bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
        bm.faces.new((b2[i], b2[i + 1], a2[i + 1], a2[i]))
        bm.faces.new((a2[i], a2[i + 1], a[i + 1], a[i]))
        bm.faces.new((b[i], b[i + 1], b2[i + 1], b2[i]))
    for i in (0, n - 1):
        bm.faces.new((a[i], b[i], b2[i], a2[i]))
    return obj(bm, 'StoneDark')


@landmark('arena', 'experience')
def arena():
    L = LM('arena')
    L.densify = 3.2
    L.ao = dict(distance=2.2, samples=48, floor=0.42)
    L.grad = (-0.3, 2.5, 0.8)
    r_in, r_out, wall_h, fz = 12.45, 13.1, 1.2, 0.12
    # --- floor with painted rings and a centre emblem -----------------------------------------------
    prof = [(0.0, -0.3), (r_in + 0.05, -0.3), (r_in + 0.05, fz), (11.6, fz), (11.45, fz), (8.2, fz), (8.0, fz),
            (4.2, fz), (3.9, fz), (1.25, fz), (1.05, fz), (0.0, fz)]
    floor = lathe(prof, 64, 'Stone')

    def floor_slot(c, n):
        if n.z < 0.5:
            return None
        r = math.hypot(c.x, c.y)
        if r > 11.6:
            return 'StoneDark'
        if 11.45 < r < 11.6 or 8.0 < r < 8.2:
            return 'Trim'
        if 3.9 < r < 4.2:
            return 'Accent'
        if 1.25 < r < 3.9:
            return 'StoneDark'
        if 1.05 < r < 1.25:
            return 'Trim'
        if r < 1.05:
            return 'Accent'
        return None
    paint(floor, floor_slot)
    L.add(floor)
    # thin brass spokes across the ring field (court markings)
    for k in range(8):
        a = TAU * k / 8 + TAU / 16
        L.add(box((3.0, 0.12, 0.03), polar(9.8, a, fz + 0.005), 'Trim', bevel=0.0, yaw=a))
        L.add(box((3.2, 0.12, 0.03), polar(6.1, a, fz + 0.005), 'Trim', bevel=0.0, yaw=a))
    # coral lane marks toward both gates
    for sy in (-1, 1):
        for k in range(4):
            L.add(box((0.5, 0.9, 0.03), (0, sy * (5.2 + 1.5 * k), fz + 0.005), 'Accent', bevel=0.01, segs=1))
    # --- perimeter wall: 10-degree segments, two gaps (front and back) -------------------------------
    gap = 2.3          # half-width of each entrance (m)
    pillars = [math.radians(a) for a in (45, 135, 225, 315)]
    seg = math.radians(10)
    k = 0
    for i in range(36):
        a0 = -math.pi / 2 + i * seg
        a1 = a0 + seg
        mid = (a0 + a1) / 2
        # skip the two entrance gaps (centred on -90 and +90 degrees)
        if min(abs(math.atan2(math.sin(mid - s), math.cos(mid - s))) for s in (-math.pi / 2, math.pi / 2)) * 12.8 < gap:
            continue
        g = 0.025 / 12.8
        wall = prism(sector(r_in, r_out, a0 + g, a1 - g, 3), 0, 0, 'Stone', bevel=0.04, segs=1,
                     levels=[(-0.3, 1.0, 0.0), (0.38, 1.0, 0.0), (0.5, 1.0, 0.0), (wall_h - 0.12, 1.0, 0.0)])
        paint(wall, lambda c, n: 'Accent' if 0.38 < c.z < 0.5 and n.x * c.x + n.y * c.y > 0.5 * math.hypot(c.x, c.y)
              else None)
        cap = prism(sector(r_in - 0.06, r_out + 0.06, a0 + g, a1 - g, 3), wall_h - 0.14, wall_h, 'Trim', bevel=0.02,
                    segs=1)
        led = prism(sector(r_in - 0.03, r_in + 0.05, mid - 0.05, mid + 0.05, 2), 0.6, 0.82, 'Glow', bevel=0.0)
        L.add(wall, cap, led)
        c = polar((r_in + r_out) / 2, mid, (wall_h - 0.3) / 2)
        L.col_box(f'COL_BOX_wall_{k}', c, (2 * 12.78 * math.sin(seg / 2) + 0.02, r_out - r_in - 0.05, wall_h + 0.3),
                  yaw=mid + math.pi / 2)
        k += 1
    # --- corner pillars with glowing caps -------------------------------------------------------------
    for j, a in enumerate(pillars):
        p = polar(12.78, a)
        L.add(prism(chamfer_rect(1.9, 1.9, 0.36), -0.3, 0.7, 'StoneDark', bevel=0.06, segs=2, loc=p, yaw=a))
        L.add(prism(chamfer_rect(1.45, 1.45, 0.3), 0, 0, 'Stone', bevel=0.05, segs=1, loc=p, yaw=a,
                    levels=[(0.65, 1.0, 0.0), (3.2, 0.86, 0.0), (5.0, 0.7, 0.0)]))
        L.add(prism(chamfer_rect(1.52, 1.52, 0.31), 0.62, 0.86, 'Trim', bevel=0.02, segs=1, loc=p, yaw=a))
        L.add(prism(chamfer_rect(1.3, 1.3, 0.27), 3.05, 3.3, 'Accent', bevel=0.02, segs=1, loc=p, yaw=a))
        L.add(prism(chamfer_rect(1.2, 1.2, 0.25), 4.95, 5.2, 'Trim', bevel=0.03, segs=1, loc=p, yaw=a))
        L.add(shard(p + V(0, 0, 5.05), (0, 0, 1), 1.55, 0.55, sides=4, belt=0.28, shoulder=0.55, phase=a + math.pi / 4))
        for side in (-1, 1):   # glowing strips on the inward and outward faces
            f = polar(side * 0.62, a)
            L.add(box((0.14, 0.06, 1.9), p + polar(side * 0.69, a) + V(0, 0, 1.95), 'Glow', bevel=0.012, segs=1,
                      yaw=a + math.pi / 2, pitch=-side * 0.041))
        L.col_cyl(f'COL_CYL_pillar_{j}', (p.x, p.y), 0.75, -0.3, 5.2)
    # --- gate frames over both entrances ---------------------------------------------------------------
    for sy, nm in ((-1, 'front'), (1, 'back')):
        for sx in (-1, 1):
            gp = V(sx * (gap + 0.45), sy * 12.6, 0.0)
            L.add(prism(chamfer_rect(0.8, 1.1, 0.16), -0.3, 3.2, 'StoneDark', bevel=0.05, segs=2, loc=gp))
            L.add(box((0.1, 0.05, 2.2), gp + V(-sx * 0.0, sy * -0.56, 1.6), 'Glow', bevel=0.01, segs=1))
            L.col_box(f'COL_BOX_gate_{nm}_{"lr"[sx > 0]}', gp + V(0, 0, 1.45), (0.75, 1.0, 3.5))
        L.add(box((2 * gap + 1.9, 1.2, 0.6), (0, sy * 12.6, 3.48), 'Stone', bevel=0.06, segs=2))
        L.add(box((2 * gap + 1.95, 1.24, 0.16), (0, sy * 12.6, 3.42), 'Accent', bevel=0.02, segs=1))
        L.add(box((2 * gap + 0.6, 0.5, 0.05), (0, sy * 12.6, 3.17), 'Glow', bevel=0.0))
        L.add(box((2 * gap + 2.0, 1.25, 0.12), (0, sy * 12.6, 3.82), 'Trim', bevel=0.03, segs=1))
    # --- scoreboard monolith behind the back gate ---------------------------------------------------
    my = 16.4
    L.add(prism(chamfer_rect(8.4, 2.4, 0.4), -0.3, 0.55, 'StoneDark', bevel=0.06, segs=2, loc=(0, my, 0)))

    def screen(ob):
        inset_face(ob, lambda f: f.normal.y < -0.9 and abs(f.calc_center_median().x) < 0.1
                   and 1.9 < f.calc_center_median().z < 5.4, 0.0, 0.12, slot='StoneDark', wall_slot='Glow')
    pw, z0s, z1s = 6.0, 1.9, 5.5
    mono_poly = chamfer_rect(7.2, 1.3, 0.3)
    mono_poly = mono_poly[:7] + [(-pw / 2, -0.65), (pw / 2, -0.65)] + mono_poly[7:]
    mono = prism(mono_poly, 0, 0, 'Stone', bevel=0.07, segs=2, loc=(0, my, 0), pre=screen,
                 levels=[(0.5, 1.0, 0.0), (z0s, 1.0, 0.0), (z1s, 1.0, 0.0), (6.5, 0.97, 0.0)])
    L.add(mono)
    L.add(prism(chamfer_rect(7.6, 1.6, 0.34), 6.4, 6.75, 'Trim', bevel=0.04, segs=2, loc=(0, my, 0)))
    for sx in (-1, 1):
        L.add(box((0.24, 1.5, 5.8), (sx * 3.72, my, 3.5), 'Accent', bevel=0.04, segs=1))
    L.empty('SCREEN_score', (0.0, my - 0.65 + 0.12, (z0s + z1s) / 2))
    L.col_box('COL_BOX_scoreboard', (0, my, 3.2), (8.2, 2.2, 7.0))
    # --- floating targets, POI, label -----------------------------------------------------------------
    spots = [(5.0, 20, 2.4), (8.8, 62, 3.6), (5.6, 118, 5.0), (9.2, 158, 2.8), (6.2, 205, 6.0), (9.0, 248, 3.2),
             (4.8, 292, 4.4), (8.6, 335, 5.4)]
    for i, (r, a, z) in enumerate(spots):
        L.empty(f'SPAWN_target_{i}', polar(r, math.radians(a), z))
    L.empty('POI_arena', (0.0, -14.7, 0.0))
    L.empty('LABEL_title', (0.0, -13.4, 5.3))
    return L


def tube_path(points, r, slot, sides=8):
    bm, _ = C.tube([V(p) for p in points], r, sides=sides)
    return obj(bm, slot)


@landmark('workshop', 'experience')
def workshop():
    L = LM('workshop')
    L.ao = dict(distance=2.0, samples=48, floor=0.42)
    L.grad = (-0.3, 3.0, 0.8)
    fz = 0.12
    bands = [0.95, 0.94, 0.9, 0.89]
    pad = prism(chamfer_rect(14.0, 10.0, 0.6), 0, 0, 'Stone', bevel=0.05, segs=2,
                levels=[(-0.3, 1.0, 0.0), (fz, 1.0, 0.0)] + [(fz, s, 0.0) for s in bands])

    def pad_slot(c, n):
        if n.z < 0.99 or c.z < fz - 0.01:
            return None
        e = max(abs(c.x) / 7.0, abs(c.y) / 5.0)
        if bands[1] < e < bands[0] or bands[3] < e < bands[2]:
            return 'Accent'
        if bands[2] < e < bands[1]:
            return 'StoneDark'
        return None
    paint(pad, pad_slot)
    L.add(pad)
    # --- the server tower: a monolith of pilasters with glowing slits --------------------------------
    tx, ty, H = -3.3, 1.7, 12.0
    L.add(prism(chamfer_rect(3.9, 3.9, 0.4), fz - 0.02, 0.9, 'StoneDark', bevel=0.06, segs=2, loc=(tx, ty, 0)))
    L.add(prism(chamfer_rect(3.2, 3.2, 0.3), 0.85, H - 0.9, 'StoneDark', bevel=0.05, segs=2, loc=(tx, ty, 0)))
    for face in range(4):
        yaw = face * math.pi / 2
        for j in range(4):
            u = -1.2 + 0.8 * j
            pil = box((0.36, 0.22, H - 2.4), (u, -1.63, (0.9 + H - 1.0) / 2), 'Stone' if j in (0, 3) else 'Metal',
                      bevel=0.05, segs=2)
            C.transform(pil, Matrix.Translation((tx, ty, 0)) @ rot(yaw))
            L.add(pil)
        for j in range(3):
            u = -0.8 + 0.8 * j
            sl = box((0.14, 0.06, H - 3.4), (u, -1.6, (0.9 + H - 1.0) / 2 + 0.2), 'Glow', bevel=0.02, segs=1)
            C.transform(sl, Matrix.Translation((tx, ty, 0)) @ rot(yaw))
            L.add(sl)
    for zb in (4.2, 7.6):
        L.add(prism(chamfer_rect(3.66, 3.66, 0.36), zb - 0.16, zb + 0.16, 'Trim', bevel=0.03, segs=2, loc=(tx, ty, 0)))
    L.add(prism(chamfer_rect(3.8, 3.8, 0.42), H - 1.0, H - 0.55, 'Trim', bevel=0.05, segs=2, loc=(tx, ty, 0)))
    L.add(prism(chamfer_rect(3.3, 3.3, 0.34), H - 0.6, H - 0.1, 'StoneDark', bevel=0.05, segs=2, loc=(tx, ty, 0)))
    for k in range(5):   # vent fins on the crown
        L.add(box((2.6, 0.12, 0.38), (tx, ty - 1.0 + 0.5 * k, H + 0.08), 'Metal', bevel=0.03, segs=1))
    L.add(cylinder(0.09, H - 0.2, H + 2.2, 8, 'Metal', loc=(tx + 1.0, ty + 1.0, 0)))
    L.add(uvsphere(0.2, (tx + 1.0, ty + 1.0, H + 2.3), 'Glow', segs=12, rings=6))
    # cable ports on the plinth front
    for k in range(3):
        L.add(cylinder(0.16, -0.05, 0.08, 12, 'Trim', chamfer=0.02, pitch=math.pi / 2,
                       loc=(tx - 0.9 + 0.9 * k, ty - 1.95, 0.5)))
    L.col_box('COL_BOX_tower', (tx, ty, H / 2), (3.7, 3.7, H + 0.6))
    # --- the workbench ---------------------------------------------------------------------------------
    bx, by = 2.7, -1.6
    L.add(box((3.1, 1.2, 0.14), (bx, by, 0.95), 'Wood', bevel=0.03, segs=2))
    L.add(box((3.16, 1.26, 0.05), (bx, by, 0.87), 'Trim', bevel=0.012, segs=1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            L.add(box((0.14, 0.14, 0.82), (bx + sx * 1.38, by + sy * 0.46, 0.5), 'Metal', bevel=0.025, segs=1))
    L.add(box((2.9, 1.0, 0.07), (bx, by, 0.34), 'Wood', bevel=0.015, segs=1))
    L.add(box((0.42, 0.3, 0.26), (bx - 1.15, by - 0.2, 1.15), 'Metal', bevel=0.04, segs=1))
    L.add(box((0.24, 0.42, 0.08), (bx - 1.15, by - 0.42, 1.12), 'Trim', bevel=0.02, segs=1))
    tab = box((0.62, 0.42, 0.04), (bx + 0.5, by + 0.15, 1.26), 'StoneDark', bevel=0.012, segs=1, pitch=0.55)
    scr = box((0.54, 0.34, 0.02), (bx + 0.5, by + 0.135, 1.27), 'Glow', bevel=0.005, segs=1, pitch=0.55)
    stand = box((0.08, 0.12, 0.25), (bx + 0.5, by + 0.3, 1.12), 'Metal', bevel=0.01, segs=1)
    L.add(tab, scr, stand)
    for k in range(3):
        L.add(cylinder(0.05, 1.02, 1.1 + 0.08 * k, 8, 'Trim', loc=(bx - 0.4 + 0.22 * k, by - 0.3, 0)))
    L.add(box((0.6, 0.16, 0.05), (bx + 0.05, by - 0.35, 1.04), 'Accent', bevel=0.012, segs=1, yaw=0.3))
    L.col_box('COL_BOX_bench', (bx, by, 0.55), (3.0, 1.15, 1.1))
    # --- two crates ---------------------------------------------------------------------------------------
    for j, (cx, cy, cz, s, yaw) in enumerate(((5.6, 1.1, 0.0, 1.25, 0.2), (5.35, 1.0, 1.25, 1.0, -0.1))):
        c = V(cx, cy, fz + cz + s / 2)
        L.add(box((s, s, s), c, 'Wood', bevel=0.05, segs=2, yaw=yaw))
        for ex in (-1, 1):
            for ez in (-1, 1):
                L.add(box((s + 0.04, 0.12, 0.12), c + rot(yaw) @ V(0, ex * (s / 2 - 0.04), ez * (s / 2 - 0.04)), 'Metal',
                          bevel=0.02, segs=1, yaw=yaw))
                L.add(box((0.12, s + 0.04, 0.12), c + rot(yaw) @ V(ex * (s / 2 - 0.04), 0, ez * (s / 2 - 0.04)), 'Metal',
                          bevel=0.02, segs=1, yaw=yaw))
        L.add(box((s * 0.6, 0.02, s * 0.16), c + rot(yaw) @ V(0, -s / 2 - 0.005, 0), 'Accent', bevel=0.0, yaw=yaw))
        if j == 0:
            L.col_box('COL_BOX_crate_0', (cx, cy, fz + s / 2), (s, s, s + 0.2), yaw=yaw)
        else:
            L.col_box('COL_BOX_crate_1', (cx, cy, fz + cz + s / 2), (s, s, s), yaw=yaw)
    # --- small satellite dish on a tripod -----------------------------------------------------------------
    dx, dy = -6.0, -2.9
    L.add(cylinder(0.5, fz - 0.02, fz + 0.2, 16, 'StoneDark', chamfer=0.04, loc=(dx, dy, 0)))
    for k in range(3):
        a = TAU * k / 3 + 0.4
        p0 = V(dx, dy, 0) + polar(0.85, a, fz)
        p1 = V(dx, dy, 1.6)
        d = p1 - p0
        L.add(box((0.1, 0.1, d.length), (p0 + p1) / 2, 'Metal', bevel=0.02, segs=1, yaw=a - math.pi / 2,
                  pitch=-math.atan2(math.hypot(d.x, d.y), d.z) * -1.0))
    L.add(cylinder(0.12, 0.2, 1.75, 10, 'Metal', loc=(dx, dy, 0)))
    tilt = math.radians(38)
    dish_c = V(dx, dy, 1.95)
    dish = lathe([(0.0, 0.0), (0.35, 0.02), (0.75, 0.1), (1.1, 0.24), (1.2, 0.3), (1.18, 0.36), (1.06, 0.31),
                  (0.72, 0.18), (0.34, 0.1), (0.0, 0.08)], 28, 'Stone', loc=dish_c, pitch=-tilt, yaw=0.5)
    paint(dish, lambda c, n: 'Trim' if (c - dish_c).length > 1.12 else None)
    L.add(dish)
    axis = rot(0.5, -tilt) @ V(0, 0, 1)
    tip = dish_c + axis * 1.05
    for k in range(3):
        a = TAU * k / 3
        rim = dish_c + rot(0.5, -tilt) @ V(math.cos(a) * 1.0, math.sin(a) * 1.0, 0.27)
        d = tip - rim
        L.add(sweep([rim, tip], [(0.03, 0.03), (-0.03, 0.03), (-0.03, -0.03), (0.03, -0.03)], 'Metal'))
    L.add(uvsphere(0.11, tip, 'Glow', segs=10, rings=6))
    L.col_cyl('COL_CYL_dish', (dx, dy), 0.75, -0.3, 2.2)
    # --- a squat forge with a glowing mouth: the foundry half of the workshop ---------------------------
    fx, fy = -5.6, 2.6
    L.add(prism(ngon(8, 1.05, TAU / 16), fz - 0.02, 0.35, 'StoneDark', bevel=0.05, segs=2, loc=(fx, fy, 0)))
    forge = lathe([(0.0, 0.3), (0.92, 0.3), (0.96, 0.5), (0.88, 1.3), (0.7, 1.6), (0.46, 1.75), (0.0, 1.75)], 16, 'Stone',
                  loc=(fx, fy, 0))
    L.add(forge)
    L.add(prism(chamfer_rect(0.7, 0.5, 0.12), 0.6, 1.08, 'Glow', bevel=0.02, segs=1, loc=(fx + 0.0, fy - 0.72, 0)))
    L.add(prism(chamfer_rect(0.9, 0.36, 0.14), 0.5, 1.2, 'Trim', bevel=0.02, segs=1, loc=(fx, fy - 0.8, 0)))
    L.add(cylinder(0.26, 1.7, 3.2, 10, 'Metal', loc=(fx + 0.2, fy + 0.2, 0)))
    L.add(cylinder(0.33, 3.0, 3.25, 10, 'Trim', chamfer=0.03, loc=(fx + 0.2, fy + 0.2, 0)))
    L.add(lathe([(0.0, 1.66), (0.98, 1.66), (1.0, 1.74), (0.0, 1.78)], 16, 'Trim', loc=(fx, fy, 0)))
    L.col_cyl('COL_CYL_forge', (fx, fy), 1.0, -0.3, 1.8)
    # --- cables snaking across the pad from the tower ports ----------------------------------------------
    for k, (end, mid) in enumerate((((bx - 1.2, by + 0.2), (0.0, -1.0)), ((dx + 0.4, dy + 0.3), (-4.6, -0.9)),
                                    ((5.0, 0.2), (2.0, 0.6)))):
        p0 = V(tx - 0.9 + 0.9 * k, ty - 2.1, 0.5)
        pts = C.bezier_points(p0, V(p0.x, p0.y - 0.9, fz + 0.1), V(mid[0], mid[1], fz + 0.1), V(end[0], end[1], fz + 0.1), 14)
        L.add(tube_path(pts, 0.085, 'StoneDark', sides=8))
    L.empty('POI_read', (bx, by - 2.1, 0.0))
    L.empty('LABEL_title', (tx, ty - 1.8, H + 2.0))
    return L


def glyph_spin_parts(i, c):
    """Floating abstract glyph i (0..4) centred at c: hexagon knot, interlocking brackets,
    flame-ish loop, node graph, shield. About 1.2 m tall."""
    c = V(c)
    parts = []
    sq = lambda r: [(r, r), (-r, r), (-r, -r), (r, -r)]
    if i == 0:      # two interlinked hexagonal rings
        R = 0.42
        for k, (dz, yaw, slot) in enumerate(((-0.21, 0.0, 'Glow'), (0.21, math.pi / 2, 'Trim'))):
            parts.append(torus(R, 0.0, c + V(0, 0, dz), slot, major=6, pitch=math.pi / 2, yaw=yaw,
                               section=[(0.075, 0.075), (-0.075, 0.075), (-0.075, -0.075), (0.075, -0.075)]))
            C.bevel(parts[-1], 0.02, segments=1, angle=30)
    elif i == 1:    # two interlocking square brackets [ ]
        for k, (sx, yaw, slot) in enumerate(((1, 0.0, 'Glow'), (-1, math.pi / 2, 'Trim'))):
            pts = [V(sx * 0.32, 0, 0.5), V(-sx * 0.12, 0, 0.5), V(-sx * 0.12, 0, -0.5), V(sx * 0.32, 0, -0.5)]
            pts = [rot(yaw) @ (p + V(-sx * 0.1, 0, 0)) + c for p in pts]
            ob = sweep(pts, [(0.07, 0.07), (-0.07, 0.07), (-0.07, -0.07), (0.07, -0.07)], slot)
            parts.append(ob)
            for p in (pts[1], pts[2]):
                parts.append(box((0.15, 0.15, 0.15), p, slot, bevel=0.03, segs=1, yaw=yaw))
    elif i == 2:    # a flame-ish teardrop loop with a glowing heart
        pts = []
        n = 28
        for k in range(n):
            t = TAU * k / n
            x = 0.34 * math.sin(t) * (0.55 + 0.45 * math.cos(t * 0.5) ** 2)
            z = -0.36 * math.cos(t) + 0.2 * (1 - math.cos(t)) ** 1.5 * 0.35
            if t > math.pi * 0.8 and t < math.pi * 1.2:
                z += 0.22 * (1 - abs(t - math.pi) / (math.pi * 0.2))
            pts.append(c + V(x, 0, z + 0.05))
        ob = sweep(pts, [(0.065 * math.cos(TAU * j / 6), 0.065 * math.sin(TAU * j / 6)) for j in range(6)], 'Glow',
                   closed=True)
        parts.append(ob)
        parts.append(shard(c + V(0, 0, -0.25), (0, 0, 1), 0.62, 0.13, sides=5, slot='Trim', bend=(0.06, 0, 0)))
    elif i == 3:    # a little node graph in 3D
        nodes = [V(-0.36, -0.1, -0.32), V(0.34, 0.12, -0.28), V(0.02, -0.18, 0.08), V(0.18, 0.16, 0.46), V(-0.3, 0.2, 0.3)]
        edges = [(0, 2), (1, 2), (2, 3), (2, 4), (0, 1), (3, 4)]
        for a, b in edges:
            pa, pb = nodes[a] + c, nodes[b] + c
            parts.append(sweep([pa, pb], [(0.035 * math.cos(TAU * j / 6), 0.035 * math.sin(TAU * j / 6)) for j in range(6)],
                               'Glow'))
        for k, p in enumerate(nodes):
            parts.append(uvsphere(0.12 if k != 2 else 0.16, p + c, 'Trim' if k != 2 else 'Glow', segs=12, rings=6))
    else:           # a shield with a glowing chevron
        ctrl = [(0.0, -0.62), (0.34, -0.36), (0.46, 0.08), (0.44, 0.46), (0.0, 0.52), (-0.44, 0.46), (-0.46, 0.08),
                (-0.34, -0.36)]
        outline = ccw(chaikin(ctrl, 2))
        sh = front_profile(outline, -0.07, 0.07, 'Trim', bevel=0.03, segs=1)
        place(sh, c)
        parts.append(sh)
        inner = [(x * 0.78, z * 0.78 + 0.01) for x, z in outline]
        face = front_profile(ccw(inner), -0.1, 0.1, 'StoneDark', bevel=0.015, segs=1)
        place(face, c)
        parts.append(face)
        for sx in (-1, 1):
            parts.append(box((0.36, 0.08, 0.09), c + V(sx * 0.13, -0.11, -0.02 - 0.0), 'Glow', bevel=0.015, segs=1,
                             roll=sx * 0.6))
            parts.append(box((0.36, 0.08, 0.09), c + V(sx * 0.13, 0.11, -0.02), 'Glow', bevel=0.015, segs=1,
                             roll=sx * 0.6))
    return parts


@landmark('tool_glyphs', 'experience')
def tool_glyphs():
    L = LM('tool_glyphs')
    L.ao = dict(distance=1.2, samples=48, floor=0.45)
    L.grad = (-0.3, 0.9, 0.8)
    k_curve = 0.06
    pz = 0.15
    # a low curved platform links the five pedestals into one installation
    n = 26
    xs_ = [-7.0 + 14.0 * i / n for i in range(n + 1)]
    path = [Vector((x, -k_curve * x * x, 0.0)) for x in xs_]
    nors = []
    for i, p in enumerate(path):
        a = path[max(i - 1, 0)]
        b = path[min(i + 1, len(path) - 1)]
        t = (b - a).normalized()
        nors.append(Vector((t.y, -t.x, 0.0)))   # horizontal, pointing to the front side
    hw, c = 1.0, 0.08
    sec = [(hw, -0.3), (hw, pz - c), (hw - c, pz), (-hw + c, pz), (-hw, pz - c), (-hw, -0.3)]
    plat = sweep(path, sec, 'Stone', normals=nors, binormal=Vector((0, 0, 1)),
                 slots=[None, None, None, None, None, None])
    paint(plat, lambda cc, nn: 'StoneDark' if nn.z < 0.5 else None)
    L.add(plat)
    edge = sweep([p + nors[i] * (hw - 0.16) + Vector((0, 0, pz)) for i, p in enumerate(path)],
                 [(0.04, -0.01), (0.04, 0.012), (-0.04, 0.012), (-0.04, -0.01)], 'Trim', normals=nors,
                 binormal=Vector((0, 0, 1)))
    L.add(edge)
    for j in range(5):
        x0, x1 = -7.0 + 2.8 * j, -7.0 + 2.8 * (j + 1)
        xm = (x0 + x1) / 2
        ym = -k_curve * xm * xm
        yaw = math.atan2(-2 * k_curve * xm, 1.0)
        L.col_box(f'COL_BOX_platform_{j}', (xm, ym, (pz - 0.3) / 2), (2.85, 1.9, pz + 0.3), yaw=yaw)
    xs = [-6.0, -3.0, 0.0, 3.0, 6.0]
    for i, x in enumerate(xs):
        y = -k_curve * x * x
        yaw = math.atan2(-x, 14.0 + y)
        p = V(x, y, 0)
        M = Matrix.Translation(p) @ rot(yaw)
        parts = [prism(ngon(6, 0.74, math.pi / 6), pz - 0.05, pz + 0.12, 'StoneDark', bevel=0.035, segs=2),
                 prism(ngon(6, 0.5, math.pi / 6), 0, 0, 'Stone', bevel=0.03, segs=2,
                       levels=[(pz + 0.1, 1.0, 0.0), (0.72, 0.84, 0.0)]),
                 prism(ngon(6, 0.6, math.pi / 6), 0.7, 0.84, 'Trim', bevel=0.02, segs=1),
                 prism(ngon(6, 0.46, math.pi / 6), 0.83, 0.88, 'StoneDark', bevel=0.01, segs=1),
                 torus(0.36, 0.0, (0, 0, 0.885), 'Glow', major=24,
                       section=[(-0.035, -0.01), (0.035, -0.01), (0.035, 0.012), (-0.035, 0.012)]),
                 cylinder(0.2, 0.86, 0.9, 16, 'Trim', chamfer=0.01),
                 box((0.07, 0.04, 0.42), (0.0, -0.455, 0.47), 'Glow', bevel=0.012, segs=1, pitch=-0.12)]
        for k in range(3):          # brass fins on the back and sides
            a = math.radians(90 + 120 * k)
            fin = box((0.06, 0.26, 0.55), polar(0.46, a, 0.47), 'Trim', bevel=0.015, segs=1, yaw=a - math.pi / 2,
                      roll=0.0)
            parts.append(fin)
        for o in parts:
            C.transform(o, M)
        L.add(*parts)
        gz = 2.1
        gl = glyph_spin_parts(i, (0.0, 0.0, 0.0))
        for g in gl:
            C.transform(g, Matrix.Translation((x, y, gz)) @ rot(yaw) @ Matrix.Diagonal((1.35, 1.35, 1.35, 1.0)))
        L.anim(f'ANIM_SPIN_glyph_{i}', gl, (x, y, gz), ao=None)
        L.empty(f'LABEL_glyph_{i}', (x, y - 0.25, 3.55))
        L.col_cyl(f'COL_CYL_pedestal_{i}', (x, y), 0.62, -0.3, 0.9)
    L.empty('POI_read', (0.0, -3.0, 0.0))
    L.empty('LABEL_title', (0.0, -1.0, 4.6))
    return L


# ============================================================================
# CLI
# ============================================================================

SETS = ('shared', 'philosophy', 'experience')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--only', help='comma-separated set names (shared, philosophy, experience)')
    ap.add_argument('--landmarks', help='comma-separated landmark names (QA subset)')
    ap.add_argument('--out', help='output GLB path (QA builds; default public/models/landmarks-<set>.glb)')
    ap.add_argument('--pack-args', default=PACK_ARGS)
    args = ap.parse_args(argv)
    sets = args.only.split(',') if args.only else SETS
    only = set(args.landmarks.split(',')) if args.landmarks else None
    for s in sets:
        if s not in SETS:
            raise SystemExit(f'unknown set {s!r}')
        print(f'[{s}]')
        built = build_set(s, only)
        if not built:
            continue
        out = args.out
        if only and not out:   # QA subsets never overwrite the shipped GLB
            out = os.path.join(BUILD_DIR, f'landmarks-{s}.qa.glb')
        raw, dst = export_set(s, built, out, args.pack_args)
        rep = report(s, built, dst, qa=bool(only or args.out))
        print(f'  -> {os.path.relpath(dst, C.REPO_ROOT)} ({os.path.getsize(dst) / 1024:.1f} KB), '
              f'raw {os.path.getsize(raw) / 1024:.1f} KB, report {os.path.relpath(rep, C.REPO_ROOT)}')


if __name__ == '__main__':
    main(sys.argv[1:] if '--' not in sys.argv else sys.argv[sys.argv.index('--') + 1:])
