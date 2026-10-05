"""
The Unfolding: shared Blender helpers (bpy 5.x, headless, no GUI).

Every asset script in art/blender/ builds geometry with these helpers, so that
materials, normals, vertex AO and export behave the same way across the
flora, ship and landmark libraries.

Import it from a sibling script:

    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import common as C

A typical asset:

    C.reset_scene()
    bm, rings = C.tube(points, radii, sides=6)            # bmesh builders return bmesh
    trunk = C.mesh_object('_trunk', bm, 'Bark')           # wrap as an object with one slot
    crown = C.mesh_object('_crown', C.blob(...), 'Leaf')
    C.set_normals(crown, C.radial_normals(center, 0.8))   # soft, painterly foliage shading
    tree = C.join([trunk, crown], 'tree_round')           # one top-level object per asset
    info = C.finalize(tree, budget=700, ao=dict(distance=2.5))
    C.export_glb(raw_path, [tree]); C.gltfpack(raw_path, out_path)

Conventions (art/STYLE.md):
  * Meters, +Z up, the model faces -Y. Props have their origin at the base center (z = 0).
  * Material slot names are the contract (Rock, Leaf, Glow, ...). The colors in the GLB are
    only defaults; the game swaps materials by name.
  * COLOR_0 holds grayscale AO x gradient, white = full color. It is stored linear, so
    vertex brightness is authored in perceptual (sRGB-like) units and converted on write.

Per-vertex "intent" attributes. Parts set them, join() keeps them and finalize() consumes them:
  nrm    FLOAT_VECTOR  wanted normal direction; (0, 0, 0) keeps Blender's computed normal
  shade  FLOAT         base brightness (perceptual 0..1), e.g. a root-to-tip gradient
  aow    FLOAT         how strongly baked AO darkens this vertex (0 = ignore AO, 1 = full)
"""

import json
import math
import os
import random
import shutil
import subprocess
import zlib

import bpy  # must come first: bpy-as-a-module registers bmesh and mathutils on import
import bmesh
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

TAU = math.tau
UP = Vector((0.0, 0.0, 1.0))
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODELS_DIR = os.path.join(REPO_ROOT, 'public', 'models')

INTENT = ('nrm', 'shade', 'aow')


# ----------------------------------------------------------------------------
# Scene, randomness, small math
# ----------------------------------------------------------------------------

def reset_scene():
    """Start from an empty factory scene (no cube, camera or light) in metric units."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    units = bpy.context.scene.unit_settings
    units.system = 'METRIC'
    units.scale_length = 1.0


def rng_for(name, seed=0):
    """Deterministic random.Random for an asset name (str hash() is salted per process)."""
    return random.Random(zlib.crc32(name.encode('utf-8')) ^ (seed * 0x9E3779B1))


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0)) if e1 != e0 else float(x >= e1)
    return t * t * (3.0 - 2.0 * t)


def vec(x, y=None, z=None):
    """Vector((x, y, z)) from three numbers or any 3-sequence."""
    return Vector((x, y, z)) if y is not None else Vector(x)


def bezier(p0, p1, p2, p3, t):
    """Cubic Bezier point (all Vectors)."""
    u = 1.0 - t
    return p0 * (u * u * u) + p1 * (3 * u * u * t) + p2 * (3 * u * t * t) + p3 * (t * t * t)


def bezier_points(p0, p1, p2, p3, n):
    """n points evenly spaced in t along a cubic Bezier (n >= 2)."""
    return [bezier(p0, p1, p2, p3, i / (n - 1)) for i in range(n)]


def noise3(p, scale=1.0, offset=(0.0, 0.0, 0.0)):
    """Smooth Perlin noise in roughly [-1, 1]. Deterministic; vary `offset` for different seeds."""
    return noise.noise(Vector(p) * scale + Vector(offset))


def rot_z(angle):
    return Matrix.Rotation(angle, 4, 'Z')


# ----------------------------------------------------------------------------
# Colors and materials
# ----------------------------------------------------------------------------

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(h):
    h = h.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


# Default colors written into GLBs: the Philosophy world (the game recolors by slot name).
DEFAULT_PALETTE = {
    'Grass': '#79c99a', 'Leaf': '#3fae8c', 'LeafAlt': '#7fe0b5', 'Bark': '#6b5b4e',
    'Rock': '#dfe8e0', 'RockDark': '#8fa8a0', 'Petal': '#ffd38a', 'Crystal': '#9ff5dc',
    'Glow': '#8cf0d1', 'Sand': '#f1e3c0', 'Stone': '#e6ece6', 'Trim': '#8cf0d1',
    'Metal': '#9aa6ad', 'StoneDark': '#9fb0a8', 'Accent': '#f0744e',
    'Hull': '#e9e4d5', 'HullDark': '#32636a', 'Glass': '#1b2a33',
    'Suit': '#e9e4d5', 'SuitDark': '#32636a', 'Fabric': '#3d4a52', 'Visor': '#8cf0d1',
    'Rubber': '#1d232a',
}

# Per-slot surface response. Stylized look: rough dielectrics, emissive only for meaning.
SLOT_STYLE = {
    'Rock': dict(roughness=0.92), 'RockDark': dict(roughness=0.95), 'Stone': dict(roughness=0.9),
    'StoneDark': dict(roughness=0.92), 'Sand': dict(roughness=1.0), 'Bark': dict(roughness=0.9),
    'Leaf': dict(roughness=0.78), 'LeafAlt': dict(roughness=0.75), 'Grass': dict(roughness=0.85),
    'Petal': dict(roughness=0.6),
    'Crystal': dict(roughness=0.28),
    'Glow': dict(roughness=0.5, emission=2.0),
    'Metal': dict(roughness=0.38, metallic=0.85), 'Trim': dict(roughness=0.4, metallic=0.6),
    'Visor': dict(roughness=0.15, emission=1.5), 'Glass': dict(roughness=0.08),
}

# Thin, single-layer surfaces (blades, fronds, petals) render from both sides.
DOUBLE_SIDED = {'Grass', 'Leaf', 'LeafAlt', 'Petal'}


def material(slot, color=None, **overrides):
    """Get or create the material named exactly `slot` (one datablock per slot name).

    color: '#rrggbb' sRGB (defaults to DEFAULT_PALETTE). overrides: roughness, metallic,
    emission (strength; emission color = base color), double_sided.
    """
    mat = bpy.data.materials.get(slot)
    if mat is not None:
        return mat
    style = dict(SLOT_STYLE.get(slot, {}))
    style.update(overrides)
    rgb = hex_to_linear(color or DEFAULT_PALETTE.get(slot, '#cccccc'))
    mat = bpy.data.materials.new(slot)
    if hasattr(mat, 'use_nodes') and not mat.use_nodes:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = style.get('roughness', 0.85)
    bsdf.inputs['Metallic'].default_value = style.get('metallic', 0.0)
    if style.get('emission'):
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Emission Strength'].default_value = style['emission']
    mat.diffuse_color = (*rgb, 1.0)
    mat.use_backface_culling = not style.get('double_sided', slot in DOUBLE_SIDED)
    return mat


def slot_index(ob, slot):
    """Index of material `slot` on the object, appending the slot if missing."""
    mats = ob.data.materials
    for i, m in enumerate(mats):
        if m is not None and m.name == slot:
            return i
    mats.append(material(slot))
    return len(mats) - 1


def paint_faces(ob, fn):
    """Assign materials per face: fn(polygon) -> slot name or None (keep current)."""
    for poly in ob.data.polygons:
        slot = fn(poly)
        if slot:
            poly.material_index = slot_index(ob, slot)


def used_slots(ob):
    """Slot names actually referenced by faces, in slot order."""
    used = {p.material_index for p in ob.data.polygons}
    return [m.name for i, m in enumerate(ob.data.materials) if i in used and m is not None]


# ----------------------------------------------------------------------------
# Objects
# ----------------------------------------------------------------------------

def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_object(name, bm, slot=None, smooth=True):
    """Turn a bmesh into a linked object (frees the bmesh). Optionally one material slot."""
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    if slot:
        me.materials.append(material(slot))
    if smooth:
        me.shade_smooth()
    else:
        me.shade_flat()
    return ob


def duplicate(ob, name=None):
    new = ob.copy()
    new.data = ob.data.copy()
    new.name = name or (ob.name + '_dup')
    return link(new)


def delete(ob):
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def transform(ob, matrix):
    """Bake a 4x4 matrix into the mesh (and rotate the `nrm` intent vectors to match)."""
    me = ob.data
    me.transform(matrix)
    a = me.attributes.get('nrm')
    if a is not None:
        nm = matrix.to_3x3().inverted_safe().transposed()
        for d in a.data:
            v = Vector(d.vector)
            if v.length_squared > 0.0:
                d.vector = (nm @ v).normalized()
    me.update()


def apply_transform(ob):
    """Bake the object's own transform into its mesh so it sits at identity."""
    if ob.matrix_basis != Matrix.Identity(4):
        transform(ob, ob.matrix_basis.copy())
        ob.matrix_basis = Matrix.Identity(4)


def apply_modifiers(ob):
    """Apply the whole modifier stack via the evaluated mesh (no operator context needed)."""
    if not ob.modifiers:
        return
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True,
                                          depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = new
    new.name = old.name
    if old.users == 0:
        bpy.data.meshes.remove(old)


def modifier(ob, kind, apply=True, **props):
    """Add a modifier with properties (and apply it by default)."""
    m = ob.modifiers.new(kind.title(), kind)
    for k, v in props.items():
        setattr(m, k, v)
    if apply:
        apply_modifiers(ob)
    return m


def bevel(ob, width, segments=1, angle=35.0, profile=0.5, clamp_overlap=True, harden=False):
    """Bevel edges sharper than `angle` degrees. Width in meters (style: 2-4% of the object)."""
    modifier(ob, 'BEVEL', width=width, segments=segments, limit_method='ANGLE',
             angle_limit=math.radians(angle), profile=profile, use_clamp_overlap=clamp_overlap,
             harden_normals=harden, miter_outer='MITER_ARC' if segments > 1 else 'MITER_SHARP')


def subsurf(ob, levels=1):
    modifier(ob, 'SUBSURF', levels=levels, render_levels=levels)


def decimate(ob, target_tris=None, ratio=None):
    """Collapse-decimate to roughly `target_tris` triangles (or by `ratio`)."""
    if ratio is None:
        ratio = clamp(target_tris / max(1, tri_count(ob)), 0.0, 1.0)
    if ratio < 1.0:
        modifier(ob, 'DECIMATE', decimate_type='COLLAPSE', ratio=ratio, use_collapse_triangulate=True)


def planar_decimate(ob, angle=5.0):
    """Dissolve nearly coplanar faces into n-gons (cleans up flat facets)."""
    modifier(ob, 'DECIMATE', decimate_type='DISSOLVE', angle_limit=math.radians(angle))


def remesh(ob, voxel_size, adaptivity=0.0):
    """Voxel remesh into one watertight surface (unions overlapping parts)."""
    modifier(ob, 'REMESH', mode='VOXEL', voxel_size=voxel_size, adaptivity=adaptivity,
             use_smooth_shade=True)


def join(parts, name):
    """Join parts into one object named `name` (materials merge by slot name).

    Intent attributes are created with defaults on every part first, so a part without an
    explicit gradient does not inherit zeros.
    """
    parts = [p for p in parts if p is not None]
    for p in parts:
        apply_transform(p)
        ensure_intent(p)
    base = parts[0]
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=parts,
                                       selected_editable_objects=parts):
            bpy.ops.object.join()
    if bpy.data.objects.get(name) is not None and bpy.data.objects[name] is not base:
        raise ValueError(f'object name {name!r} already taken')
    base.name = name
    base.data.name = name
    return base


# ----------------------------------------------------------------------------
# Intent attributes (normals, shade, AO weight)
# ----------------------------------------------------------------------------

def ensure_intent(ob):
    """Create the intent attributes with neutral defaults (nrm 0 = keep, shade 1, aow 1)."""
    me = ob.data
    if me.attributes.get('nrm') is None:
        me.attributes.new('nrm', 'FLOAT_VECTOR', 'POINT')  # zeros = keep computed normal
    for name in ('shade', 'aow'):
        if me.attributes.get(name) is None:
            a = me.attributes.new(name, 'FLOAT', 'POINT')
            a.data.foreach_set('value', [1.0] * len(me.vertices))


def set_normals(ob, fn):
    """Wanted normals: fn(co, geometric_normal) -> Vector (normalized here) or None (keep)."""
    ensure_intent(ob)
    me = ob.data
    a = me.attributes['nrm']
    for v in me.vertices:
        n = fn(v.co.copy(), Vector(me.vertex_normals[v.index].vector))
        if n is not None and n.length_squared > 1e-12:
            a.data[v.index].vector = n.normalized()


def radial_normals(center, amount=1.0, squash=(1.0, 1.0, 1.0)):
    """Blend geometric normals toward the direction from `center` (soft spherical shading).

    squash scales the offset per axis before normalizing, e.g. (1, 1, 1.6) for a flattened
    canopy whose shading should still read as a dome.
    """
    c = Vector(center)
    s = Vector(squash)

    def fn(co, n):
        d = co - c
        d = Vector((d.x * s.x, d.y * s.y, d.z * s.z))
        if d.length_squared < 1e-12:
            return n
        return n.lerp(d.normalized(), amount)
    return fn


def set_shade(ob, fn):
    """Base brightness per vertex: fn(co) -> perceptual 0..1 (multiplies with AO)."""
    ensure_intent(ob)
    me = ob.data
    a = me.attributes['shade']
    for v in me.vertices:
        a.data[v.index].value = fn(v.co.copy())


def gradient(z0, z1, v0, v1=1.0, curve=1.0):
    """fn(co) for set_shade: v0 at height z0 rising to v1 at z1 (shaped by `curve` exponent)."""
    def fn(co):
        t = clamp((co.z - z0) / (z1 - z0)) if z1 != z0 else 1.0
        return lerp(v0, v1, t ** curve)
    return fn


def set_ao_weight(ob, value):
    """How much baked AO applies: a float, or fn(co) -> float."""
    ensure_intent(ob)
    me = ob.data
    a = me.attributes['aow']
    for v in me.vertices:
        a.data[v.index].value = value(v.co.copy()) if callable(value) else value


# ----------------------------------------------------------------------------
# bmesh builders (each returns a new bmesh; wrap with mesh_object)
# ----------------------------------------------------------------------------

def frames(points, up=None):
    """Parallel-transport frames (tangent, normal, binormal) along a polyline."""
    n = len(points)
    if n < 2:
        raise ValueError('frames()/tube() need at least two path points')
    tans = []
    for i in range(n):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, n - 1)]
        t = b - a
        if t.length < 1e-9:  # repeated points: borrow the nearest valid direction
            t = (points[-1] - points[0])
        tans.append(t.normalized())
    ref = Vector(up) if up is not None else Vector((1.0, 0.0, 0.0))
    if abs(tans[0].dot(ref)) > 0.95:
        ref = Vector((0.0, 1.0, 0.0)) if abs(tans[0].y) < 0.95 else Vector((0.0, 0.0, 1.0))
    nor = [(ref - tans[0] * ref.dot(tans[0])).normalized()]
    for i in range(1, n):
        q = tans[i - 1].rotation_difference(tans[i])
        m = q @ nor[-1]
        m = (m - tans[i] * m.dot(tans[i])).normalized()
        nor.append(m)
    bin_ = [tans[i].cross(nor[i]) for i in range(n)]
    return tans, nor, bin_


def tube(points, radii, sides=6, cap_start=True, cap_end=True, start_tip=None, end_tip=None,
         phase=0.0, radial=None, up=None, bm=None):
    """Sweep a polygonal cross-section along `points` (Vectors).

    radii: number, list of numbers, or list of (rx, ry) for elliptical sections.
    radial(i_ring, j_side, angle) -> multiplier, for ribs, scallops or noise.
    start_tip / end_tip: Vector apex that closes that end with a cone fan (pointed end);
    otherwise cap_start / cap_end closes it with an n-gon.
    Returns (bmesh, rings) where rings[i] lists the BMVerts of ring i.
    """
    bm = bm or bmesh.new()
    tans, nor, bin_ = frames(points, up)
    rings = []
    for i, p in enumerate(points):
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        rx, ry = (r, r) if not isinstance(r, (list, tuple)) else r
        ring = []
        for j in range(sides):
            a = phase + TAU * j / sides
            m = radial(i, j, a) if radial else 1.0
            off = (nor[i] * (math.cos(a) * rx) + bin_[i] * (math.sin(a) * ry)) * m
            ring.append(bm.verts.new(p + off))
        rings.append(ring)
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(sides):
            k = (j + 1) % sides
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    if end_tip is not None:
        tip = bm.verts.new(Vector(end_tip))
        last = rings[-1]
        for j in range(sides):
            bm.faces.new((last[j], last[(j + 1) % sides], tip))
    elif cap_end:
        bm.faces.new(rings[-1])
    if start_tip is not None:
        tip = bm.verts.new(Vector(start_tip))
        first = rings[0]
        for j in range(sides):
            bm.faces.new((first[(j + 1) % sides], first[j], tip))
    elif cap_start:
        bm.faces.new(list(reversed(rings[0])))
    return bm, rings


def lathe(profile, sides=8, radial=None, phase=0.0, center=(0.0, 0.0, 0.0), cap_bottom=True,
          cap_top=True, bm=None):
    """Revolve a profile [(r, z), ...] around the +Z axis through `center`.

    Winding rule: list the profile counter-clockwise in the (r right, z up) plane, i.e. walk
    up the outside of the shape (bottom or underside first, top last). Faces then point
    outward. A first or last entry with r == 0 becomes a pole; otherwise cap_bottom/cap_top
    closes that end with an n-gon. radial(i_ring, j_side, angle) -> radius multiplier.
    Returns (bmesh, rings) with rings[i] = BMVerts of the i-th non-pole profile entry.
    """
    bm = bm or bmesh.new()
    c = Vector(center)
    prof = list(profile)
    start_pole = end_pole = None
    if prof[0][0] <= 1e-9:
        start_pole = prof.pop(0)[1]
    if prof and prof[-1][0] <= 1e-9:
        end_pole = prof.pop()[1]
    rings = []
    for i, (r, z) in enumerate(prof):
        ring = []
        for j in range(sides):
            a = phase + TAU * j / sides
            m = radial(i, j, a) if radial else 1.0
            ring.append(bm.verts.new(c + Vector((math.cos(a) * r * m, math.sin(a) * r * m, z))))
        rings.append(ring)
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(sides):
            k = (j + 1) % sides
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    first, last = rings[0], rings[-1]
    if start_pole is not None:
        pole = bm.verts.new(c + Vector((0.0, 0.0, start_pole)))
        for j in range(sides):
            bm.faces.new((first[(j + 1) % sides], first[j], pole))
    elif cap_bottom:
        bm.faces.new(list(reversed(first)))
    if end_pole is not None:
        pole = bm.verts.new(c + Vector((0.0, 0.0, end_pole)))
        for j in range(sides):
            bm.faces.new((last[j], last[(j + 1) % sides], pole))
    elif cap_top:
        bm.faces.new(last)
    return bm, rings


def strip(points, widths, side, tip=True, bm=None):
    """A flat ribbon along points (blades, petals). One plane: render DoubleSide or orient it.

    widths: half-width per point. side: Vector (or per-point list) giving the ribbon's width
    direction. With tip=True the last point is a single vertex (pointed end).
    Returns (bmesh, [(left, right), ...]).
    """
    bm = bm or bmesh.new()
    pairs = []
    n = len(points)
    for i, p in enumerate(points):
        s = side[i] if isinstance(side, (list, tuple)) else side
        if tip and i == n - 1:
            v = bm.verts.new(p)
            pairs.append((v, v))
        else:
            pairs.append((bm.verts.new(p - s * widths[i]), bm.verts.new(p + s * widths[i])))
    for i in range(n - 1):
        l0, r0 = pairs[i]
        l1, r1 = pairs[i + 1]
        if l1 is r1:
            bm.faces.new((l0, r0, l1))
        else:
            bm.faces.new((l0, r0, r1, l1))
    return bm, pairs


def icosphere(subdivisions=1, radius=1.0, bm=None):
    bm = bm or bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius)
    return bm


def blob(center, radii, subdivisions=2, lump=0.12, lump_scale=1.6, seed=0.0, flatten=None,
         bm=None):
    """Lumpy ellipsoid (foliage clump, pebble). flatten = (z_cut, softness) squashes the bottom."""
    bm = bm or bmesh.new()
    new = icosphere(subdivisions, 1.0)
    c, r = Vector(center), Vector(radii)
    off = (seed * 13.1, seed * 7.7, seed * 3.3)
    for v in new.verts:
        d = v.co.normalized()
        k = 1.0 + lump * noise3(d, lump_scale, off)
        p = Vector((d.x * r.x, d.y * r.y, d.z * r.z)) * k
        if flatten is not None:
            zc, soft = flatten
            if p.z < zc:
                p.z = zc + (p.z - zc) * soft
        v.co = c + p
    me = bpy.data.meshes.new('_tmp')
    new.to_mesh(me)
    new.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return bm


def convex_hull(points, bm=None):
    """Convex hull of points as a closed bmesh (interior points discarded)."""
    bm = bm or bmesh.new()
    verts = [bm.verts.new(Vector(p)) for p in points]
    res = bmesh.ops.convex_hull(bm, input=verts, use_existing_faces=False)
    junk = [g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert)]
    if junk:
        bmesh.ops.delete(bm, geom=junk, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def chisel(bm, co, no):
    """Slice the bmesh with a plane, discard the side `no` points to and cap the cut flat.

    Returns the new cap faces (the planar facets), e.g. to bevel only their borders.
    """
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector(co), plane_no=Vector(no),
                                 clear_outer=True, dist=1e-5)
    cut = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    boundary = [e for e in cut if e.is_valid and e.is_boundary]
    caps = []
    if boundary:
        caps = bmesh.ops.holes_fill(bm, edges=boundary, sides=0)['faces']
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return caps


def bevel_weighted(ob, width, segments=1, profile=0.5):
    """Bevel only edges whose `bevel_weight_edge` attribute is > 0 (set it in bmesh first)."""
    modifier(ob, 'BEVEL', width=width, segments=segments, limit_method='WEIGHT', profile=profile,
             use_clamp_overlap=True, harden_normals=False)


def outline(n, rx, ry, rng, jitter=0.12, angle_jitter=0.35, lobes=(), phase=None):
    """Irregular closed 2D outline (counter-clockwise list of (x, y)) around the origin.

    lobes: [(frequency, amplitude), ...] low-frequency radius waves for organic shapes.
    """
    ph = rng.uniform(0, TAU) if phase is None else phase
    waves = [(f, a, rng.uniform(0, TAU)) for f, a in lobes]
    pts = []
    for i in range(n):
        a = ph + TAU * (i + rng.uniform(-angle_jitter, angle_jitter) * 0.5) / n
        k = 1.0 + rng.uniform(-jitter, jitter) + sum(amp * math.cos(f * a + p) for f, amp, p in waves)
        pts.append((math.cos(a) * rx * k, math.sin(a) * ry * k))
    return pts


def inset(poly, d):
    """Offset a counter-clockwise 2D polygon inward by distance d (mitered, clamped)."""
    n = len(poly)
    out = []
    for i in range(n):
        px, py = poly[i - 1]
        cx, cy = poly[i]
        nx_, ny_ = poly[(i + 1) % n]
        e1 = Vector((cx - px, cy - py)).normalized()
        e2 = Vector((nx_ - cx, ny_ - cy)).normalized()
        n1 = Vector((-e1.y, e1.x))
        n2 = Vector((-e2.y, e2.x))
        b = n1 + n2
        if b.length < 1e-6:
            b = n1
        b.normalize()
        k = d / max(0.35, b.dot(n1))
        out.append((cx + b.x * k, cy + b.y * k))
    return out


def prism(poly, z0, z1, chamfer=0.0, bottom=True, top=True, bm=None, xform=None):
    """Extrude a CCW 2D outline from z0 to z1, optionally with a chamfered top rim.

    The chamfer is real geometry (side ring at z1 - chamfer, inset top ring at z1), so it
    catches light like a bevel at a fixed, predictable triangle cost. Thin wrapper around
    extrude_profile(); returns (bmesh, rings).
    """
    levels = [(z0, 1.0, 0.0)]
    levels += [(z1 - chamfer, 1.0, 0.0), (z1, 1.0, chamfer)] if chamfer > 0.0 else [(z1, 1.0, 0.0)]
    return extrude_profile(poly, levels, top=top, bottom=bottom, bm=bm, xform=xform)


def extrude_profile(poly, levels, top=True, bottom=True, bm=None, xform=None, center=None,
                    sharp_bottom=True, sharp_top=None):
    """Stack rings of a CCW 2D outline: levels = [(z, scale, inset), ...] from bottom to top.

    Each ring is the outline scaled about `center` (default centroid) then inset by `inset`
    meters, so one call builds tapered strata with chamfered rims or undercuts. The top and
    bottom rings are capped with n-gons. Cap borders are marked sharp (by default the top one
    only when the last level is not an inset chamfer), so a big cap never drags the wall
    normals around when weighted normals are applied. Returns (bmesh, rings).
    """
    bm = bm or bmesh.new()
    xf = xform or (lambda v: v)
    if center is None:
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
    else:
        cx, cy = center
    rings = []
    for z, scale, ins in levels:
        pts = [(cx + (x - cx) * scale, cy + (y - cy) * scale) for x, y in poly]
        if ins:
            pts = inset(pts, ins)
        rings.append([bm.verts.new(xf(Vector((x, y, z)))) for x, y in pts])
    n = len(poly)
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    if sharp_top is None:
        sharp_top = not levels[-1][2]
    if top:
        f = bm.faces.new(rings[-1])
        if sharp_top:
            for e in f.edges:
                e.smooth = False
    if bottom:
        f = bm.faces.new(list(reversed(rings[0])))
        if sharp_bottom:
            for e in f.edges:
                e.smooth = False
    return bm, rings


def basis(f):
    """Two unit vectors (u, v) perpendicular to direction f (u x v = f)."""
    f = Vector(f).normalized()
    ref = UP if abs(f.z) < 0.9 else Vector((1.0, 0.0, 0.0))
    u = ref.cross(f).normalized()
    v = f.cross(u).normalized()
    return u, v


def align_z(direction, origin=(0.0, 0.0, 0.0)):
    """4x4 matrix mapping +Z to `direction`, then translating to `origin`."""
    q = Vector(direction).normalized().to_track_quat('Z', 'Y')
    return Matrix.Translation(Vector(origin)) @ q.to_matrix().to_4x4()


def skin(name, verts, edges, radii, root=0, levels=1, slot=None, smooth=True):
    """Organic branching tube mesh from a vertex/edge skeleton (Skin + Subsurf, applied).

    radii: one radius per skeleton vertex (number or (rx, ry)). Joints and forks come out as
    one smooth surface, which is what coral, roots and forked trunks want. Decimate after.
    """
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [tuple(e) for e in edges], [])
    me.update()
    ob = link(bpy.data.objects.new(name, me))
    mod = ob.modifiers.new('Skin', 'SKIN')
    mod.use_smooth_shade = smooth
    data = me.skin_vertices[0].data
    for i, r in enumerate(radii):
        data[i].radius = (r, r) if not isinstance(r, (list, tuple)) else tuple(r)
        data[i].use_root = (i == root)
    if levels:
        sub = ob.modifiers.new('Subsurf', 'SUBSURF')
        sub.levels = levels
        sub.render_levels = levels
    apply_modifiers(ob)
    if slot:
        ob.data.materials.append(material(slot))
    if smooth:
        ob.data.shade_smooth()
    return ob


def merge(bms):
    """Concatenate several bmeshes into the first one (others are freed)."""
    base = bms[0]
    for other in bms[1:]:
        me = bpy.data.meshes.new('_tmp')
        other.to_mesh(me)
        other.free()
        base.from_mesh(me)
        bpy.data.meshes.remove(me)
    return base


def _bvh(ob):
    me = ob.data
    return BVHTree.FromPolygons([v.co.copy() for v in me.vertices],
                                [tuple(p.vertices) for p in me.polygons])


_PARITY_DIRS = [Vector(d).normalized() for d in ((0.31, 0.22, 0.93), (-0.57, 0.41, -0.71),
                                                  (0.83, -0.52, 0.19))]


def _parity(tree, p, d):
    """Odd number of surface crossings along ray p + t*d -> p is inside a closed mesh."""
    count, o = 0, p.copy()
    for _ in range(256):
        hit = tree.ray_cast(o, d)
        if hit[0] is None:
            break
        count += 1
        o = hit[0] + d * 1e-5
    return count % 2 == 1


def _inside(trees, p, margin):
    """Robust inside test: majority vote of three skewed parity rays per closed mesh."""
    for t in trees:
        if sum(_parity(t, p, d) for d in _PARITY_DIRS) >= 2:
            if margin <= 0.0 or t.find_nearest(p)[3] > margin:
                return True
    return False


def remove_hidden_faces(objs, occluders=(), margin=0.0):
    """Delete faces of each object that lie entirely inside another closed object.

    Saves triangles where foliage clumps, tiers or rocks interpenetrate. All inside tests use
    the original closed meshes (computed before anything is deleted). Extra `occluders`
    hide faces without losing any of their own. `margin` > 0 keeps faces only barely inside.
    Returns the number of faces removed.
    """
    objs = [o for o in objs if o is not None]
    pool = objs + [o for o in occluders if o is not None and o not in objs]
    trees = {o.name: _bvh(o) for o in pool}
    plans = []
    for ob in objs:
        others = [t for name, t in trees.items() if name != ob.name]
        me = ob.data
        vin = [_inside(others, v.co, margin) for v in me.vertices]
        doomed = [p.index for p in me.polygons
                  if all(vin[i] for i in p.vertices) and _inside(others, p.center, margin)]
        plans.append((ob, doomed))
    removed = 0
    for ob, doomed in plans:
        if not doomed:
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in doomed], context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
        removed += len(doomed)
    return removed


# ----------------------------------------------------------------------------
# Triangulation, normals, vertex AO, final checks
# ----------------------------------------------------------------------------

def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def triangulate(ob):
    """Triangulate with BEAUTY splits (do this before normals are made custom)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def weighted_normals(ob, weight=100, keep_sharp=True):
    """Face-area weighted normals: big planar facets stay flat, small bevel faces blend."""
    modifier(ob, 'WEIGHTED_NORMAL', mode='FACE_AREA', weight=weight, keep_sharp=keep_sharp)


def bake_normals(ob):
    """Make the final per-corner normals explicit: computed normals, overridden by `nrm`."""
    me = ob.data
    nrm = me.attributes.get('nrm')
    loops = [Vector(cn.vector) for cn in me.corner_normals]
    if nrm is not None:
        for li, loop in enumerate(me.loops):
            want = Vector(nrm.data[loop.vertex_index].vector)
            if want.length_squared > 1e-12:
                loops[li] = want.normalized()
    me.normals_split_custom_set([tuple(n) for n in loops])
    return loops


def _hemisphere(n):
    """Cosine-weighted Fibonacci directions around +Z."""
    golden = math.pi * (3.0 - math.sqrt(5.0))
    out = []
    for i in range(n):
        u = (i + 0.5) / n
        r = math.sqrt(u)
        th = i * golden
        out.append(Vector((r * math.cos(th), r * math.sin(th), math.sqrt(max(0.0, 1.0 - u)))))
    return out


def vertex_neighbors(me):
    nb = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    return nb


def bake_ao(ob, distance, samples=64, ground=True, ground_z=0.0, smooth=1, bias=None):
    """Ray-traced ambient occlusion per vertex (1 = open, 0 = fully occluded).

    Rays start just off each vertex along its normal; hits within `distance` occlude with a
    soft (1 - (t/d)^2) falloff. With ground=True the plane z = ground_z also occludes, which
    gives the dark contact band where props meet the terrain.
    """
    me = ob.data
    cos = [v.co.copy() for v in me.vertices]
    tree = BVHTree.FromPolygons(cos, [tuple(p.vertices) for p in me.polygons])
    dirs = _hemisphere(samples)
    eps = bias if bias is not None else distance * 0.004 + 1e-4
    vals = []
    for i, co in enumerate(cos):
        n = Vector(me.vertex_normals[i].vector)
        if n.length_squared < 1e-12:
            n = UP.copy()
        if ground and co.z < ground_z - 1e-4:
            vals.append(0.0)
            continue
        rot = n.to_track_quat('Z', 'Y').to_matrix()
        o = co + n * eps
        occ = 0.0
        for d in dirs:
            w = rot @ d
            hit = tree.ray_cast(o, w, distance)
            t = hit[3] if hit[0] is not None else None
            if ground and w.z < -1e-6:
                tg = (ground_z - o.z) / w.z
                if 0.0 <= tg <= distance and (t is None or tg < t):
                    t = tg
            if t is not None:
                occ += 1.0 - (t / distance) ** 2
        vals.append(1.0 - occ / len(dirs))
    if smooth:
        nb = vertex_neighbors(me)
        for _ in range(smooth):
            vals = [0.5 * v + 0.5 * (sum(vals[j] for j in nb[i]) / len(nb[i]) if nb[i] else v)
                    for i, v in enumerate(vals)]
    return vals


def write_vertex_colors(ob, values, name='Col'):
    """Write perceptual grayscale values as the exported COLOR_0 (linear FLOAT_COLOR, POINT)."""
    me = ob.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    col = me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
    flat = []
    for v in values:
        g = srgb_to_linear(clamp(v))
        flat.extend((g, g, g, 1.0))
    col.data.foreach_set('color', flat)
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find(name)
    return col


def finalize(ob, budget=None, ao=None, weighted=False):
    """Triangulate, bake normals and COLOR_0 (AO x shade), strip helpers, enforce the budget.

    ao: dict for bake_ao (distance, samples, ground, ...) plus
        floor (perceptual brightness at full occlusion, default 0.35) and
        gamma (shapes the AO falloff, default 1.0). ao=None skips AO (shade only).
    weighted: apply face-area weighted normals first (hard-surface rocks, crystals).
    Returns a stats dict.
    """
    apply_transform(ob)
    ensure_intent(ob)
    if weighted:
        weighted_normals(ob)
        apply_modifiers(ob)
        loops = [Vector(cn.vector) for cn in ob.data.corner_normals]
        # keep weighted normals through triangulation: stash per corner, rebuild after
        tri = _triangulate_keep_normals(ob, loops)
    else:
        triangulate(ob)
        tri = None
    me = ob.data
    if tri is None:
        bake_normals(ob)
    else:
        nrm = me.attributes.get('nrm')
        if nrm is not None:
            for li, loop in enumerate(me.loops):
                want = Vector(nrm.data[loop.vertex_index].vector)
                if want.length_squared > 1e-12:
                    tri[li] = want.normalized()
        me.normals_split_custom_set([tuple(n) for n in tri])

    shade = [d.value for d in me.attributes['shade'].data]
    aow = [d.value for d in me.attributes['aow'].data]
    if ao is not None:
        opts = dict(ao)
        floor = opts.pop('floor', 0.35)
        gamma = opts.pop('gamma', 1.0)
        raw = bake_ao(ob, **opts)
        vals = []
        for s, w, a in zip(shade, aow, raw):
            occl = lerp(floor, 1.0, clamp(a) ** gamma)
            vals.append(s * lerp(1.0, occl, w))
    else:
        vals = shade
    write_vertex_colors(ob, vals)
    for name in INTENT:
        a = me.attributes.get(name)
        if a is not None:
            me.attributes.remove(a)
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    me.update()
    info = stats(ob)
    if budget is not None and info['triangles'] > budget:
        raise RuntimeError(f"{ob.name}: {info['triangles']} triangles exceeds budget {budget}")
    return info


def _triangulate_keep_normals(ob, corner_normals):
    """Triangulate while carrying per-corner normals over (BMesh drops custom normals)."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.loops.layers.float_vector.new('_cn')
    bm.faces.ensure_lookup_table()
    for poly in me.polygons:  # BMesh keeps Mesh face order and each face's corner order
        f = bm.faces[poly.index]
        for k, loop in enumerate(f.loops):
            loop[layer] = corner_normals[poly.loop_start + k]
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(me)
    me.update()
    out = [None] * len(me.loops)
    bm.faces.ensure_lookup_table()
    for poly in me.polygons:
        f = bm.faces[poly.index]
        for k, loop in enumerate(f.loops):
            out[poly.loop_start + k] = Vector(loop[layer]).normalized()
    bm.free()
    a = me.attributes.get('_cn')
    if a is not None:
        me.attributes.remove(a)
    return out


def stats(ob, centered=False):
    """triangles, height (z extent above origin, or full extent if centered), footprint radius."""
    me = ob.data
    zs = [v.co.z for v in me.vertices]
    rad = max(math.hypot(v.co.x, v.co.y) for v in me.vertices)
    return {
        'triangles': tri_count(ob),
        'height': (max(zs) - min(zs)) if centered else max(zs),
        'min_z': min(zs),
        'radius': rad,
        'materials': used_slots(ob),
        'size': tuple(ob.dimensions),
    }


# ----------------------------------------------------------------------------
# Export
# ----------------------------------------------------------------------------

def export_glb(path, objects):
    """Export only `objects` as GLB: modifiers applied, Y-up, COLOR_0 from the render color
    attribute, no UVs, cameras, lights or animation."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_materials='EXPORT',
        export_cameras=False, export_lights=False, export_animations=False, export_extras=False)
    return path


def find_gltfpack():
    """gltfpack executable: $GLTFPACK, then PATH, then the shared tools install."""
    for cand in (os.environ.get('GLTFPACK'), shutil.which('gltfpack'),
                 '/tmp/claude-0/tools/node_modules/.bin/gltfpack'):
        if cand and os.path.exists(cand):
            return cand
    raise FileNotFoundError('gltfpack not found; set $GLTFPACK')


def gltfpack(src, dst, args=('-cc', '-kn', '-km')):
    """Optimize with gltfpack. -kn/-km keep node and material names (the game relies on them)."""
    exe = find_gltfpack()
    real = os.path.realpath(exe)
    cmd = (['node', real] if real.endswith('.js') else [exe]) + ['-i', src, '-o', dst, *args]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'gltfpack failed: {res.stderr or res.stdout}')
    return dst


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2)
        fh.write('\n')
    return path
