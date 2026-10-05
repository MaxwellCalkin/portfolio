"""The explorer agent for The Unfolding: model, rig, skin, animations and rifle in one GLB.

Run headless (Blender 5 as a Python module):
    /home/claude/blender/.venv/bin/python art/blender/agent.py [--quick] [--clips Idle,Run] [--noanim]

  --quick   skip the vertex AO bake (fast geometry iteration)
  --clips   only build the listed animation clips
  --noanim  rest pose only

Spec: art/specs/AGENT.md. Style: art/STYLE.md. Deterministic: no randomness, rerun after any tweak.

Design ("Lowend", an original hero-shooter explorer for Max, a touring bassist turned engineer):
  * Helmet: ivory faceted shell with a navy headband over the crown that joins two round, over-ear
    comm pods (teal glow rings, short antenna on the left pod). Large wraparound dark-teal visor with a
    glowing brow line; ivory chin bar with a navy vented keel.
  * Cropped ivory tech jacket with a dropped-back hem: tall asymmetric funnel collar (diagonal cut, high
    at the front-left) with coral lining, coral side panels, chest/princess seams, offset storm flap,
    angular navy deltoid plates, coral band on the left upper sleeve, ivory cuffs with coral piping,
    and a small wrist computer (glowing screen) on the left forearm.
  * Navy bass-strap harness from the left shoulder to the right hip, gunmetal buckle.
  * "Resonance pack": rounded navy back unit with an ivory rim and a flat rear panel carrying a raised
    speaker (ivory surround, glow ring, gunmetal cone, glowing dust cap); two gunmetal thrusters at its
    bottom corners (Jet_L / Jet_R bones sit at their exits).
  * Navy cargo pants (slate outer-seam stripe, thigh pockets) with ivory knee guards; chunky boots
    (rubber soles, navy uppers, ivory toe caps/heels/collars, buckled shaft strap, coral pull tabs);
    navy gloves with gunmetal knuckle plates.
  * Pulse rifle (0.95 m): ivory receiver, navy stock/shroud/grips, coral stripe, teal energy cell on
    top, glow conduits, holo sight, gunmetal muzzle with a glow ring. Modeled with the barrel along local
    -Y (glTF +Z) and the grip at the origin; it is an identity child of WeaponSocket in the GLB.

Rig: the spec skeleton plus finger bones (Thumb1/2, Index1/2, Middle1/2, Ring1/2 per hand; Ring drives
ring and little finger) for the grips and the AirBass fingering. Bone local axes are kept in glTF:
WeaponSocket +Z = barrel, +Y = rifle up; Jet_L/R +Y = exhaust direction (down and back). Rigid
hard-surface pieces are 100% weighted to one bone; fabric shells get hand-authored smooth weights
(knee fronts follow the shin, pelvis seams are shared by both legs); max 4 influences per vertex.

Animations are procedural: per frame the script builds a world-space pose (pelvis, spine chain, foot
plants, rifle placement), solves two-bone IK for legs and arms (hands follow the rifle grip and
foregrip), converts to local bone rotations and keys them. Feet plant with a heel/ball roll on contact
points that move exactly with the ground; the swing is ground-relative so touchdown has zero skid, and
the pelvis drops only as far as planted legs need. Locomotion clips (Walk, Run, Sprint, Strafes,
Backpedal) are sampled at 60 fps so the short ground contacts interpolate cleanly; all others at 30 fps.
AirBass animates WeaponSocket so the slung rifle rides with the chest. Clip times are rescaled in the
exported GLB to the exact spec durations (shared time accessors are cloned first), then gltfpack runs
with -af 0 so they survive.

Outputs: art/build/agent.raw.glb (Blender export) and public/models/agent.glb (gltfpack).
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402  (shared helpers: AO bake, frames, gltfpack lookup)

ROOT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_RAW = os.path.join(ROOT_DIR, 'art', 'build', 'agent.raw.glb')
OUT_GLB = os.path.join(ROOT_DIR, 'public', 'models', 'agent.glb')
FPS = 30
TRI_BUDGET = 25000
TAU = math.tau

ARGV = sys.argv[1:]
QUICK = '--quick' in ARGV
NOANIM = '--noanim' in ARGV
ONLY_CLIPS = None
if '--clips' in ARGV:
    ONLY_CLIPS = set(ARGV[ARGV.index('--clips') + 1].split(','))

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene
SCENE.render.fps = FPS
COLL = SCENE.collection


# =====================================================================================  math helpers
def V(x, y=None, z=None):
    return Vector((x, y, z)) if y is not None else Vector(x)


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def smoothstep(e0, e1, x):
    if e1 == e0:
        return float(x >= e1)
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3.0 - 2.0 * t)


def sgnpow(v, p):
    return math.copysign(abs(v) ** p, v)


def gauss(x, s):
    return math.exp(-(x / s) ** 2)


def wrap_angle(a):
    return (a + math.pi) % TAU - math.pi


def mirror_x(v):
    return Vector((-v.x, v.y, v.z))


def perp(v, axis):
    """Component of v perpendicular to unit axis, normalized."""
    w = v - axis * v.dot(axis)
    return w.normalized()


def rot(axis, angle):
    return Quaternion(Vector(axis).normalized(), angle)


def smin(a, b, k):
    """Polynomial smooth minimum (k = blend width)."""
    if k <= 0:
        return min(a, b)
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


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


def table(rows):
    """rows of (x, v1, v2, ...) sorted by x -> f(x) returning the tuple (v1, v2, ...)."""
    rows = sorted(rows, key=lambda r: r[0])
    xs = [r[0] for r in rows]
    fs = [pchip(xs, [r[c] for r in rows]) for c in range(1, len(rows[0]))]
    return lambda x: tuple(f(x) for f in fs)


def frame_from(y_axis, z_hint):
    """3x3 rotation whose columns are (X, Y, Z) with Y = y_axis and Z as close to z_hint as possible."""
    y = Vector(y_axis).normalized()
    z = perp(Vector(z_hint), y)
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()


def frame_xyz(x, y, z):
    return Matrix((x, y, z)).transposed()


# =====================================================================================  materials
PALETTE = {  # slot: (sRGB hex, roughness, metallic, emission strength)
    'Suit':     ('#e9e4d5', 0.55, 0.0, 0.0),
    'SuitDark': ('#1a2433', 0.60, 0.05, 0.0),
    'Fabric':   ('#3d4a52', 0.92, 0.0, 0.0),
    'Accent':   ('#f0744e', 0.50, 0.0, 0.0),
    'Visor':    ('#0f3b42', 0.10, 0.35, 0.0),
    'Glow':     ('#8cf0d1', 0.35, 0.0, 2.2),
    'Metal':    ('#5d6b75', 0.35, 0.70, 0.0),
    'Rubber':   ('#14191f', 0.90, 0.0, 0.0),
}
MATS = {}
AO_WEIGHT = {'Glow': 0.0, 'Visor': 0.35}


def make_materials():
    for name, (hex_, rough, metal, emit) in PALETTE.items():
        m = bpy.data.materials.new(name)
        if m.node_tree is None:
            m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        col = C.hex_to_linear(hex_) + (1.0,)
        bsdf.inputs['Base Color'].default_value = col
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
        if emit:
            bsdf.inputs['Emission Color'].default_value = col
            bsdf.inputs['Emission Strength'].default_value = emit
            bsdf.inputs['Base Color'].default_value = tuple(c * 0.3 for c in col[:3]) + (1.0,)
        if name == 'Visor':
            bsdf.inputs['Emission Color'].default_value = C.hex_to_linear('#1d6a6e') + (1.0,)
            bsdf.inputs['Emission Strength'].default_value = 0.25
        m.diffuse_color = col
        m.use_backface_culling = True
        MATS[name] = m


# =====================================================================================  skeleton
# Blender coordinates: +X is the character's left, -Y is forward, +Z up. Feet at z = 0. Meters.
FWD = V(0, -1, 0)
UPV = V(0, 0, 1)

J = {}  # left-side joint positions (rest pose, relaxed A-pose)
J['hip'] = V(0.092, 0.005, 0.950)
J['knee'] = V(0.103, -0.010, 0.505)
J['ankle'] = V(0.108, 0.020, 0.095)
J['ball'] = V(0.118, -0.115, 0.030)
J['toe'] = V(0.121, -0.195, 0.030)
J['clav'] = V(0.030, -0.002, 1.455)
J['shoulder'] = V(0.198, 0.030, 1.462)
D_UA = V(0.70, -0.08, -0.71).normalized()
L_UA = 0.322
J['elbow'] = J['shoulder'] + D_UA * L_UA
D_LA = V(0.66, -0.24, -0.71).normalized()
L_LA = 0.280
J['wrist'] = J['elbow'] + D_LA * L_LA
L_HAND = 0.097
J['knuckle'] = J['wrist'] + D_LA * L_HAND
HIPS_HEAD = V(0, 0.010, 0.985)
SPINE_HEAD = V(0, 0.012, 1.085)
CHEST_HEAD = V(0, 0.008, 1.255)
NECK_HEAD = V(0, 0.022, 1.505)
HEAD_HEAD = V(0, 0.012, 1.618)
HEAD_TAIL = V(0, 0.012, 1.84)


def hand_frame(side):
    """Rest-pose hand axes for side s (+1 left, -1 right): Y along the hand, Z dorsal, k toward the pinky."""
    s = side
    y = D_LA if s > 0 else mirror_x(D_LA)
    hint = V(0.75 * s, -0.2, 0.62)
    z = perp(hint, y)
    x = y.cross(z)
    k = -x * s
    return x, y, z, k


FINGERS = {  # name: (offset toward pinky, knuckle forward offset, spread deg, len1, len2, radius)
    'Index': (-0.033, 0.000, -5.0, 0.046, 0.046, 0.0136),
    'Middle': (-0.011, 0.004, 0.0, 0.049, 0.049, 0.0138),
    'Ring': (0.012, -0.002, 5.0, 0.046, 0.045, 0.0133),
    'Pinky': (0.032, -0.011, 11.0, 0.037, 0.036, 0.0120),
}
REST_CURL = (16.0, 24.0)       # relaxed rest curl (MCP, PIP) in degrees
THUMB = dict(base=(0.020, -0.030, -0.012), dir=(0.62, -0.55, -0.50), len1=0.048, len2=0.042, radius=0.0148)


def finger_chain(side, name):
    """(mcp, pip, tip, y1, z1, y2, z2) for a finger in the rest pose."""
    x, y, z, k = hand_frame(side)
    off, fwd, spread, l1, l2, rad = FINGERS[name]
    w = J['wrist'] if side > 0 else mirror_x(J['wrist'])
    base = w + y * (L_HAND + fwd) + k * off - z * 0.004
    # spread: positive angles fan the finger toward the pinky side (rotation about y x k)
    yd = Quaternion(y.cross(k).normalized(), math.radians(spread)) @ y
    hinge = yd.cross(z).normalized()
    q1 = Quaternion(hinge, -math.radians(REST_CURL[0]))
    y1 = q1 @ yd
    z1 = q1 @ z
    pip = base + y1 * l1
    q2 = Quaternion(hinge, -math.radians(REST_CURL[1]))
    y2 = q2 @ y1
    z2 = q2 @ z1
    tip = pip + y2 * l2
    return base, pip, tip, y1, z1, y2, z2


def thumb_chain(side):
    x, y, z, k = hand_frame(side)
    w = J['wrist'] if side > 0 else mirror_x(J['wrist'])
    b = THUMB['base']
    base = w + y * b[0] + k * b[1] + z * b[2]
    d = (y * THUMB['dir'][0] + k * THUMB['dir'][1] + z * THUMB['dir'][2]).normalized()
    # thumbnail faces away from the palm and toward the index side
    znail = perp(z * 0.55 - k * 0.85, d)
    hinge = d.cross(znail).normalized()
    q = Quaternion(hinge, -math.radians(12.0))
    mid = base + d * THUMB['len1']
    d2 = q @ d
    z2 = q @ znail
    tip = mid + d2 * THUMB['len2']
    return base, mid, tip, d, znail, d2, z2


def bone_defs():
    """name -> (head, tail, z_hint, parent, deform)."""
    B = {}
    B['Root'] = (V(0, 0, 0), V(0, 0, 0.15), FWD, None, False)
    B['Hips'] = (HIPS_HEAD, V(0, 0.012, 1.085), FWD, 'Root', True)
    B['Spine'] = (SPINE_HEAD, CHEST_HEAD, FWD, 'Hips', True)
    B['Chest'] = (CHEST_HEAD, NECK_HEAD, FWD, 'Spine', True)
    B['Neck'] = (NECK_HEAD, HEAD_HEAD, FWD, 'Chest', True)
    B['Head'] = (HEAD_HEAD, HEAD_TAIL, FWD, 'Neck', True)
    for s, sfx in ((1, '_L'), (-1, '_R')):
        m = (lambda v: v) if s > 0 else mirror_x
        B['Shoulder' + sfx] = (m(J['clav']), m(J['shoulder']), UPV, 'Chest', True)
        B['UpperArm' + sfx] = (m(J['shoulder']), m(J['elbow']), FWD, 'Shoulder' + sfx, True)
        B['LowerArm' + sfx] = (m(J['elbow']), m(J['wrist']), FWD, 'UpperArm' + sfx, True)
        hx, hy, hz, hk = hand_frame(s)
        B['Hand' + sfx] = (m(J['wrist']), m(J['knuckle']), hz, 'LowerArm' + sfx, True)
        for fname, bname in (('Index', 'Index'), ('Middle', 'Middle'), ('Ring', 'Ring')):
            base, pip, tip, y1, z1, y2, z2 = finger_chain(s, fname)
            B[bname + '1' + sfx] = (base, pip, z1, 'Hand' + sfx, True)
            B[bname + '2' + sfx] = (pip, tip, z2, bname + '1' + sfx, True)
        base, mid, tip, d, zn, d2, z2 = thumb_chain(s)
        B['Thumb1' + sfx] = (base, mid, zn, 'Hand' + sfx, True)
        B['Thumb2' + sfx] = (mid, tip, z2, 'Thumb1' + sfx, True)
        B['UpperLeg' + sfx] = (m(J['hip']), m(J['knee']), FWD, 'Hips', True)
        B['LowerLeg' + sfx] = (m(J['knee']), m(J['ankle']), FWD, 'UpperLeg' + sfx, True)
        B['Foot' + sfx] = (m(J['ankle']), m(J['ball']), UPV, 'LowerLeg' + sfx, True)
        B['Toe' + sfx] = (m(J['ball']), m(J['toe']), UPV, 'Foot' + sfx, True)
    return B


# =====================================================================================  mesh accumulator
class Part:
    """Accumulates vertices (with bone weights) and faces (with material slots) for one piece."""

    def __init__(self, name, bone=None, smooth=True, sharp=None, bevel=None, harden=True, closed=False):
        self.name = name
        self.closed = closed        # closed solid: orientation is checked by signed volume
        self.bone = bone
        self.co, self.w, self.faces, self.mats = [], [], [], []
        self.smooth = smooth
        self.sharp = sharp          # degrees: mark edges sharper than this (hard-surface)
        self.bevel = bevel          # (width, segments[, angle]) bevel modifier, applied
        self.harden = harden

    def v(self, p, w=None):
        if w is None:
            w = self.bone
        self.co.append(Vector(p))
        self.w.append({} if w is None else {w: 1.0} if isinstance(w, str) else dict(w))
        return len(self.co) - 1

    def f(self, idx, mat):
        idx = list(idx)
        if len(set(idx)) < 3:
            return
        self.faces.append(tuple(idx))
        self.mats.append(mat)

    def grid(self, rows, mat, closed=True, flip=False):
        """Quads between consecutive rows of vertex indices. mat: str or fn(i_row, j_col) -> slot."""
        for i in range(len(rows) - 1):
            r0, r1 = rows[i], rows[i + 1]
            n = len(r0)
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                face = (r0[j], r0[k], r1[k], r1[j])
                if flip:
                    face = face[::-1]
                self.f(face, mat(i, j) if callable(mat) else mat)

    def fan(self, ring, apex, mat, flip=False):
        n = len(ring)
        for j in range(n):
            face = (ring[j], ring[(j + 1) % n], apex)
            self.f(face[::-1] if flip else face, mat)

    def cap(self, ring, mat, flip=False):
        self.f(ring[::-1] if flip else ring, mat)

    def add_rings(self, pts_rows, wfn=None):
        """pts_rows: list of lists of points; wfn(i, j, p) -> weights or None (part bone)."""
        rows = []
        for i, row in enumerate(pts_rows):
            rows.append([self.v(p, wfn(i, j, p) if wfn else None) for j, p in enumerate(row)])
        return rows


PARTS = []


def new_part(*a, **k):
    p = Part(*a, **k)
    PARTS.append(p)
    return p


def signed_volume(part):
    vol = 0.0
    for f in part.faces:
        p0 = part.co[f[0]]
        for i in range(1, len(f) - 1):
            vol += p0.dot(part.co[f[i]].cross(part.co[f[i + 1]]))
    return vol / 6.0


CLOSED_PREFIXES = ('WristPad', 'KneeGuard', 'ShoulderPad', 'Pocket', 'Jaw', 'Knuckles', 'Index', 'Middle', 'Ring', 'Pinky',
                   'Thumb', 'Palm', 'StrapBuckle', 'Buckle', 'ZipPull', 'Flap', 'Pack', 'Thruster', 'Sole', 'Strap',
                   'PullTab', 'Antenna', 'Visor', 'Headband', 'Collar', 'Rifle_body', 'Rifle_stock', 'Rifle_shroud',
                   'Rifle_grip', 'Rifle_foregrip', 'Rifle_sight', 'Rifle_cell', 'Rifle_cradle', 'Rifle_stripes')


def build_object(part):
    """Create a Blender mesh object from a Part (vertex groups, materials, smoothing, bevel)."""
    if part.name.startswith(CLOSED_PREFIXES):
        part.closed = True
    if part.closed:
        cen = sum(part.co, Vector()) / max(1, len(part.co))
        vol = 0.0
        for f in part.faces:
            p0 = part.co[f[0]] - cen
            for i in range(1, len(f) - 1):
                vol += p0.dot((part.co[f[i]] - cen).cross(part.co[f[i + 1]] - cen))
        if vol < 0:
            part.faces = [fc[::-1] for fc in part.faces]
            print('   (flipped %s)' % part.name)
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in part.co]
    slots = list(dict.fromkeys(part.mats))
    for face, mat in zip(part.faces, part.mats):
        try:
            f = bm.faces.new([verts[i] for i in face])
        except ValueError:
            continue
        f.material_index = slots.index(mat)
        f.smooth = part.smooth
    me = bpy.data.meshes.new(part.name)
    bm.to_mesh(me)
    bm.free()
    for s in slots:
        me.materials.append(MATS[s])
    ob = bpy.data.objects.new(part.name, me)
    COLL.objects.link(ob)
    # vertex groups (limit 4, normalize)
    groups = {}
    for i, w in enumerate(part.w):
        items = sorted(((b, x) for b, x in w.items() if x > 1e-4), key=lambda t: -t[1])[:4]
        tot = sum(x for _, x in items) or 1.0
        for b, x in items:
            if b not in groups:
                groups[b] = ob.vertex_groups.new(name=b)
            groups[b].add([i], x / tot, 'REPLACE')
    if part.smooth:
        me.shade_smooth()
        if part.sharp is not None:
            me.set_sharp_from_angle(angle=math.radians(part.sharp))
    else:
        me.shade_flat()
    if part.bevel:
        width, seg = part.bevel[0], part.bevel[1]
        ang = part.bevel[2] if len(part.bevel) > 2 else (part.sharp or 35)
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = width
        m.segments = seg
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(ang)
        m.profile = 0.5
        m.use_clamp_overlap = True
        m.harden_normals = part.harden
        m.miter_outer = 'MITER_ARC' if seg > 1 else 'MITER_SHARP'
        C.apply_modifiers(ob)
    return ob


# =====================================================================================  weight helpers
def wsum(*pairs):
    out = {}
    for w, k in pairs:
        if k <= 0:
            continue
        for b, x in w.items():
            out[b] = out.get(b, 0.0) + x * k
    return out


def seg_t(p, a, b):
    ab = b - a
    return clamp((p - a).dot(ab) / ab.length_squared)


def SX(name, s):
    return name + ('_L' if s > 0 else '_R')


# =====================================================================================  jacket torso
# z: half-width W, front depth F, back depth B, front exponent, back exponent, y-centre
TORSO = table([
    (1.030, 0.168, 0.112, 0.110, 2.4, 2.3),
    (1.060, 0.161, 0.110, 0.104, 2.4, 2.3),
    (1.120, 0.155, 0.108, 0.098, 2.4, 2.3),
    (1.180, 0.162, 0.112, 0.100, 2.5, 2.3),
    (1.240, 0.176, 0.120, 0.106, 2.6, 2.3),
    (1.300, 0.193, 0.130, 0.113, 2.7, 2.35),
    (1.360, 0.208, 0.143, 0.120, 2.8, 2.4),
    (1.410, 0.218, 0.138, 0.124, 2.8, 2.4),
    (1.450, 0.223, 0.123, 0.123, 2.7, 2.4),
    (1.475, 0.215, 0.108, 0.115, 2.5, 2.4),
    (1.495, 0.193, 0.093, 0.103, 2.4, 2.3),
    (1.512, 0.156, 0.080, 0.092, 2.3, 2.2),
    (1.527, 0.122, 0.070, 0.080, 2.2, 2.2),
    (1.540, 0.094, 0.062, 0.070, 2.1, 2.1),
    (1.552, 0.076, 0.056, 0.064, 2.0, 2.0),
])
TORSO_Z = [1.030, 1.060, 1.10, 1.15, 1.20, 1.245, 1.275, 1.283, 1.288, 1.293, 1.305, 1.34, 1.375,
           1.41, 1.436, 1.445, 1.454, 1.470, 1.488, 1.503, 1.517, 1.530, 1.542, 1.552]
TORSO_N = 44


def hem_shift(z, th):
    """Curved hem: the front rides higher, the back drops lower (fades out above the waist)."""
    return (0.016 * math.cos(th) - 0.006) * (1.0 - smoothstep(1.03, 1.13, z))


def torso_point(z, th, extra=0.0):
    """Point on the jacket surface at height z and angle th (0 = front, +pi/2 = left side)."""
    zr = z
    z = z + hem_shift(z, th)
    W, F, B, ef, eb = TORSO(zr)
    s, c = math.sin(th), math.cos(th)
    e = ef if c >= 0 else eb
    x = W * sgnpow(s, 2.0 / e)
    y = -(F if c >= 0 else B) * sgnpow(c, 2.0 / e)
    # anatomy: pecs, shoulder blades (radial bulges)
    k = 1.0
    if c > 0:
        for sx in (1, -1):
            k += 0.055 * gauss(wrap_angle(th - sx * 0.47), 0.30) * gauss(z - 1.355, 0.065) * c
    else:
        for sx in (1, -1):
            k += 0.04 * gauss(wrap_angle(th - (math.pi - sx * 0.62)), 0.32) * gauss(z - 1.385, 0.075)
    # seams: grooves read as panel lines in the stylized shading
    if c > 0:
        k -= 0.022 * gauss(z - 1.288, 0.0045) * smoothstep(0.05, 0.4, c)          # under-chest seam
        for sx in (1, -1):
            col = sx * TAU * 5 / TORSO_N
            k -= 0.020 * gauss(wrap_angle(th - col), 0.02) * smoothstep(1.295, 1.27, z) * smoothstep(1.035, 1.06, z)
    else:
        k -= 0.018 * gauss(z - 1.445, 0.0045) * smoothstep(0.1, 0.5, -c)          # back yoke seam
    p = V(x * k, y * k, z)
    if extra:
        p += V(x, y, 0).normalized() * extra if (x or y) else V(0, 0, 0)
    return p


def jacket_weights(p):
    """Smooth torso weights: Hips -> Spine -> Chest, shoulder and arm influence near the armholes."""
    z = p.z
    a = smoothstep(1.04, 1.17, z)      # Hips -> Spine
    b = smoothstep(1.21, 1.34, z)      # Spine -> Chest
    w = {'Hips': 1 - a, 'Spine': a * (1 - b), 'Chest': a * b}
    s = 1 if p.x >= 0 else -1
    ax = abs(p.x)
    # clavicle region: lateral upper torso follows the shoulder bone
    sh = smoothstep(0.09, 0.17, ax) * smoothstep(1.38, 1.47, z)
    # armhole: follow the upper arm a little
    S = J['shoulder'] if s > 0 else mirror_x(J['shoulder'])
    d = (p - S).length
    ua = 0.45 * smoothstep(0.13, 0.04, d) * smoothstep(0.15, 0.20, ax)
    base = 1.0 - sh * 0.75 - ua
    out = {k: v * base for k, v in w.items()}
    out[SX('Shoulder', s)] = out.get(SX('Shoulder', s), 0) + sh * 0.75
    out[SX('UpperArm', s)] = out.get(SX('UpperArm', s), 0) + ua
    return out


SIDE_PANEL = (0.30, 0.20)   # coral side panel half-angle span around +-pi/2 (front, back of the side)


def jacket_mat(i, j, n=TORSO_N, zs=TORSO_Z):
    th = TAU * (j + 0.5) / n
    z = 0.5 * (zs[i] + zs[i + 1]) if i + 1 < len(zs) else zs[i]
    for sx in (1, -1):
        rel = wrap_angle(th - sx * math.pi / 2) * sx   # >0 toward the back
        if -SIDE_PANEL[0] < rel < SIDE_PANEL[1] and z < 1.395:
            return 'Accent'
    return 'Suit'


def build_jacket():
    part = new_part('Jacket')
    n = TORSO_N
    pts = []
    zs = TORSO_Z
    for z in zs:
        pts.append([torso_point(z, TAU * j / n) for j in range(n)])
    # rolled hem: inside lip and bottom roll under the first ring
    hem_in = [torso_point(1.050, TAU * j / n, -0.010) for j in range(n)]
    hem_bot = [torso_point(1.023, TAU * j / n, -0.004) for j in range(n)]
    rows = part.add_rings([hem_in, hem_bot] + pts, lambda i, j, p: jacket_weights(p))
    zs_all = [1.05, 1.024] + zs

    def mat(i, j):
        if i < 2:
            return 'Accent' if i == 0 else 'Suit'
        return jacket_mat(i - 2, j)
    part.grid(rows, mat)
    return part


# =====================================================================================  storm flap, belt
def build_flap():
    """Raised storm flap down the front, offset to the right of centre (character's right = -X)."""
    part = new_part('Flap', sharp=50)
    th0, th1 = -0.215, -0.11
    zs = [1.034, 1.07, 1.12, 1.18, 1.24, 1.30, 1.36, 1.41, 1.45, 1.48, 1.505, 1.522]
    cols = 3
    outer, inner = [], []
    for z in zs:
        ro, ri = [], []
        for c in range(cols):
            th = lerp(th0, th1, c / (cols - 1))
            edge = 1.0 if c in (0, cols - 1) else 0.0
            ro.append(torso_point(z, th, 0.0062 - 0.0022 * edge))
            ri.append(torso_point(z, th, -0.004))
        outer.append(ro)
        inner.append(ri)
    wf = lambda i, j, p: jacket_weights(p)
    ro_rows = part.add_rings(outer, wf)
    ri_rows = part.add_rings(inner, wf)
    part.grid(ro_rows, 'Suit', closed=False)
    # side walls
    for i in range(len(zs) - 1):
        part.f((ri_rows[i][0], ro_rows[i][0], ro_rows[i + 1][0], ri_rows[i + 1][0]), 'Suit')
        part.f((ro_rows[i][-1], ri_rows[i][-1], ri_rows[i + 1][-1], ro_rows[i + 1][-1]), 'Suit')
    # bottom and top ends
    part.f([ri_rows[0][c] for c in range(cols)] + [ro_rows[0][c] for c in reversed(range(cols))], 'Suit')
    part.f([ro_rows[-1][c] for c in range(cols)] + [ri_rows[-1][c] for c in reversed(range(cols))], 'Suit')
    # zipper pull at the top
    zp = new_part('ZipPull', bone='Chest', sharp=40, bevel=(0.0015, 1))
    top = torso_point(1.50, 0.5 * (th0 + th1), 0.009)
    add_box(zp, top + V(0, 0, -0.012), V(0.012, 0.006, 0.026), 'Metal')
    return part


def add_box(part, c, size, mat, axes=None, w=None):
    """Axis-aligned (or oriented by 3x3 `axes`) box centred at c with full size `size`."""
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    R = axes if axes is not None else Matrix.Identity(3)
    idx = []
    for z in (-sz, sz):
        for (x, y) in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
            idx.append(part.v(c + R @ V(x, y, z), w))
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        part.f([idx[i] for i in f], mat)
    return idx


def add_tube(part, points, radii, sides, mat, up=None, cap0=True, cap1=True, w=None, phase=0.0,
             radial=None, mat_fn=None):
    """Swept tube (outward faces) through `points`; radii number or (rx, ry). Returns ring indices."""
    tans, nor, bin_ = C.frames([Vector(p) for p in points], up)
    rows = []
    for i, p in enumerate(points):
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        rx, ry = (r, r) if not isinstance(r, (list, tuple)) else r
        row = []
        for j in range(sides):
            a = phase + TAU * j / sides
            k = radial(i, j, a) if radial else 1.0
            q = Vector(p) + (nor[i] * (math.cos(a) * rx) + bin_[i] * (math.sin(a) * ry)) * k
            row.append(part.v(q, w(i, j, q) if callable(w) else w))
        rows.append(row)
    part.grid(rows, mat_fn or mat)
    if cap0:
        part.cap(rows[0], mat, flip=True)
    if cap1:
        part.cap(rows[-1], mat)
    return rows


def add_lathe(part, center, axis, profile, sides, mats, up=None, w=None, phase=0.0):
    """Revolve profile [(r, h), ...] about `axis` through `center`. mats: one slot or per segment list.
    List the profile so that it walks up the outside (faces point outward). r == 0 makes a pole."""
    ax = Vector(axis).normalized()
    u = perp(Vector(up) if up is not None else (V(0, 0, 1) if abs(ax.z) < 0.9 else V(1, 0, 0)), ax)
    v_ = ax.cross(u)
    c = Vector(center)
    rows = []
    for (r, h) in profile:
        if r <= 1e-9:
            rows.append([part.v(c + ax * h, w)])
            continue
        row = []
        for j in range(sides):
            a = phase + TAU * j / sides
            row.append(part.v(c + ax * h + (u * math.cos(a) + v_ * math.sin(a)) * r, w))
        rows.append(row)
    for i in range(len(rows) - 1):
        m = mats[i] if isinstance(mats, (list, tuple)) else mats
        r0, r1 = rows[i], rows[i + 1]
        if len(r0) == 1 and len(r1) == 1:
            continue
        if len(r0) == 1:
            for j in range(sides):
                part.f((r1[(j + 1) % sides], r1[j], r0[0]), m)
        elif len(r1) == 1:
            for j in range(sides):
                part.f((r0[j], r0[(j + 1) % sides], r1[0]), m)
        else:
            for j in range(sides):
                k = (j + 1) % sides
                part.f((r0[j], r0[k], r1[k], r1[j]), m)
    return rows


def build_belt():
    part = new_part('Belt', bone='Hips', sharp=45, bevel=(0.003, 1, 45))
    n = 36
    rows_pts = []
    for z, ext in ((0.982, 0.003), (0.986, 0.0068), (1.022, 0.0068), (1.026, 0.003)):
        rows_pts.append([pelvis_point(z, TAU * j / n, ext) for j in range(n)])
    rows = part.add_rings(rows_pts)
    part.grid(rows, 'Fabric')
    # buckle (front, slightly left of centre so the flap does not cover it)
    bk = new_part('Buckle', bone='Hips', sharp=40, bevel=(0.002, 1))
    c = pelvis_point(1.004, 0.0, 0.010)
    add_box(bk, c, V(0.056, 0.012, 0.040), 'Metal')
    add_box(bk, c + V(0, -0.0065, 0), V(0.034, 0.004, 0.020), 'SuitDark')
    return part


# =====================================================================================  pants
PELVIS = table([  # z: W, F, B (left half D-shape, pants surface)
    (1.130, 0.140, 0.092, 0.090),
    (1.080, 0.146, 0.095, 0.094),
    (1.040, 0.153, 0.098, 0.100),
    (1.000, 0.163, 0.101, 0.110),
    (0.960, 0.173, 0.103, 0.121),
    (0.925, 0.178, 0.102, 0.128),
    (0.895, 0.177, 0.099, 0.127),
    (0.875, 0.175, 0.096, 0.122),
])
LEG = table([  # z: rx, ry, cx extra, cy extra (relative to the bone axis)
    (0.875, 0.090, 0.093, 0.004, 0.006),
    (0.850, 0.093, 0.097, 0.004, 0.004),
    (0.820, 0.094, 0.098, 0.004, 0.000),
    (0.780, 0.093, 0.096, 0.003, -0.004),
    (0.720, 0.090, 0.093, 0.002, -0.006),
    (0.660, 0.086, 0.089, 0.001, -0.006),
    (0.610, 0.080, 0.083, 0.000, -0.005),
    (0.565, 0.074, 0.077, 0.000, -0.004),
    (0.530, 0.070, 0.072, 0.000, -0.002),
    (0.505, 0.068, 0.070, 0.000, 0.000),
    (0.475, 0.068, 0.071, 0.000, 0.003),
    (0.440, 0.068, 0.072, 0.000, 0.007),
    (0.400, 0.071, 0.076, 0.000, 0.010),
    (0.360, 0.070, 0.075, 0.000, 0.011),
    (0.320, 0.066, 0.070, 0.000, 0.009),
    (0.280, 0.062, 0.065, 0.000, 0.006),
    (0.240, 0.058, 0.060, 0.000, 0.004),
    (0.200, 0.054, 0.055, 0.000, 0.002),
    (0.160, 0.051, 0.052, 0.000, 0.001),
])
PANTS_Z = [1.130, 1.080, 1.040, 1.000, 0.960, 0.925, 0.895, 0.875, 0.850, 0.820, 0.780, 0.720, 0.660,
           0.610, 0.565, 0.530, 0.505, 0.475, 0.440, 0.400, 0.360, 0.320, 0.280, 0.240, 0.200, 0.160]
CROTCH_Z = 0.875


def leg_axis(z, s=1):
    """Point on the (rest) leg bone line at height z."""
    hip, knee, ank = J['hip'], J['knee'], J['ankle']
    if z >= knee.z:
        t = (hip.z - z) / (hip.z - knee.z)
        p = hip.lerp(knee, t)
    else:
        t = (knee.z - z) / (knee.z - ank.z)
        p = knee.lerp(ank, t)
    return p if s > 0 else mirror_x(p)


def pelvis_point(z, th, ext=0.0):
    """Full pelvis cross-section (both halves), used for the belt."""
    W, F, B = PELVIS(z)
    s, c = math.sin(th), math.cos(th)
    e = 2.4
    x = W * sgnpow(s, 2 / e)
    y = -(F if c >= 0 else B) * sgnpow(c, 2 / e)
    d = V(x, y, 0)
    return V(x, y, z) + (d.normalized() * ext if d.length > 1e-9 else V(0, 0, 0))


def pants_ring(z):
    """24 points of the left pants half at height z (D-shape above the crotch, round below)."""
    n_half = 12
    morph = 1.0 - smoothstep(0.790, CROTCH_Z, z)
    morph = smoothstep(0.0, 1.0, morph)
    pts = []
    if z >= CROTCH_Z - 1e-6:
        W, F, B = PELVIS(z)
    else:
        W, F, B = PELVIS(CROTCH_Z)
    zc = min(z, 0.875)
    rx, ry, cxe, cye = LEG(min(z, 0.875))
    a = leg_axis(z)
    cx, cy = a.x + cxe, a.y + cye
    for k in range(24):
        th = math.pi * k / n_half
        # D shape
        if k <= n_half:
            s, c = math.sin(th), math.cos(th)
            dx = W * sgnpow(s, 2 / 2.4)
            dy = -(F if c >= 0 else B) * sgnpow(c, 2 / 2.4)
        else:
            u = (k - n_half) / n_half
            u = 0.5 - 0.5 * math.cos(math.pi * u)
            dx = 0.0
            dy = lerp(B, -F, u)
        # round leg
        lx = cx + rx * math.sin(th)
        ly = cy - ry * math.cos(th)
        pts.append(V(lerp(dx, lx, morph), lerp(dy, ly, morph), z))
    return pts


def pants_weights(p):
    s = 1 if p.x >= 0 else -1
    ax = abs(p.x)
    z = p.z
    # direction around the leg: front / side / back changes the hip blend height
    a = leg_axis(z, s)
    dirv = V(p.x - a.x, p.y - a.y, 0)
    back = clamp(dirv.y / max(dirv.length, 1e-6) * 0.5 + 0.5)       # 0 front .. 1 back
    lo = lerp(0.865, 0.815, back)
    hi = lerp(0.955, 0.995, back)
    h = smoothstep(lo, hi, z)                                         # 1 = Hips
    kz = J['knee'].z
    k_front = smoothstep(kz + 0.085, kz + 0.020, z)
    k_back = smoothstep(kz + 0.040, kz - 0.035, z)
    k = lerp(k_front, k_back, smoothstep(0.25, 0.75, back))          # 1 = LowerLeg
    leg = 1.0 - h
    share = 0.5 * (1.0 - smoothstep(0.0, 0.035, ax)) if z < 0.97 else 0.0
    w = {'Hips': h}
    w[SX('UpperLeg', s)] = leg * (1 - k) * (1 - share)
    w[SX('UpperLeg', -s)] = leg * (1 - k) * share
    w[SX('LowerLeg', s)] = leg * k
    return w


def build_pants():
    """Both legs as one continuous mesh: left half built, mirrored, merged along x = 0."""
    bm = bmesh.new()
    rows = []
    for z in PANTS_Z:
        rows.append([bm.verts.new(p) for p in pants_ring(z)])
    n = 24
    for i in range(len(rows) - 1):
        for j in range(n):
            k = (j + 1) % n
            # ring runs front -> lateral -> back -> medial: faces (r1 above r0?) rows go downward
            bm.faces.new((rows[i + 1][j], rows[i + 1][k], rows[i][k], rows[i][j]))
    # mirror
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    ret = bmesh.ops.duplicate(bm, geom=geom)
    dverts = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
    for v in dverts:
        v.co.x = -v.co.x
    dfaces = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]
    bmesh.ops.reverse_faces(bm, faces=dfaces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    # delete interior faces on the x = 0 plane
    doomed = [f for f in bm.faces if all(abs(v.co.x) < 1e-5 for v in f.verts)]
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # make sure normals point outward (check a lateral thigh face)
    part = new_part('Pants')
    vid = {}
    for v in bm.verts:
        vid[v.index] = part.v(v.co.copy(), pants_weights(v.co))
    bm.verts.ensure_lookup_table()
    for f in bm.faces:
        c = f.calc_center_median()
        a = leg_axis(c.z, 1 if c.x >= 0 else -1)
        ang = math.atan2(abs(c.x) - abs(a.x), -(c.y - a.y))      # 0 = front, pi/2 = lateral
        stripe = 0.25 < c.z < 0.86 and abs(ang - math.pi / 2) < 0.20
        part.f([vid[v.index] for v in f.verts], 'Fabric' if stripe else 'SuitDark')
    # orientation check: face whose centre is most +x should have normal +x
    best = max(bm.faces, key=lambda f: f.calc_center_median().x)
    if best.normal.x < 0:
        part.faces = [fc[::-1] for fc in part.faces]
    bm.free()
    return part


def build_pockets():
    """Cargo pockets on the outer thighs (rigid to the thigh)."""
    for s in (1, -1):
        part = new_part(SX('Pocket', s), bone=SX('UpperLeg', s), sharp=40, bevel=(0.004, 2, 40))
        zs = [0.615, 0.64, 0.70, 0.76, 0.785]
        ths = [0.95, 1.20, 1.45, 1.70, 1.95]   # around the leg, 0 = front, + = lateral
        outer = []
        for zi, z in enumerate(zs):
            ro = []
            rx, ry, cxe, cye = LEG(z)
            a = leg_axis(z, s)
            for ti, th in enumerate(ths):
                edge = (zi in (0, len(zs) - 1)) or (ti in (0, len(ths) - 1))
                bulge = 0.0 if edge else 0.012
                base = V(a.x + s * (cxe + rx * math.sin(th)), a.y + cye - ry * math.cos(th), z)
                nrm = V(s * math.sin(th) * ry, -math.cos(th) * rx, 0).normalized()
                ro.append(base + nrm * (0.010 + bulge))
            outer.append(ro)
        add_shell(part, outer, 0.016, 'SuitDark', flip=s < 0)
        # flap across the top of the pocket
        fl = new_part(SX('PocketFlap', s), bone=SX('UpperLeg', s), sharp=40, bevel=(0.003, 1, 40))
        zf = [0.738, 0.792]
        rowsf = []
        for z in zf:
            rx, ry, cxe, cye = LEG(z)
            a = leg_axis(z, s)
            row = []
            for th in [0.90, 1.18, 1.45, 1.72, 2.00]:
                base = V(a.x + s * (cxe + rx * math.sin(th)), a.y + cye - ry * math.cos(th), z)
                nrm = V(s * math.sin(th) * ry, -math.cos(th) * rx, 0).normalized()
                row.append(base + nrm * (0.026 if z < 0.75 else 0.012))
            rowsf.append(row)
        add_shell(fl, rowsf, 0.006, 'SuitDark', flip=s < 0)


def add_shell(part, rows_pts, thick, mat, flip=False, inner_mat=None, wfn=None):
    """Thicken an open grid of points (rows x cols) inward along its normals into a closed slab."""
    nr, nc = len(rows_pts), len(rows_pts[0])
    # approximate normals from the grid
    nrm = [[None] * nc for _ in range(nr)]
    for i in range(nr):
        for j in range(nc):
            a = rows_pts[min(i + 1, nr - 1)][j] - rows_pts[max(i - 1, 0)][j]
            b = rows_pts[i][min(j + 1, nc - 1)] - rows_pts[i][max(j - 1, 0)]
            n = b.cross(a)
            if flip:
                n = -n
            nrm[i][j] = n.normalized()
    outer = [[part.v(rows_pts[i][j], wfn(rows_pts[i][j]) if wfn else None) for j in range(nc)] for i in range(nr)]
    inner = [[part.v(rows_pts[i][j] - nrm[i][j] * thick, wfn(rows_pts[i][j]) if wfn else None) for j in range(nc)]
             for i in range(nr)]
    im = inner_mat or mat
    for i in range(nr - 1):
        for j in range(nc - 1):
            fo = (outer[i][j], outer[i][j + 1], outer[i + 1][j + 1], outer[i + 1][j])
            fi = (inner[i][j], inner[i + 1][j], inner[i + 1][j + 1], inner[i][j + 1])
            if flip:
                fo, fi = fo[::-1], fi[::-1]
            part.f(fo, mat)
            part.f(fi, im)
    # rim
    ring_o = [outer[0][j] for j in range(nc)] + [outer[i][nc - 1] for i in range(1, nr)] + \
             [outer[nr - 1][j] for j in reversed(range(nc - 1))] + [outer[i][0] for i in reversed(range(1, nr - 1))]
    ring_i = [inner[0][j] for j in range(nc)] + [inner[i][nc - 1] for i in range(1, nr)] + \
             [inner[nr - 1][j] for j in reversed(range(nc - 1))] + [inner[i][0] for i in reversed(range(1, nr - 1))]
    m = len(ring_o)
    for j in range(m):
        k = (j + 1) % m
        face = (ring_o[j], ring_i[j], ring_i[k], ring_o[k])
        part.f(face if not flip else face[::-1], mat)
    return outer, inner


# =====================================================================================  knee guards
def build_knee_guards():
    for s in (1, -1):
        part = new_part(SX('KneeGuard', s), bone=SX('LowerLeg', s), sharp=38, bevel=(0.0035, 1, 38))
        zs = [0.435, 0.452, 0.475, 0.50, 0.525, 0.552, 0.575, 0.588]
        nc = 9
        rows = []
        for z in zs:
            u = (z - 0.511) / 0.078          # -1 .. 1 roughly
            half = 1.12 * math.sqrt(max(0.0, 1.0 - min(1.0, abs(u)) ** 3)) + 0.12
            if z < 0.44:
                half *= 0.72                 # tapered bottom
            rx, ry, cxe, cye = LEG(z)
            a = leg_axis(z, s)
            row = []
            for c in range(nc):
                th = lerp(-half, half, c / (nc - 1))
                ridge = 0.008 * gauss(th, 0.30) * (1 - abs(u) * 0.5)
                off = 0.0125 + ridge + 0.004 * (1 - u * u)
                base = V(a.x + s * (cxe + rx * math.sin(th)), a.y + cye - ry * math.cos(th), z)
                nrm = V(s * math.sin(th) * ry, -math.cos(th) * rx, 0).normalized()
                row.append(base + nrm * off)
            rows.append(row)
        add_shell(part, rows, 0.0105, 'Suit', flip=s < 0)
        # strap behind the knee
        st = new_part(SX('KneeStrap', s), bone=SX('LowerLeg', s))
        n = 16
        ring = []
        for z, ext in ((0.468, 0.004), (0.474, 0.0075), (0.498, 0.0075), (0.504, 0.004)):
            rx, ry, cxe, cye = LEG(z)
            a = leg_axis(z, s)
            r = []
            for j in range(n):
                th = TAU * j / n
                r.append(V(a.x + s * (cxe + (rx + ext) * math.sin(th)), a.y + cye - (ry + ext) * math.cos(th), z))
            ring.append(r)
        rws = st.add_rings(ring)
        st.grid(rws, 'SuitDark', flip=(s < 0))


# =====================================================================================  sleeves, cuffs, pads
SLEEVE = [  # u along the arm from the shoulder joint (upper arm then forearm): radius (r_a, r_b)
    (-0.062, 0.030, 0.030),
    (-0.050, 0.050, 0.050),
    (-0.030, 0.066, 0.064),
    (-0.008, 0.080, 0.075),
    (0.030, 0.078, 0.072),
    (0.080, 0.070, 0.066),
    (0.105, 0.0675, 0.064),
    (0.150, 0.0645, 0.0615),
    (0.200, 0.061, 0.058),
    (0.255, 0.058, 0.056),
    (0.295, 0.057, 0.055),
    (0.330, 0.058, 0.056),
    (0.370, 0.060, 0.056),
    (0.420, 0.057, 0.053),
    (0.475, 0.052, 0.049),
    (0.525, 0.047, 0.045),
    (0.560, 0.044, 0.043),
]
CUFF_U = (0.535, 0.585)


def arm_point(u, s):
    S = J['shoulder'] if s > 0 else mirror_x(J['shoulder'])
    E = J['elbow'] if s > 0 else mirror_x(J['elbow'])
    dua = D_UA if s > 0 else mirror_x(D_UA)
    dla = D_LA if s > 0 else mirror_x(D_LA)
    if u <= L_UA:
        return S + dua * u
    return E + dla * (u - L_UA)


def sleeve_weights(u, s, p):
    sh = 0.35 * smoothstep(0.03, -0.055, u)
    ch = 0.15 * smoothstep(-0.01, -0.06, u)
    la = smoothstep(L_UA - 0.05, L_UA + 0.045, u)
    w = {SX('UpperArm', s): (1 - la) * (1 - sh - ch), SX('LowerArm', s): la * (1 - sh - ch)}
    if sh:
        w[SX('Shoulder', s)] = sh
    if ch:
        w['Chest'] = ch
    return w


def build_sleeves():
    for s in (1, -1):
        part = new_part(SX('Sleeve', s))
        us = [r[0] for r in SLEEVE]
        pts = [arm_point(u, s) for u in us]
        radii = [(r[1] * (1.08 if r[0] > 0.0 else 1.0), r[2] * (1.08 if r[0] > 0.0 else 1.0)) for r in SLEEVE]
        cap_tip = arm_point(-0.072, s)
        band = (0.105, 0.150) if s > 0 else (-1, -1)
        smat = lambda i, j: 'Accent' if band[0] <= 0.5 * (us[i] + us[i + 1]) <= band[1] else 'Suit'
        us = [r[0] for r in SLEEVE]
        rows = add_tube(part, pts, radii, 18, 'Suit', up=V(0, -1, 0), cap0=False, cap1=False,
                        w=lambda i, j, q: sleeve_weights(us[i], s, q), phase=0.0, mat_fn=smat)
        apex = part.v(cap_tip, sleeve_weights(-0.072, s, cap_tip))
        part.fan(rows[0], apex, 'Suit', flip=True)
        # cuff: rigid ring around the sleeve end
        cf = new_part(SX('Cuff', s), bone=SX('LowerArm', s), sharp=40, bevel=(0.003, 1, 40))
        u0, u1 = CUFF_U
        prof = [(0.046, u0 + 0.002), (0.055, u0), (0.059, u0 + 0.008), (0.059, u1 - 0.010),
                (0.055, u1), (0.048, u1 + 0.002), (0.046, u1 - 0.008)]
        E = arm_point(L_UA, s)
        dla = D_LA if s > 0 else mirror_x(D_LA)
        mats = ['Suit', 'Suit', 'Suit', 'Suit', 'Accent', 'Accent']
        add_lathe(cf, E, dla, [(r, h - L_UA) for r, h in prof], 16, mats, up=V(0, -1, 0))
        if s > 0:
            # wrist computer: navy housing with a glowing screen on top of the left forearm
            wc = new_part('WristPad', bone='LowerArm_L', sharp=40, bevel=(0.0025, 1, 40))
            uc = L_UA + 0.175
            c = arm_point(uc, s)
            t = D_LA
            up = perp(V(0.55, -0.15, 1.0), t)          # top of the forearm
            side = t.cross(up)
            R = frame_xyz(side, t, up)
            r_here = pchip([r[0] for r in SLEEVE], [r[1] for r in SLEEVE])(uc) * 1.08
            base = c + up * (r_here + 0.004)
            add_box(wc, base + up * 0.006, V(0.046, 0.066, 0.014), 'SuitDark', axes=R)
            add_box(wc, base + up * 0.0135 - t * 0.004, V(0.028, 0.040, 0.002), 'Glow', axes=R)
            add_box(wc, base + up * 0.0125 + t * 0.026, V(0.030, 0.005, 0.004), 'Accent', axes=R)
        # deltoid pad (rigid to the upper arm)
        pad = new_part(SX('ShoulderPad', s), bone=SX('UpperArm', s), sharp=14, bevel=(0.0030, 1, 14))
        tans, nor, bin_ = C.frames([arm_point(u, s) for u in (-0.06, 0.0, 0.06, 0.12)], V(0, -1, 0))
        rowsp = []
        pus = [-0.040, -0.018, 0.020, 0.058, 0.088]
        for ui, u in enumerate(pus):
            c = arm_point(u, s)
            ra = max(0.072, pchip([r[0] for r in SLEEVE], [r[1] for r in SLEEVE])(u) * (1.08 if u > 0 else 1.0))
            row = []
            t = (arm_point(u + 0.01, s) - arm_point(u - 0.01, s)).normalized()
            outv = perp(V(s * 0.62, 0.0, 1.0), t)     # pad centred on the top-outer side of the arm
            side = t.cross(outv)
            span = 0.95 if 0 < ui < len(pus) - 1 else 0.82
            flare = 0.006 * (ui / (len(pus) - 1))
            for ci, a in enumerate((-span, -span * 0.45, 0.0, span * 0.45, span)):
                d = (outv * math.cos(a) + side * math.sin(a)).normalized()
                ridge = 0.010 if ci == 2 else 0.004 if ci in (1, 3) else 0.0
                row.append(c + d * (ra + 0.008 + ridge + flare))
            rowsp.append(row)
        add_shell(pad, rowsp, 0.010, 'SuitDark', flip=False)


# =====================================================================================  neck, collar
def build_neck():
    part = new_part('NeckGaiter')
    zs = [1.47, 1.51, 1.55, 1.59, 1.625, 1.66, 1.69]
    radii = [(0.080, 0.074), (0.076, 0.070), (0.072, 0.067), (0.070, 0.066), (0.071, 0.067), (0.073, 0.069), (0.074, 0.070)]

    def nw(z):
        a = smoothstep(1.50, 1.56, z)
        b = smoothstep(1.60, 1.66, z)
        return {'Chest': 1 - a, 'Neck': a * (1 - b), 'Head': a * b}
    rows = []
    for z, (rx, ry) in zip(zs, radii):
        yc = lerp(0.020, 0.012, smoothstep(1.47, 1.69, z))
        rows.append([V(rx * math.sin(TAU * j / 16), yc - ry * math.cos(TAU * j / 16), z) for j in range(16)])
    rr = part.add_rings(rows, lambda i, j, p: nw(p.z))
    part.grid(rr, 'Fabric')
    return part


def build_collar():
    """Tall asymmetric stand collar: higher on the left, open at the front-right, coral lining."""
    part = new_part('Collar', sharp=60)
    th0, th1 = 0.04, TAU - 0.78          # wraps from front-left, around the back, to the front-right
    nc = 32
    z0 = 1.505

    def top(th):
        # diagonal cut: tallest at the front-left, sweeping down around the back to the right side
        u = ((th - th0) % TAU) / ((th1 - th0) % TAU)      # 0 at the left edge .. 1 at the right edge
        zt = lerp(1.640, 1.572, smoothstep(0.0, 1.0, u) ** 0.8)
        e0 = smoothstep(0.0, 0.12, u)
        e1 = smoothstep(0.0, 0.10, 1 - u)
        return z0 + (zt - z0) * (0.62 + 0.38 * min(e0 ** 0.5, e1))

    def ring_pt(th, z, inset):
        t = clamp((z - z0) / 0.13) ** 1.6
        rx = lerp(0.100, 0.126, t) - inset
        ryf = lerp(0.084, 0.110, t) - inset
        ryb = lerp(0.090, 0.116, t) - inset
        s, c = math.sin(th), math.cos(th)
        y = -(ryf if c >= 0 else ryb) * c + lerp(0.012, 0.010, t)
        return V(rx * s, y, z)

    def cw(p):
        a = smoothstep(1.52, 1.61, p.z)
        return {'Chest': 1 - 0.35 * a, 'Neck': 0.35 * a}
    ths = [lerp(th0, th1, i / (nc - 1)) for i in range(nc)]
    outer_b = [ring_pt(th, z0, 0) for th in ths]
    outer_t = [ring_pt(th, top(th), 0) for th in ths]
    lip = [ring_pt(th, top(th) + 0.004, 0.006) for th in ths]
    inner_t = [ring_pt(th, top(th), 0.012) for th in ths]
    inner_b = [ring_pt(th, z0, 0.012) for th in ths]
    mid_o = [outer_b[i].lerp(outer_t[i], 0.5) for i in range(nc)]
    mid_i = [inner_b[i].lerp(inner_t[i], 0.5) for i in range(nc)]
    rows = part.add_rings([outer_b, mid_o, outer_t, lip, inner_t, mid_i, inner_b], lambda i, j, p: cw(p))

    def mat(i, j):
        return 'Suit' if i < 2 else ('Suit' if i == 2 else 'Accent')
    part.grid(rows, mat, closed=False)
    for j in range(nc - 1):
        part.f((rows[-1][j], rows[-1][j + 1], rows[0][j + 1], rows[0][j]), 'Suit')
    part.closed = True
    # end caps (the two vertical edges of the opening)
    for j in (0, nc - 1):
        col = [rows[i][j] for i in range(len(rows))]
        if j == 0:
            part.f(col[::-1], 'Accent')
        else:
            part.f(col, 'Accent')
    return part


# =====================================================================================  harness (bass strap)
def build_harness(jacket_obj):
    """Wide navy strap from the left shoulder across the chest to the right hip, and across the back."""
    bvh = bvh_of(jacket_obj)
    # path around the torso in a tilted plane: control points (outside the jacket)
    ctrl = [
        V(0.142, 0.008, 1.530),   # over the left shoulder (top), between the collar and the pad
        V(0.140, -0.072, 1.480),
        V(0.085, -0.140, 1.405),
        V(0.020, -0.150, 1.300),
        V(-0.050, -0.135, 1.205),
        V(-0.115, -0.115, 1.115),
        V(-0.165, -0.055, 1.050),
        V(-0.185, 0.020, 1.035),
        V(-0.150, 0.095, 1.070),
        V(-0.080, 0.130, 1.160),
        V(0.000, 0.140, 1.270),
        V(0.075, 0.135, 1.385),
        V(0.130, 0.092, 1.475),
    ]
    pts = catmull_closed(ctrl, 4)
    width = 0.054
    cross = []
    for i, p in enumerate(pts):
        loc, nrm = nearest_surface(bvh, p)
        t = (pts[(i + 1) % len(pts)] - pts[i - 1]).normalized()
        side = t.cross(nrm).normalized()
        cross.append((loc, nrm, side))
    part = new_part('Harness', sharp=60)
    rows = []
    for loc, nrm, side in cross:
        row = []
        for (a, b) in ((-0.5, 0.0025), (-0.5, 0.0085), (0.5, 0.0085), (0.5, 0.0025)):
            # drape each edge point onto the surface separately so the strap hugs concave areas too
            q0 = loc + side * (a * width) + nrm * 0.01
            l2, n2 = nearest_surface(bvh, q0)
            n2 = (n2 + nrm).normalized()
            q = l2 + n2 * b
            row.append(part.v(q, jacket_weights(q) if q.z < 1.53 else harness_top_w(q)))
        rows.append(row)
    nr = len(rows)
    for i in range(nr):
        r0, r1 = rows[i], rows[(i + 1) % nr]
        part.f((r0[1], r1[1], r1[0], r0[0]), 'SuitDark')
        part.f((r0[2], r1[2], r1[1], r0[1]), 'SuitDark')
        part.f((r0[3], r1[3], r1[2], r0[2]), 'SuitDark')
        part.f((r0[0], r1[0], r1[3], r0[3]), 'SuitDark')
    # buckle on the chest (rigid)
    bk = new_part('StrapBuckle', bone='Chest', sharp=40, bevel=(0.002, 1, 40))
    i = min(range(nr), key=lambda k: abs(cross[k][0].z - 1.335) + (10 if cross[k][0].y > 0 else 0))
    loc, nrm, side = cross[i]
    t = side.cross(nrm)
    R = frame_xyz(side, t, nrm)
    add_box(bk, loc + nrm * 0.012, V(0.072, 0.050, 0.010), 'Metal', axes=R)
    add_box(bk, loc + nrm * 0.0175, V(0.050, 0.026, 0.004), 'SuitDark', axes=R)
    add_box(bk, loc + nrm * 0.0185 + t * 0.0, V(0.010, 0.030, 0.003), 'Glow', axes=R)
    return part


def harness_top_w(q):
    w = jacket_weights(q)
    a = smoothstep(1.53, 1.58, q.z)
    sh = w.get('Shoulder_L', 0) + 0.3 * a
    out = {k: v * (1 - 0.3 * a) for k, v in w.items()}
    out['Shoulder_L'] = sh
    return out


def catmull_closed(ctrl, per):
    out = []
    n = len(ctrl)
    for i in range(n):
        p0, p1, p2, p3 = ctrl[i - 1], ctrl[i], ctrl[(i + 1) % n], ctrl[(i + 2) % n]
        for k in range(per):
            t = k / per
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    return out


def bvh_of(ob):
    me = ob.data
    return BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [tuple(p.vertices) for p in me.polygons])


def nearest_surface(bvh, p):
    """Closest point on an outward-oriented mesh and its face normal (never flipped toward p)."""
    loc, nrm, idx, dist = bvh.find_nearest(p)
    return loc, nrm.normalized()


# =====================================================================================  gloves
def build_gloves():
    for s in (1, -1):
        sfx = '_L' if s > 0 else '_R'
        hx, hy, hz, hk = hand_frame(s)
        w = J['wrist'] if s > 0 else mirror_x(J['wrist'])
        hand = 'Hand' + sfx
        palm = new_part('Palm' + sfx, bone=hand)
        # palm: rounded box (superellipsoid) in the hand frame
        c = w + hy * 0.050 - hz * 0.003
        R = frame_xyz(hx, hy, hz)
        add_superellipsoid(palm, c, R, (0.050, 0.054, 0.0215), (0.050, 0.052, 0.020), 2.8, 'SuitDark', nu=14, nv=8,
                           bulge=lambda d, s=s: 1.0 + 0.10 * max(0.0, s * d.x) * max(0.0, -d.z) * max(0.0, 1 - abs(d.y) * 1.4))
        # gauntlet (into the cuff)
        g = new_part('Gauntlet' + sfx, bone=hand, sharp=50, bevel=(0.002, 1, 50))
        prof = [(0.020, -0.050), (0.039, -0.052), (0.042, -0.040), (0.043, -0.008), (0.040, 0.012), (0.030, 0.022)]
        add_lathe(g, w, hy, prof, 14, ['SuitDark', 'SuitDark', 'SuitDark', 'SuitDark', 'SuitDark'], up=hz)
        # knuckle plate (gunmetal)
        kp = new_part('Knuckles' + sfx, bone=hand, sharp=40, bevel=(0.0025, 1, 40))
        rows = []
        for yy in (0.068, 0.080, 0.094, 0.104):
            row = []
            for kk in (-0.044, -0.026, -0.008, 0.010, 0.028, 0.044):
                bow = 0.004 * (1 - (kk / 0.046) ** 2)
                lift = 0.019 + bow - 0.003 * abs((yy - 0.086) / 0.02)
                row.append(w + hy * yy + hk * kk + hz * lift)
            rows.append(row)
        add_shell(kp, rows, 0.006, 'Metal', flip=(s > 0))
        # fingers: two rigid capsules each (pinky rides on the ring bones)
        for fname in ('Index', 'Middle', 'Ring', 'Pinky'):
            base, pip, tip, y1, z1, y2, z2 = finger_chain(s, fname)
            rad = FINGERS[fname][5]
            b = 'Ring' if fname == 'Pinky' else fname
            f1 = new_part(fname + '1' + sfx, bone=b + '1' + sfx)
            add_capsule(f1, base - y1 * 0.006, pip + y1 * 0.002, rad, rad * 0.97, 'SuitDark', z1)
            f2 = new_part(fname + '2' + sfx, bone=b + '2' + sfx)
            add_capsule(f2, pip, tip, rad * 0.96, rad * 0.88, 'SuitDark', z2)
        base, mid, tip, d, zn, d2, z2 = thumb_chain(s)
        t1 = new_part('Thumb1' + sfx, bone='Thumb1' + sfx)
        add_capsule(t1, base, mid + d * 0.003, THUMB['radius'] * 1.08, THUMB['radius'], 'SuitDark', zn)
        t2 = new_part('Thumb2' + sfx, bone='Thumb2' + sfx)
        add_capsule(t2, mid, tip, THUMB['radius'] * 0.98, THUMB['radius'] * 0.86, 'SuitDark', z2)


def add_capsule(part, a, b, ra, rb, mat, up, sides=8, w=None):
    """Capsule from a to b with hemispherical ends (radii ra at a, rb at b)."""
    a, b = Vector(a), Vector(b)
    ax = (b - a).normalized()
    L = (b - a).length
    prof = []
    nhemi = 3
    for i in range(nhemi):
        ang = math.pi / 2 * (1 - i / nhemi)
        prof.append((ra * math.cos(ang), -ra * math.sin(ang) * 0.85))
    prof.append((ra, 0.0))
    prof.append((rb, L))
    for i in range(1, nhemi + 1):
        ang = math.pi / 2 * i / nhemi
        prof.append((rb * math.cos(ang), L + rb * math.sin(ang) * 0.85))
    prof[0] = (0.0, prof[0][1])
    prof[-1] = (0.0, prof[-1][1])
    add_lathe(part, a, ax, prof, sides, mat, up=up, w=w)


def add_superellipsoid(part, c, R, rpos, rneg, e, mat, nu=16, nv=10, bulge=None, w=None):
    """Superellipsoid around c, oriented by R (columns = local axes), semi-axes per +/- direction."""
    rows = []
    for i in range(1, nv):
        ph = -math.pi / 2 + math.pi * i / nv
        row = []
        for j in range(nu):
            th = TAU * j / nu
            cx, sx = math.cos(th), math.sin(th)
            cp, sp = math.cos(ph), math.sin(ph)
            x = sgnpow(cp, 2 / e) * sgnpow(cx, 2 / e)
            y = sgnpow(cp, 2 / e) * sgnpow(sx, 2 / e)
            z = sgnpow(sp, 2 / e)
            d = V(x, y, z)
            k = bulge(d) if bulge else 1.0
            loc = V(x * (rpos[0] if x > 0 else rneg[0]), y * (rpos[1] if y > 0 else rneg[1]),
                    z * (rpos[2] if z > 0 else rneg[2])) * k
            row.append(part.v(c + R @ loc, w))
        rows.append(row)
    part.grid(rows, mat)
    bot = part.v(c + R @ V(0, 0, -rneg[2]), w)
    top = part.v(c + R @ V(0, 0, rpos[2]), w)
    part.fan(rows[0], bot, mat, flip=True)
    part.fan(rows[-1], top, mat)
    return rows


# =====================================================================================  boots
def foot_outline_half_width(y):
    """Half-width of the boot footprint at y (heel y=+0.093, toe y=-0.212), relative to the foot axis."""
    return pchip([-0.214, -0.202, -0.177, -0.130, -0.095, -0.040, 0.010, 0.050, 0.080, 0.095],
                 [0.022, 0.044, 0.059, 0.066, 0.067, 0.061, 0.057, 0.055, 0.044, 0.014])(y)


def boot_axis_x(y, s):
    """Lateral offset of the boot's centre line (toe slightly lateral)."""
    ank = J['ankle']
    base = ank.x + (-y + ank.y) * 0.055
    return s * base


BOOT_TOP = pchip([-0.212, -0.20, -0.17, -0.13, -0.095, -0.05, -0.01, 0.03, 0.07, 0.093],
                 [0.046, 0.068, 0.085, 0.098, 0.110, 0.132, 0.158, 0.170, 0.155, 0.112])


def build_boots():
    for s in (1, -1):
        sfx = '_L' if s > 0 else '_R'
        foot, toe, shin = 'Foot' + sfx, 'Toe' + sfx, 'LowerLeg' + sfx
        ball_y = J['ball'].y

        def fw(p):
            t = smoothstep(ball_y + 0.018, ball_y - 0.022, p.y)
            a = 0.55 * smoothstep(0.105, 0.165, p.z) * smoothstep(-0.07, 0.0, p.y)
            w = {foot: (1 - t) * (1 - a), toe: t * (1 - a)}
            if a > 0:
                w[shin] = a
            return w
        # ---- sole (rubber): footprint prism with a toe spring, chunky tread blocks
        sole = new_part('Sole' + sfx, sharp=40, bevel=(0.003, 1, 40))
        ys = [-0.212, -0.205, -0.19, -0.165, -0.13, -0.095, -0.06, -0.02, 0.02, 0.055, 0.078, 0.090, 0.093]
        outline_r, outline_l = [], []
        for y in ys:
            hw = foot_outline_half_width(y) + 0.006
            cx = boot_axis_x(y, s)
            outline_r.append((cx - hw, y))
            outline_l.append((cx + hw, y))
        poly = outline_l + list(reversed(outline_r))     # CCW from above? (toe at -y)

        def spring(y):
            return 0.022 * smoothstep(-0.13, -0.212, y) ** 1.5
        levels = [(0.0, 0.002), (0.005, 0.0), (0.036, 0.0), (0.042, 0.004)]
        rings = []
        for z, ins in levels:
            pts = shrink(poly, ins) if ins else poly
            rings.append([sole.v(V(x, y, z + spring(y)), fw(V(x, y, z))) for (x, y) in pts])
        npt = len(poly)
        ccw = polygon_area(poly) > 0
        for i in range(len(rings) - 1):
            for j in range(npt):
                k = (j + 1) % npt
                face = (rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j])
                sole.f(face if ccw else face[::-1], 'Rubber')
        sole.f([rings[0][j] for j in range(npt)][::-1] if ccw else [rings[0][j] for j in range(npt)], 'Rubber')
        sole.f([rings[-1][j] for j in range(npt)] if ccw else [rings[-1][j] for j in range(npt)][::-1], 'Rubber')
        # ---- upper: loft along y of arch sections standing on the sole
        up = new_part('Upper' + sfx)
        ysu = [-0.205, -0.198, -0.185, -0.165, -0.14, -0.115, -0.09, -0.06, -0.03, 0.00, 0.03, 0.055, 0.075, 0.087]
        na = 15
        rows = []
        for y in ysu:
            hw = foot_outline_half_width(y) + 0.002
            cx = boot_axis_x(y, s)
            ztop = BOOT_TOP(y)
            z0 = 0.036 + spring(y)
            row = []
            for a in range(na):
                t = a / (na - 1)                       # 0 = lateral bottom, 1 = medial bottom
                ang = math.pi * t
                ca, sa = math.cos(ang), math.sin(ang)
                x = cx + s * hw * sgnpow(ca, 0.75)
                z = z0 + (ztop - z0) * sgnpow(sa, 0.62)
                row.append(V(x, y, z))
            rows.append(row)
        # close toe and heel with poles
        rr = up.add_rings(rows, lambda i, j, p: fw(p))
        ztoe = V(boot_axis_x(-0.212, s), -0.211, 0.036 + spring(-0.212))
        zheel = V(boot_axis_x(0.093, s), 0.094, 0.07)

        def umat(i, j):
            y = 0.5 * (ysu[i] + ysu[i + 1])
            if y < -0.170:
                return 'Suit'                                   # toe cap
            if y > 0.052 and (j < 3 or j >= na - 4):
                return 'Suit'                                   # heel counter (sides, low)
            return 'SuitDark'
        for i in range(len(rr) - 1):
            for j in range(na - 1):
                face = (rr[i][j], rr[i][j + 1], rr[i + 1][j + 1], rr[i + 1][j])
                up.f(face[::-1] if s > 0 else face, umat(i, j))
        at = up.v(ztoe, fw(ztoe))
        ah = up.v(zheel, fw(zheel))
        for j in range(na - 1):
            ft = (rr[0][j + 1], rr[0][j], at)
            fh = (rr[-1][j], rr[-1][j + 1], ah)
            up.f(ft[::-1] if s > 0 else ft, 'Suit')
            up.f(fh[::-1] if s > 0 else fh, 'SuitDark')
        # ---- shaft (rigid to the shin) with a padded collar and a coral pull tab
        sh = new_part('Shaft' + sfx, bone=shin, sharp=50)
        ank = J['ankle'] if s > 0 else mirror_x(J['ankle'])
        zs = [0.062, 0.10, 0.145, 0.175, 0.195, 0.207, 0.214, 0.210, 0.200]
        rads = [(0.066, 0.072), (0.067, 0.071), (0.066, 0.069), (0.068, 0.070), (0.072, 0.074),
                (0.076, 0.077), (0.071, 0.072), (0.064, 0.065), (0.062, 0.063)]
        n = 18
        rows_s = []
        for z, (rx, ry) in zip(zs, rads):
            yc = ank.y + 0.008 + (z - 0.085) * 0.03
            xc = ank.x + s * 0.002
            rows_s.append([V(xc + rx * math.sin(TAU * j / n), yc - ry * math.cos(TAU * j / n), z) for j in range(n)])
        rs = sh.add_rings(rows_s)

        def smat(i, j):
            return 'Suit' if i >= 4 else 'SuitDark'
        sh.grid(rs, smat)
        # front tongue panel and instep strap
        st = new_part('Strap' + sfx, bone=foot, sharp=40, bevel=(0.002, 1, 40))
        rws = []
        for y in (-0.055, -0.020):
            hw = foot_outline_half_width(y) + 0.005
            cx = boot_axis_x(y, s)
            ztop = BOOT_TOP(y) + 0.004
            z0 = 0.040
            row = []
            for a in range(9):
                t = a / 8
                ang = math.pi * t
                x = cx + s * hw * sgnpow(math.cos(ang), 0.75)
                z = z0 + (ztop - z0) * sgnpow(math.sin(ang), 0.62)
                row.append(V(x, y, z))
            rws.append(row)
        add_shell(st, rws, 0.004, 'SuitDark', flip=(s > 0))
        bk = new_part('StrapBk' + sfx, bone=foot, sharp=40, bevel=(0.0015, 1))
        add_box(bk, V(boot_axis_x(-0.037, s) + s * 0.058, -0.037, 0.082), V(0.008, 0.026, 0.022), 'Metal')
        # shaft strap with a buckle
        ss = new_part('ShaftStrap' + sfx, bone=shin)
        ring = []
        for z, ext in ((0.128, 0.003), (0.132, 0.0065), (0.156, 0.0065), (0.160, 0.003)):
            r = []
            for j in range(n):
                th = TAU * j / n
                rx, ry = 0.067 + ext, 0.070 + ext
                yc = ank.y + 0.008 + (z - 0.085) * 0.03
                r.append(V(ank.x + s * 0.002 + rx * math.sin(th), yc - ry * math.cos(th), z))
            ring.append(r)
        ssr = ss.add_rings(ring)
        ss.grid(ssr, 'SuitDark')
        sb = new_part('ShaftBuckle' + sfx, bone=shin, sharp=40, bevel=(0.0015, 1))
        add_box(sb, V(ank.x + s * 0.076, ank.y + 0.0, 0.144), V(0.008, 0.028, 0.030), 'Metal')
        tab = new_part('PullTab' + sfx, bone=shin, sharp=40, bevel=(0.002, 1, 40))
        add_box(tab, V(ank.x + s * 0.002, ank.y + 0.012 + 0.0045 + 0.066, 0.205), V(0.022, 0.010, 0.046), 'Accent')


def shrink(poly, d):
    """Inset a 2D polygon by d (works for both windings)."""
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    out = []
    n = len(poly)
    for i in range(n):
        p0, p1, p2 = Vector(poly[i - 1]), Vector(poly[i]), Vector(poly[(i + 1) % n])
        e1 = (p1 - p0).normalized()
        e2 = (p2 - p1).normalized()
        n1 = Vector((-e1.y, e1.x))
        n2 = Vector((-e2.y, e2.x))
        b = (n1 + n2)
        b = b.normalized() if b.length > 1e-6 else n1
        # pick the inward direction (toward the centroid)
        to_c = Vector((cx, cy)) - p1
        if b.dot(to_c) < 0:
            b = -b
        k = d / max(0.35, abs(b.dot(n1)))
        out.append((p1.x + b.x * k, p1.y + b.y * k))
    return out


def polygon_area(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i - 1]
        x1, y1 = poly[i]
        a += x0 * y1 - x1 * y0
    return a / 2


# =====================================================================================  helmet
HC = V(0.0, 0.006, 1.736)       # helmet centre
H_AX = dict(x=0.110, yf=0.131, yb=0.126, zt=0.122, zb=0.124)


def hdir(phi, psi):
    """Direction from the helmet centre: phi azimuth (0 = front, +pi/2 = left), psi elevation."""
    return V(math.sin(phi) * math.cos(psi), -math.cos(phi) * math.cos(psi), math.sin(psi))


def helmet_r(d):
    """Radius of the helmet shell along unit direction d (superellipsoid with faceted crown)."""
    a = H_AX['x']
    b = H_AX['yf'] if d.y < 0 else H_AX['yb']
    c = H_AX['zt'] if d.z > 0 else H_AX['zb']
    p, q = 2.7, 2.4
    xy = (abs(d.x / a) ** p + abs(d.y / b) ** p) ** (q / p)
    r = (xy + abs(d.z / c) ** q) ** (-1.0 / q)
    # facets: crown chamfers either side of a soft keel, flattened sides for the pods
    for nx in (1, -1):
        n = V(0.42 * nx, 0.05, 0.906).normalized()
        dn = d.dot(n)
        if dn > 1e-4:
            r = smin(r, 0.1175 / dn, 0.010)
        n = V(nx * 1.0, 0.0, 0.0)
        dn = d.dot(n)
        if dn > 1e-4:
            r = smin(r, 0.1040 / dn, 0.012)
    return r


def hpoint(phi, psi, off=0.0):
    d = hdir(phi, psi)
    return HC + d * (helmet_r(d) + off)


VISOR_PHI = math.radians(74)


def visor_top(phi):
    u = phi / VISOR_PHI
    return math.radians(18.0 - 8.0 * u * u)


def visor_bot(phi):
    u = phi / VISOR_PHI
    return math.radians(-36.0 + 20.0 * abs(u) ** 1.5)


def visor_rows(n_rows_t, n_cols, off_fn, t_list=None):
    """Grid conforming to the visor outline. Returns rows (by t) of points."""
    rows = []
    ts = t_list or [i / (n_rows_t - 1) for i in range(n_rows_t)]
    for t in ts:
        row = []
        for c in range(n_cols):
            sc = lerp(-1.0, 1.0, c / (n_cols - 1))
            # rounded ends: squeeze the band toward its middle near |s| = 1
            phi = VISOR_PHI * sc
            top, bot = visor_top(phi), visor_bot(phi)
            mid = 0.5 * (top + bot)
            half = 0.5 * (top - bot) * (1 - abs(sc) ** 5) ** (1 / 5)
            psi = mid + (t * 2 - 1) * half
            row.append(hpoint(phi, psi, off_fn(sc, t)))
        rows.append(row)
    return rows


def build_helmet():
    head = 'Head'
    # ---- shell (ivory), bottom edge conforms to a curve, faces under the visor/jaw are skipped
    shell = new_part('HelmetShell', bone=head, sharp=55)
    nphi = 40
    psi_b = lambda phi: math.radians(-50 + 8 * gauss(abs(phi) - math.pi / 2, 0.55) - 7 * smoothstep(2.0, math.pi, abs(phi)))
    vs = [0.0, 0.03, 0.08, 0.15, 0.24, 0.34, 0.45, 0.56, 0.67, 0.77, 0.86, 0.93, 0.98]
    rows_pts = []
    for v in vs:
        row = []
        for j in range(nphi):
            phi = -math.pi + TAU * j / nphi
            pb = psi_b(phi)
            psi = lerp(pb, math.radians(88), v ** 1.05)
            row.append(hpoint(phi, psi))
        rows_pts.append(row)
    # rolled bottom edge (inside lip)
    lip = []
    for j in range(nphi):
        phi = -math.pi + TAU * j / nphi
        d = hdir(phi, psi_b(phi) + math.radians(3))
        lip.append(HC + d * (helmet_r(d) - 0.010))
    rows = shell.add_rings([lip] + rows_pts)
    top = shell.v(HC + V(0, 0.004, 0) + V(0, 0, helmet_r(V(0, 0, 1))))

    def smat(i, j):
        return 'Suit'
    # skip faces hidden by the visor/jaw (centre inside their outline, with margin)
    for i in range(len(rows) - 1):
        for j in range(nphi):
            k = (j + 1) % nphi
            phi = -math.pi + TAU * (j + 0.5) / nphi
            p = shell.co[rows[i][j]]
            dd = (p - HC).normalized()
            psi = math.asin(clamp(dd.z, -1, 1))
            pc = (shell.co[rows[i][j]] + shell.co[rows[i][k]] + shell.co[rows[i + 1][k]] + shell.co[rows[i + 1][j]]) / 4
            dc = (pc - HC).normalized()
            pphi = math.atan2(dc.x, -dc.y)
            ppsi = math.asin(clamp(dc.z, -1, 1))
            # faces well inside the visor outline are hidden: skip them (saves triangles)
            if abs(pphi) < VISOR_PHI * 0.80 and visor_bot(pphi) + 0.12 < ppsi < visor_top(pphi) - 0.12:
                continue
            shell.f((rows[i][j], rows[i][k], rows[i + 1][k], rows[i + 1][j]), 'Suit')
    shell.fan(rows[-1], top, 'Suit')

    # ---- visor (dark teal), proud of the shell, glowing brow line near its top edge
    vis = new_part('Visor', bone=head, sharp=70)
    ts = [0.0, 0.05, 0.14, 0.28, 0.45, 0.62, 0.77, 0.86, 0.905, 0.94, 0.975, 1.0]
    ncol = 25

    def voff(sc, t):
        edge = min(t, 1 - t, (1 - abs(sc)) * 1.4)
        return 0.003 + 0.0075 * smoothstep(0.0, 0.35, edge)
    outer = visor_rows(None, ncol, voff, ts)
    inner = visor_rows(None, ncol, lambda sc, t: -0.004, ts)
    vo = vis.add_rings(outer)
    vi = vis.add_rings(inner)

    def vmat(i, j):
        return 'Glow' if 8 <= i < 9 else 'Visor'
    vis.grid(vo, vmat, closed=False)
    nr = len(ts)
    ring_o = [vo[0][c] for c in range(ncol)] + [vo[r][ncol - 1] for r in range(1, nr)] + \
             [vo[nr - 1][c] for c in reversed(range(ncol - 1))] + [vo[r][0] for r in reversed(range(1, nr - 1))]
    ring_i = [vi[0][c] for c in range(ncol)] + [vi[r][ncol - 1] for r in range(1, nr)] + \
             [vi[nr - 1][c] for c in reversed(range(ncol - 1))] + [vi[r][0] for r in reversed(range(1, nr - 1))]
    m = len(ring_o)
    for j in range(m):
        k = (j + 1) % m
        vis.f((ring_o[j], ring_i[j], ring_i[k], ring_o[k]), 'Visor')

    # ---- jaw guard (navy), wraps under the visor, angular chin
    jaw = new_part('Jaw', bone=head, sharp=38, bevel=(0.0025, 1, 38))
    njc = 17
    jrows = []
    jts = [0.0, 0.3, 0.65, 1.0]
    for t in jts:
        row = []
        for c in range(njc):
            sc = lerp(-1.0, 1.0, c / (njc - 1))
            phi = JAW_PHI * sc
            topp = visor_bot(phi) - math.radians(2.0) if abs(phi) < VISOR_PHI else visor_bot(VISOR_PHI) - math.radians(2.0)
            bot = math.radians(-62 + 18 * abs(sc) ** 1.6)
            psi = lerp(bot, topp, t)
            chin = 0.012 * (1 - abs(sc)) ** 1.5 * (1 - t) ** 0.7       # chin juts forward
            keel = 0.0045 * gauss(sc, 0.10)
            row.append(hpoint(phi, psi, 0.003 + chin + keel))
        jrows.append(row)
    add_shell(jaw, jrows, 0.010, 'Suit', flip=False)
    # recolour the keel faces (centre columns) navy
    jaw.mats = [m for m in jaw.mats]
    nq = (len(jts) - 1) * (njc - 1)
    for qi in range(nq):
        j = qi % (njc - 1)
        if 6 <= j < 10:
            jaw.mats[qi * 2] = 'SuitDark'
    # chin vents (metal slats on the keel)
    vents = new_part('JawVents', bone=head, sharp=40)
    for k in range(3):
        psi = math.radians(-50 + 6 * k)
        p = hpoint(0.0, psi, 0.0165 + 0.003 * (2 - k))
        n = (p - HC).normalized()
        tdir = V(1, 0, 0)
        R = frame_xyz(tdir, n.cross(tdir), n)
        add_box(vents, p, V(0.026 - 0.004 * k, 0.0045, 0.0028), 'Metal', axes=R)

    # ---- comm pods (headphone ear cups), glowing rings, antenna on the left pod
    for sx in (1, -1):
        pod = new_part(SX('Pod', sx), bone=head, sharp=40, bevel=(0.0018, 1, 40))
        pc = HC + V(sx * 0.097, 0.016, -0.024)
        ax = V(sx, 0, 0)
        prof = [(0.046, -0.006), (0.053, 0.003), (0.055, 0.018), (0.052, 0.027), (0.047, 0.031),
                (0.045, 0.028), (0.039, 0.028), (0.037, 0.031), (0.027, 0.033), (0.011, 0.036), (0.0, 0.037)]
        mats = ['SuitDark', 'Suit', 'Suit', 'Suit', 'Glow', 'Glow', 'SuitDark', 'SuitDark', 'Metal', 'Metal']
        add_lathe(pod, pc, ax, prof, 22, mats, up=V(0, 0, 1))
    # ---- headband over the crown connecting the pods (navy, raised)
    band = new_part('Headband', bone=head, sharp=45, bevel=(0.002, 1, 45))
    rings_b = []
    alphas = [math.radians(a) for a in range(-66, 67, 6)]
    for al in alphas:
        ring = []
        for beta, off in ((0.115, 0.002), (0.11, 0.0072), (-0.11, 0.0072), (-0.115, 0.002)):
            # meridian through the ears, tilted slightly back
            d = V(math.sin(al), 0.0, math.cos(al))
            d = (d + V(0, 1, 0) * (beta + 0.06)).normalized()
            ring.append(HC + d * (helmet_r(d) + off))
        rings_b.append(ring)
    rb = band.add_rings(rings_b)
    band.grid(rb, 'SuitDark', closed=True)
    band.cap(rb[0], 'SuitDark', flip=True)
    band.cap(rb[-1], 'SuitDark')
    band.closed = True
    # antenna (left pod)
    ant = new_part('Antenna', bone=head, sharp=40)
    base = HC + V(0.120, 0.042, 0.006)
    tip = base + V(0.010, 0.050, 0.075)
    add_tube(ant, [base, tip], [0.0045, 0.0030], 6, 'Metal', cap0=True, cap1=True)
    add_superellipsoid(ant, tip, Matrix.Identity(3), (0.006, 0.006, 0.006), (0.006, 0.006, 0.006), 2.0, 'Glow', nu=8, nv=5)


JAW_PHI = math.radians(80)


# =====================================================================================  back pack
PACK_C = V(0.0, 0.180, 1.305)
PACK_R = (0.152, 0.074, 0.188)    # half extents x, y (depth), z
PACK_REAR = PACK_C.y + PACK_R[1] - 0.016    # flat rear panel


def pack_r(d):
    a, b, c = PACK_R
    e = 3.2
    r = (abs(d.x / a) ** e + abs(d.y / b) ** e + abs(d.z / c) ** e) ** (-1.0 / e)
    return r


def build_pack():
    part = new_part('Pack', bone='Chest', sharp=50)
    nu, nv = 32, 14
    R = Matrix.Identity(3)
    # superellipsoid body with a flattened front (against the back) and an inset rear face
    rows = []
    for i in range(1, nv):
        ph = -math.pi / 2 + math.pi * i / nv
        row = []
        for j in range(nu):
            th = TAU * j / nu
            e = 3.0
            x = sgnpow(math.cos(ph), 2 / e) * sgnpow(math.cos(th), 2 / e)
            y = sgnpow(math.cos(ph), 2 / e) * sgnpow(math.sin(th), 2 / e)
            z = sgnpow(math.sin(ph), 2 / e)
            p = PACK_C + V(x * PACK_R[0], y * PACK_R[1] * (0.85 if y < 0 else 1.0), z * PACK_R[2])
            p.z += -0.02 * x * x * (z < 0)
            p.y = min(p.y, PACK_REAR)             # flat rear panel for the speaker
            row.append(part.v(p))
        rows.append(row)

    def pmat(i, j):
        th = TAU * (j + 0.5) / nu
        # ivory rim band around the rear face edge on a navy shell
        y = math.sin(th)
        if 0.55 < y < 0.86:
            return 'Suit'
        return 'SuitDark'
    part.grid(rows, pmat)
    bot = part.v(PACK_C + V(0, 0, -PACK_R[2]))
    top = part.v(PACK_C + V(0, 0, PACK_R[2]))
    part.fan(rows[0], bot, 'SuitDark', flip=True)
    # (the rear panel is flat: speaker mounts proud of it)
    part.fan(rows[-1], top, 'SuitDark')
    # speaker face on the rear: surround, cone, dust cap (glow), outer glow ring
    sp = new_part('Speaker', bone='Chest', sharp=40)
    face_y = PACK_REAR + 0.0165
    sc = V(0, face_y, PACK_C.z + 0.012)
    prof = [(0.118, -0.010), (0.118, 0.004), (0.112, 0.010), (0.102, 0.010), (0.096, 0.014), (0.088, 0.012),
            (0.082, 0.006), (0.046, -0.016), (0.038, -0.016), (0.038, -0.010), (0.021, -0.002), (0.0, 0.002)]
    mats = ['Suit', 'Suit', 'Glow', 'Fabric', 'Fabric', 'Fabric', 'Metal', 'Metal', 'SuitDark', 'Glow', 'Glow']
    add_lathe(sp, sc, V(0, 1, 0), prof, 26, mats, up=V(0, 0, 1))
    # thrusters at the bottom corners, pointing down and slightly back
    for sx in (1, -1):
        th = new_part(SX('Thruster', sx), bone='Chest', sharp=40, bevel=(0.0025, 1, 40))
        base = jet_base(sx)
        d = JET_DIR
        prof = [(0.0, -0.010), (0.030, -0.010), (0.034, 0.012), (0.028, 0.022), (0.024, 0.030),
                (0.030, 0.052), (0.036, 0.074), (0.033, 0.076), (0.024, 0.060), (0.016, 0.034), (0.0, 0.032)]
        mats = ['SuitDark', 'SuitDark', 'SuitDark', 'Metal', 'Metal', 'Metal', 'Metal', 'Metal', 'Metal', 'Glow']
        add_lathe(th, base, d, prof, 12, mats, up=V(0, 1, 0))
    # mounting yoke between the pack and the jacket
    mt = new_part('PackMount', bone='Chest', sharp=40, bevel=(0.004, 2, 40))
    add_box(mt, V(0, 0.118, 1.43), V(0.20, 0.030, 0.050), 'Metal')
    add_box(mt, V(0, 0.118, 1.16), V(0.16, 0.030, 0.040), 'Metal')


JET_DIR = V(0, 0.32, -1.0).normalized()


def jet_base(sx):
    return V(sx * 0.098, PACK_C.y + 0.010, PACK_C.z - PACK_R[2] + 0.030)


def jet_exit(sx):
    return jet_base(sx) + JET_DIR * 0.076


# =====================================================================================  rifle
# Rifle local frame (Blender): origin at the grip centre, barrel along -Y, top +Z, +X = rifle's left.
RIFLE_MUZZLE_Y = -0.628
RIFLE_BUTT_Y = 0.322
BORE_Z = 0.085
FOREGRIP_C = V(0.0, -0.209, -0.006)


def prism_yz(part, outline, half_w, chamfer, mat, x0=0.0, w=None):
    """Extrude a side-view outline [(y, z), ...] along x from -half_w to +half_w with chamfered faces."""
    poly = outline
    ccw = polygon_area(poly) > 0
    if not ccw:
        poly = list(reversed(poly))
    ins = shrink(poly, chamfer)
    levels = [(-half_w, ins), (-half_w + chamfer, poly), (half_w - chamfer, poly), (half_w, ins)]
    rings = []
    for x, pts in levels:
        rings.append([part.v(V(x0 + x, y, z), w) for (y, z) in pts])
    n = len(poly)
    for i in range(len(rings) - 1):
        for j in range(n):
            k = (j + 1) % n
            part.f((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]), mat)
    part.f([rings[0][j] for j in range(n)][::-1], mat)
    part.f([rings[-1][j] for j in range(n)], mat)
    return rings


def build_rifle():
    rp = []
    body = Part('Rifle_body', sharp=35, bevel=(0.0028, 1, 35))
    rp.append(body)
    # receiver (ivory)
    recv = [(0.200, 0.122), (-0.205, 0.122), (-0.248, 0.110), (-0.268, 0.090), (-0.262, 0.056),
            (-0.180, 0.044), (0.060, 0.044), (0.172, 0.050), (0.205, 0.072), (0.212, 0.104)]
    prism_yz(body, recv, 0.029, 0.007, 'Suit')
    # stock (navy)
    stock = Part('Rifle_stock', sharp=35, bevel=(0.0028, 1, 35))
    rp.append(stock)
    st = [(0.196, 0.116), (0.300, 0.110), (0.322, 0.102), (0.326, 0.020), (0.312, 0.000), (0.262, 0.004),
          (0.226, 0.040), (0.196, 0.058)]
    prism_yz(stock, st, 0.024, 0.006, 'SuitDark')
    # butt pad (rubber)
    add_box(stock, V(0, 0.331, 0.060), V(0.040, 0.012, 0.094), 'Rubber')
    # barrel shroud (navy octagon) and muzzle
    sh = Part('Rifle_shroud', sharp=30, bevel=(0.0022, 1, 30))
    rp.append(sh)
    add_tube(sh, [V(0, -0.250, BORE_Z), V(0, -0.540, BORE_Z)], [0.028, 0.026], 8, 'SuitDark', up=V(0, 0, 1),
             phase=math.pi / 8)
    mz = Part('Rifle_muzzle', sharp=40)
    rp.append(mz)
    prof = [(0.020, 0.0), (0.031, 0.0), (0.034, 0.010), (0.034, 0.034), (0.031, 0.036), (0.031, 0.048),
            (0.034, 0.050), (0.034, 0.080), (0.030, 0.088), (0.018, 0.088), (0.014, 0.080), (0.0, 0.080)]
    mats = ['Metal', 'Metal', 'Metal', 'Metal', 'Glow', 'Metal', 'Metal', 'Metal', 'Metal', 'SuitDark', 'SuitDark']
    add_lathe(mz, V(0, -0.540, BORE_Z), V(0, -1, 0), prof, 14, mats, up=V(0, 0, 1))
    # pistol grip and trigger guard (navy)
    gr = Part('Rifle_grip', sharp=35, bevel=(0.0028, 1, 35))
    rp.append(gr)
    grip = [(0.030, 0.046), (-0.032, 0.046), (-0.020, 0.010), (-0.004, -0.070), (0.004, -0.084),
            (0.040, -0.086), (0.050, -0.074), (0.044, -0.020)]
    prism_yz(gr, grip, 0.017, 0.006, 'SuitDark')
    guard = [(-0.030, 0.046), (-0.040, 0.012), (-0.080, 0.004), (-0.096, 0.016), (-0.098, 0.046),
             (-0.088, 0.046), (-0.084, 0.024), (-0.074, 0.016), (-0.046, 0.022), (-0.040, 0.046)]
    prism_yz(gr, guard, 0.0075, 0.002, 'SuitDark')
    add_box(gr, V(0, -0.058, 0.034), V(0.006, 0.010, 0.024), 'Metal')    # trigger
    # foregrip (navy), vertical, slight forward rake
    fg = Part('Rifle_foregrip', sharp=35, bevel=(0.0025, 1, 35))
    rp.append(fg)
    fgo = [(-0.182, 0.048), (-0.228, 0.048), (-0.232, 0.020), (-0.236, -0.052), (-0.228, -0.064),
           (-0.196, -0.064), (-0.188, -0.052), (-0.184, 0.020)]
    prism_yz(fg, fgo, 0.0165, 0.005, 'SuitDark')
    # sight (navy housing, glowing rear lens)
    sg = Part('Rifle_sight', sharp=35, bevel=(0.002, 1, 35))
    rp.append(sg)
    sgo = [(-0.050, 0.122), (-0.140, 0.122), (-0.146, 0.150), (-0.128, 0.166), (-0.060, 0.166), (-0.046, 0.150)]
    prism_yz(sg, sgo, 0.017, 0.004, 'SuitDark')
    add_box(sg, V(0, -0.044, 0.149), V(0.022, 0.003, 0.022), 'Glow')
    # energy cell on the receiver top (glow capsule in a navy cradle)
    ec = Part('Rifle_cell', sharp=40)
    rp.append(ec)
    add_capsule(ec, V(0, 0.040, 0.137), V(0, 0.165, 0.137), 0.0145, 0.0145, 'Glow', V(0, 0, 1), sides=10)
    cr = Part('Rifle_cradle', sharp=35, bevel=(0.0015, 1, 35))
    rp.append(cr)
    for yy in (0.050, 0.155):
        add_box(cr, V(0, yy, 0.134), V(0.040, 0.010, 0.026), 'SuitDark')
    # coral accent stripe and glow conduit on both sides
    sd = Part('Rifle_stripes', sharp=35)
    rp.append(sd)
    for sx in (1, -1):
        add_box(sd, V(sx * 0.0293, -0.020, 0.104), V(0.003, 0.400, 0.010), 'Accent')
        add_box(sd, V(sx * 0.0293, -0.130, 0.072), V(0.003, 0.150, 0.008), 'Glow')
        add_box(sd, V(sx * 0.0245, 0.255, 0.085), V(0.003, 0.080, 0.008), 'Accent')
    return rp


# =====================================================================================  assembly
def bake_vertex_ao(ob, distance=0.25, samples=40, floor=0.42, gamma=1.0, extra_occluders=()):
    """Grayscale AO into a CORNER color attribute; Glow faces stay white, Visor gets a light touch."""
    me = ob.data
    raw = C.bake_ao(ob, distance=distance, samples=samples, ground=True, ground_z=0.0, smooth=1)
    names = [m.name for m in me.materials]
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    cols = []
    for poly in me.polygons:
        wgt = AO_WEIGHT.get(names[poly.material_index], 1.0)
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            a = clamp(raw[vi]) ** gamma
            val = lerp(1.0, lerp(floor, 1.0, a), wgt)
            g = C.srgb_to_linear(val)
            cols.extend((g, g, g, 1.0))
    attr.data.foreach_set('color', cols)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def white_vertex_colors(ob):
    me = ob.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    attr.data.foreach_set('color', [1.0] * (len(me.loops) * 4))
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def join_objects(objs, name):
    base = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs,
                                       selected_editable_objects=objs):
            bpy.ops.object.join()
    base.name = name
    base.data.name = name
    return base


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def create_armature():
    defs = bone_defs()
    arm_data = bpy.data.armatures.new('AgentRig')
    arm = bpy.data.objects.new('Agent', arm_data)
    COLL.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (h, t, zh, parent, deform) in defs.items():
        eb = arm_data.edit_bones.new(name)
        eb.head = h
        eb.tail = t
        eb.align_roll(Vector(zh))
        eb.use_deform = deform
        eb.use_connect = False
    for name, (h, t, zh, parent, deform) in defs.items():
        if parent:
            arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
    # weapon socket: Y = rifle up, Z = barrel direction (so the rifle is an identity child in glTF)
    sock = socket_rest_matrix()
    eb = arm_data.edit_bones.new('WeaponSocket')
    eb.head = sock.translation
    eb.tail = sock.translation + sock.to_3x3().col[1] * 0.08
    eb.align_roll(sock.to_3x3().col[2])
    eb.parent = arm_data.edit_bones['Hand_R']
    eb.use_deform = False
    for sx, nm in ((1, 'Jet_L'), (-1, 'Jet_R')):
        eb = arm_data.edit_bones.new(nm)
        p = jet_exit(sx)
        eb.head = p
        eb.tail = p + JET_DIR * 0.12
        eb.align_roll(V(0, 1, 0))
        eb.parent = arm_data.edit_bones['Chest']
        eb.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


# Right-hand grip relation: rifle frame expressed through the hand frame.
GRIP = dict(fwd=0.066, palm=0.036, k=0.0, rake=15.0)


def grip_frame_in_hand():
    """4x4: rifle (socket) frame relative to the right hand bone's frame (hand local axes X, Y, Z)."""
    # hand local: Y along the hand, Z dorsal, X = Y x Z (toward the pinky for the right hand)
    # rifle up (Z_r) is opposite the pinky direction (thumb on top); barrel follows the hand's Y,
    # tilted down about the knuckle axis because the grip rakes back.
    r = math.radians(GRIP['rake'])
    g = V(-1, 0, 0)          # pinky -> thumb along the grip (hand X points to the pinky on the right hand)
    f = V(0, 1, 0)           # along the hand
    zr = g * math.cos(r) - f * math.sin(r)      # rifle up
    barrel = f * math.cos(r) + g * math.sin(r)
    yr = -barrel
    xr = yr.cross(zr)
    R = frame_xyz(xr, yr, zr)
    pos = V(GRIP['k'], GRIP['fwd'], -GRIP['palm'])
    M = R.to_4x4()
    M.translation = pos
    return M


CONV = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))   # glTF axis conversion


def hand_rest_matrix(side):
    hx, hy, hz, hk = hand_frame(side)
    w = J['wrist'] if side > 0 else mirror_x(J['wrist'])
    M = frame_xyz(hx, hy, hz).to_4x4()
    M.translation = w
    return M


def socket_rest_matrix():
    """WeaponSocket bone frame (armature space, rest): Y = rifle up, Z = barrel, origin at the grip."""
    rifle = hand_rest_matrix(-1) @ grip_frame_in_hand()
    # rifle object frame = socket @ CONV  ->  socket = rifle @ CONV^-1
    return rifle @ CONV.inverted()


def assemble():
    make_materials()
    arm = create_armature()
    jacket = build_jacket()
    flap = build_flap()
    jacket_ob = build_object(jacket)
    build_pants()
    build_belt()
    build_pockets()
    build_knee_guards()
    build_sleeves()
    build_neck()
    build_collar()
    build_harness(jacket_ob)
    build_gloves()
    build_boots()
    build_helmet()
    build_pack()
    objs = [jacket_ob]
    for p in PARTS:
        if p is jacket:
            continue
        objs.append(build_object(p))
    per = {o.name: tri_count(o) for o in objs}
    body = join_objects(objs, 'AgentBody')
    body.parent = arm
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    # rifle
    rparts = build_rifle()
    robjs = [build_object(p) for p in rparts]
    for o in robjs:
        per[o.name] = tri_count(o)
    rifle = join_objects(robjs, 'Rifle')
    if not QUICK:
        bake_vertex_ao(body, distance=0.22, samples=40, floor=0.40)
        bake_vertex_ao(rifle, distance=0.08, samples=24, floor=0.55)
    else:
        white_vertex_colors(body)
        white_vertex_colors(rifle)
    # rifle under the weapon socket bone (rifle frame = socket @ CONV gives an identity glTF child)
    bpy.context.view_layer.update()
    rifle.parent = arm
    rifle.parent_type = 'BONE'
    rifle.parent_bone = 'WeaponSocket'
    bpy.context.view_layer.update()
    rifle.matrix_world = arm.matrix_world @ arm.pose.bones['WeaponSocket'].matrix @ CONV
    muzzle = bpy.data.objects.new('Muzzle', None)
    muzzle.empty_display_type = 'ARROWS'
    muzzle.empty_display_size = 0.1
    COLL.objects.link(muzzle)
    muzzle.parent = rifle
    muzzle.location = (0.0, RIFLE_MUZZLE_Y, BORE_Z)
    return arm, body, rifle, per


# =====================================================================================  export helpers
def read_glb(p):
    b = open(p, 'rb').read()
    off = 12
    chunks = []
    while off < len(b):
        ln, tp = struct.unpack('<II', b[off:off + 8])
        chunks.append((tp, bytearray(b[off + 8:off + 8 + ln])))
        off += 8 + ln
    j = json.loads(chunks[0][1].decode())
    binc = chunks[1][1] if len(chunks) > 1 else bytearray()
    return j, binc


def write_glb(p, j, binc):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binc = bytes(binc) + b'\0' * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binc)
    with open(p, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(binc), 0x004E4942))
        f.write(binc)


def rescale_clip_times(path, durations):
    """Scale each animation's sampler input times so the clip ends exactly at its spec duration.

    The exporter shares identical time accessors between clips; an accessor that two clips need to
    scale differently is cloned (data appended to the binary chunk) before it is rewritten."""
    j, binc = read_glb(path)
    scaled = {}       # accessor index -> factor already applied
    for an in j.get('animations', []):
        D = durations.get(an['name'])
        if D is None:
            continue
        remap = {}
        for smp in an['samplers']:
            ai = smp['input']
            if ai in remap:
                smp['input'] = remap[ai]
                continue
            acc = j['accessors'][ai]
            bv = j['bufferViews'][acc['bufferView']]
            o = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
            n = acc['count']
            ts = list(struct.unpack_from('<%df' % n, binc, o))
            if ts[-1] <= 0:
                remap[ai] = ai
                continue
            k = D / ts[-1]
            if ai in scaled:
                if abs(k - 1.0) < 1e-9:
                    remap[ai] = ai
                    continue
                # clone the accessor for this clip
                while len(binc) % 4:
                    binc.append(0)
                off = len(binc)
                binc.extend(struct.pack('<%df' % n, *[t * k for t in ts]))
                j['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': 4 * n})
                nacc = dict(acc)
                nacc['bufferView'] = len(j['bufferViews']) - 1
                nacc.pop('byteOffset', None)
                nacc['min'] = [ts[0] * k]
                nacc['max'] = [ts[-1] * k]
                j['accessors'].append(nacc)
                remap[ai] = len(j['accessors']) - 1
                smp['input'] = remap[ai]
                continue
            struct.pack_into('<%df' % n, binc, o, *[t * k for t in ts])
            acc['min'] = [ts[0] * k]
            acc['max'] = [ts[-1] * k]
            scaled[ai] = k
            remap[ai] = ai
    j['buffers'][0]['byteLength'] = len(binc)
    write_glb(path, j, binc)


def export(arm, body, rifle, durations):
    os.makedirs(os.path.dirname(OUT_RAW), exist_ok=True)
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(
        filepath=OUT_RAW, export_format='GLB', use_selection=False, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_materials='EXPORT',
        export_cameras=False, export_lights=False, export_extras=False,
        export_animations=bool(durations), export_animation_mode='ACTIONS', export_force_sampling=True,
        export_frame_range=False, export_optimize_animation_size=True, export_reset_pose_bones=True,
        export_skins=True, export_influence_nb=4, export_def_bones=False, export_rest_position_armature=True)
    if durations:
        rescale_clip_times(OUT_RAW, durations)
    exe = C.find_gltfpack()
    cmd = [exe, '-i', OUT_RAW, '-o', OUT_GLB, '-cc', '-kn', '-km', '-kv', '-ke', '-af', '0']
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('gltfpack failed:', r.stderr, r.stdout)
        shutil.copyfile(OUT_RAW, OUT_GLB)
    return OUT_GLB


def report(path, per, durations):
    j, binc = read_glb(path)
    tris = 0
    for m in j['meshes']:
        for pr in m['primitives']:
            acc = j['accessors'][pr['indices']]
            tris += acc['count'] // 3
    names = [n.get('name') for n in j['nodes'] if n.get('name')]
    skins = j.get('skins', [])
    joints = [j['nodes'][i].get('name') for i in skins[0]['joints']] if skins else []
    print('GLB', path, os.path.getsize(path), 'bytes; triangles', tris)
    print('joints (%d):' % len(joints), ' '.join(joints))
    for an in j.get('animations', []):
        ins = set(s['input'] for s in an['samplers'])
        mx = max(j['accessors'][i]['max'][0] for i in ins)
        print('  clip %-12s %.3f s  channels %d' % (an['name'], mx, len(an['channels'])))
    print('nodes with names:', len(names))
    return tris


# =====================================================================================  main
def main():
    t0 = time.time()
    arm, body, rifle, per = assemble()
    print('build %.1fs' % (time.time() - t0))
    total = tri_count(body) + tri_count(rifle)
    for k, v in sorted(per.items(), key=lambda kv: -kv[1])[:40]:
        print('   %-22s %6d' % (k, v))
    print('TRIS body %d rifle %d total %d (budget %d)' % (tri_count(body), tri_count(rifle), total, TRI_BUDGET))
    durations = {}
    if not NOANIM:
        durations = animate(arm)
    path = export(arm, body, rifle, durations)
    report(path, per, durations)
    print('done %.1fs' % (time.time() - t0))


# =====================================================================================  animation: rig math
class Rig:
    """Rest data of the armature (armature space == world space; the armature sits at the origin)."""

    def __init__(self, arm):
        self.arm = arm
        bones = arm.data.bones
        self.names = [b.name for b in bones]
        self.rest = {b.name: b.matrix_local.copy() for b in bones}
        self.rest3 = {n: m.to_3x3().normalized() for n, m in self.rest.items()}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.length = {b.name: b.length for b in bones}
        self.offset = {}
        for n, p in self.parent.items():
            self.offset[n] = (self.rest[p].inverted() @ self.rest[n]) if p else self.rest[n].copy()
        self.chains = {}
        for s, sfx in ((1, '_L'), (-1, '_R')):
            self.chains['leg' + sfx] = self._chain('UpperLeg' + sfx, 'LowerLeg' + sfx, 'Foot' + sfx)
            self.chains['arm' + sfx] = self._chain('UpperArm' + sfx, 'LowerArm' + sfx, 'Hand' + sfx)

    def _chain(self, a, b, c):
        H = self.rest[a].translation
        K = self.rest[b].translation
        E = self.rest[c].translation
        u = (E - H).normalized()
        w = perp(K - H, u)
        n = u.cross(w).normalized()
        return dict(upper=a, lower=b, end=c, y1=(K - H).normalized(), y2=(E - K).normalized(), n=n,
                    L1=(K - H).length, L2=(E - K).length)


class Pose:
    def __init__(self, rig):
        self.rig = rig
        self.q = {n: Quaternion() for n in rig.names}
        self.t = {n: Vector() for n in rig.names}
        self.warn = []

    def M(self, n):
        p = self.rig.parent[n]
        basis = Matrix.Translation(self.t[n]) @ self.q[n].to_matrix().to_4x4()
        if p is None:
            return self.rig.offset[n] @ basis
        return self.M(p) @ self.rig.offset[n] @ basis

    def K(self, n):
        p = self.rig.parent[n]
        return (self.M(p) @ self.rig.offset[n]) if p else self.rig.offset[n].copy()

    def head(self, n):
        return self.M(n).translation.copy()

    def R(self, n):
        return self.M(n).to_3x3().normalized()

    def set_world_rot(self, n, R3):
        Kr = self.K(n).to_3x3().normalized()
        self.q[n] = (Kr.transposed() @ R3).to_quaternion()

    def set_anat(self, n, Q):
        """Rotate bone n by Q (armature axes) relative to its rest orientation, in its parent's posed frame."""
        Rr = self.rig.rest3[n]
        self.q[n] = (Rr.transposed() @ Q.to_matrix() @ Rr).to_quaternion()

    def set_world_pos(self, n, P):
        Km = self.K(n)
        self.t[n] = Km.to_3x3().normalized().transposed() @ (Vector(P) - Km.translation)

    def delta(self, n):
        """World transform taking the bone's rest placement to its posed placement."""
        return self.M(n) @ self.rig.rest[n].inverted()


def basis_yn(y, n):
    return frame_xyz(y, n, y.cross(n))


def ik(P, chain, target, pole, tag=''):
    """Two-bone IK: upper/lower bones reach `target` with the joint bending toward `pole`."""
    c = P.rig.chains[chain]
    H = P.K(c['upper']).translation
    L1, L2 = c['L1'], c['L2']
    d = Vector(target) - H
    dist = d.length
    reach = (L1 + L2) * 0.9993
    if dist > reach:
        P.warn.append('%s %s overreach %.1f mm' % (tag, chain, (dist - reach) * 1000))
        dist = reach
    dist = max(dist, abs(L1 - L2) + 0.02)
    u = d.normalized()
    w = perp(Vector(pole), u)
    ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1)
    sa = math.sqrt(max(0.0, 1 - ca * ca))
    Kp = H + (u * ca + w * sa) * L1
    E = H + u * dist
    y1 = (Kp - H).normalized()
    y2 = (E - Kp).normalized()
    n = u.cross(w).normalized()
    R1 = basis_yn(y1, perp(n, y1)) @ basis_yn(c['y1'], perp(c['n'], c['y1'])).transposed()
    P.set_world_rot(c['upper'], R1 @ P.rig.rest3[c['upper']])
    R2 = basis_yn(y2, perp(n, y2)) @ basis_yn(c['y2'], perp(c['n'], c['y2'])).transposed()
    P.set_world_rot(c['lower'], R2 @ P.rig.rest3[c['lower']])
    return E


def eul(yaw=0.0, pitch=0.0, roll=0.0):
    """Quaternion from degrees in armature axes: yaw about +Z (turn left), pitch about +X (lean
    forward), roll about +Y (lean to the character's left). Applied yaw * pitch * roll."""
    return (Quaternion((0, 0, 1), math.radians(yaw)) @ Quaternion((1, 0, 0), math.radians(pitch))
            @ Quaternion((0, 1, 0), math.radians(roll)))


# =====================================================================================  animation: building blocks
FOOT_HEEL = {}     # contact offsets from the ankle (rest), per side
FOOT_BALL = {}
for _s, _sfx in ((1, '_L'), (-1, '_R')):
    _a = J['ankle'] if _s > 0 else mirror_x(J['ankle'])
    _b = J['ball'] if _s > 0 else mirror_x(J['ball'])
    FOOT_HEEL[_sfx] = V(0.0, 0.093, 0.0) + V(_a.x, 0, 0) - _a
    FOOT_BALL[_sfx] = V(_b.x, _b.y, 0.0) - _a
ANKLE_Z = J['ankle'].z


def foot_rot(yaw, pitch, roll=0.0):
    """World rotation applied to a rest foot: yaw (deg, +left), pitch (deg, + toes up), roll (deg)."""
    return eul(yaw=yaw) @ Quaternion((1, 0, 0), -math.radians(pitch)) @ Quaternion((0, 1, 0), math.radians(roll))


def plant(P, sfx, ankle, yaw, pitch, toe=0.0, pole=None, tag='', roll=0.0):
    """Leg IK to an ankle position with a foot orientation; toe bends (deg, + toes up) relative to the foot."""
    q = foot_rot(yaw, pitch, roll)
    if pole is None:
        pole = eul(yaw=yaw) @ V(0, -1, 0)
        pole = (pole + V(0.12 if sfx == '_L' else -0.12, 0, 0)).normalized()
    ik(P, 'leg' + sfx, ankle, pole, tag)
    P.set_world_rot('Foot' + sfx, q.to_matrix() @ P.rig.rest3['Foot' + sfx])
    qt = q @ Quaternion((1, 0, 0), -math.radians(toe))
    P.set_world_rot('Toe' + sfx, qt.to_matrix() @ P.rig.rest3['Toe' + sfx])


def ankle_from_contact(sfx, contact, yaw, pitch, pivot):
    """Ankle position that keeps the heel or ball contact point at `contact` for this foot rotation."""
    q = foot_rot(yaw, pitch)
    off = FOOT_HEEL[sfx] if pivot == 'heel' else FOOT_BALL[sfx]
    return Vector(contact) - q @ off


def bump(s, peak=0.5, power=1.0):
    """0 at s=0 and s=1, 1 at s=peak (smooth)."""
    if s <= 0 or s >= 1:
        return 0.0
    if s < peak:
        u = s / peak
        return (math.sin(u * math.pi / 2)) ** power
    u = (s - peak) / (1 - peak)
    return (math.cos(u * math.pi / 2)) ** power


class Gait:
    """Planted-foot locomotion in place: the ground streams past at `speed` along `direction`.

    phase c in [0, 1) per foot: stance [0, duty) with heel -> flat -> ball roll, swing [duty, 1).
    Positions are in the character frame; contact points move with the ground, so planted feet never slide.
    """

    def __init__(self, period, speed, duty, land, lift, x_l, x_r, p_land=10.0, p_off=-40.0,
                 direction=V(0, -1, 0), yaw_l=4.0, yaw_r=-4.0, peak=0.4, flat=(0.12, 0.55),
                 swing_pitch=-25.0, lift_power=1.0, phase_r=0.5, ramp=(0.30, 0.10)):
        self.T, self.v, self.duty = period, speed, duty
        self.land = land                  # landing contact (heel) position along the direction, from origin
        self.lift, self.peak, self.lift_power = lift, peak, lift_power
        self.x = {'_L': x_l, '_R': x_r}
        self.yaw = {'_L': yaw_l, '_R': yaw_r}
        self.p_land, self.p_off = p_land, p_off
        self.dir = Vector(direction).normalized()
        self.side = V(0, 0, 1).cross(self.dir)          # left of the direction of travel
        self.flat = flat
        self.swing_pitch = swing_pitch
        self.phase = {'_L': 0.0, '_R': phase_r}
        self.ramp = ramp
        self._ease = None

    def ease(self, s):
        """Relative swing progress (0 -> 1) with zero slope at both ends: a long ramp-in after toe-off
        (heel kick), a fast forward sweep, and a short pull-back so the foot meets the ground at its speed."""
        if self._ease is None:
            a, b = self.ramp
            n = 400
            ws = [smoothstep(0.0, a, i / n) * smoothstep(1.0, 1.0 - b, i / n) for i in range(n + 1)]
            cum = [0.0]
            for i in range(n):
                cum.append(cum[-1] + 0.5 * (ws[i] + ws[i + 1]))
            self._ease = [c / cum[-1] for c in cum]
        x = clamp(s) * (len(self._ease) - 1)
        i = min(int(x), len(self._ease) - 2)
        return lerp(self._ease[i], self._ease[i + 1], x - i)

    def stance_pitch(self, u):
        """u in [0, 1] across the stance: landing pitch -> flat -> toe-off pitch."""
        f0, f1 = self.flat
        if u < f0:
            return self.p_land * (1 - smoothstep(0, f0, u))
        if u < f1:
            return 0.0
        return self.p_off * smoothstep(f1, 1.0, u) ** 1.2

    def foot(self, sfx, t):
        """(ankle position, yaw, pitch, toe bend, in_stance) for the foot at time t."""
        c = ((t / self.T) + self.phase[sfx]) % 1.0
        T, v, d = self.T, self.v, self.duty
        yaw = self.yaw[sfx]
        lat = self.side * self.x[sfx] if self.dir.x == 0 else V(self.x[sfx], 0, 0)
        if self.dir.y == 0:
            lat = V(0, self.x[sfx], 0)
        base_heel = lat + self.dir * self.land
        L = FOOT_BALL[sfx] - FOOT_HEEL[sfx]
        if c < d:
            u = c / d
            travel = -self.dir * (v * c * T)              # ground moves backward relative to the body
            heel = base_heel + travel
            pitch = self.stance_pitch(u)
            if pitch >= 0:
                ankle = ankle_from_contact(sfx, heel, yaw, pitch, 'heel')
                toe = 0.0
            else:
                ball = heel + foot_rot(yaw, 0) @ L
                ankle = ankle_from_contact(sfx, ball, yaw, pitch, 'ball')
                toe = -pitch * 0.92
            return ankle, yaw, pitch, toe, True, -1.0
        # swing: toe-off ankle -> landing ankle
        s = (c - d) / (1 - d)
        heel_off = base_heel - self.dir * (v * d * T)
        ball_off = heel_off + foot_rot(yaw, 0) @ L
        if self.p_off < 0:
            a0 = ankle_from_contact(sfx, ball_off, yaw, self.p_off, 'ball')
        else:   # lifts off from the heel (backward walking)
            a0 = ankle_from_contact(sfx, heel_off, yaw, self.p_off, 'heel')
        if self.p_land >= 0:
            a1 = ankle_from_contact(sfx, base_heel, yaw, self.p_land, 'heel')
        else:   # forefoot landing: the ball touches down first
            a1 = ankle_from_contact(sfx, base_heel + foot_rot(yaw, 0) @ L, yaw, self.p_land, 'ball')
        Ts = (1 - d) * T
        # ground-relative swing: the foot keeps the ground's velocity at toe-off and at touchdown
        # (zero skid) and travels one stride relative to the ground in between
        e = self.ease(s)
        ground = -self.dir * (v * Ts * s)
        rel = (a1 - a0) + self.dir * (v * Ts)
        pos = a0 + ground + rel * e
        pos.z = lerp(a0.z, a1.z, e) + self.lift * bump(s, self.peak, self.lift_power)
        pitch = lerp(self.p_off, self.p_land, smoothstep(0.25, 0.92, s)) + self.swing_pitch * bump(s, 0.45)
        toe = max(0.0, -self.p_off) * 0.9 * (1 - smoothstep(0.0, 0.35, s))
        return pos, yaw, pitch, toe, False, s


def hip_weights(feet):
    """Ankle targets that constrain the pelvis height: planted feet fully, swing feet fading out after
    toe-off and back in before touchdown (keeps the pelvis height continuous)."""
    out = {}
    for sfx, f in feet.items():
        s = f[5]
        w = 1.0 if s < 0 else max(1.0 - smoothstep(0.0, 0.25, s), smoothstep(0.80, 1.0, s))
        if w > 0:
            out[sfx] = (f[0], w)
    return out


def auto_hips(P, ankles, margin=0.993, soft=0.012):
    """How far to lower the pelvis so both legs reach their ankle targets (soft-clamped, >= 0).
    ankles: {sfx: position} or {sfx: (position, weight)}."""
    need = 0.0
    for sfx, a in ankles.items():
        wgt = 1.0
        if isinstance(a, tuple):
            a, wgt = a
        c = P.rig.chains['leg' + sfx]
        H = P.K(c['upper']).translation
        L = (c['L1'] + c['L2']) * margin
        hor = math.hypot(H.x - a.x, H.y - a.y)
        if hor >= L:
            need = max(need, 0.5)
            continue
        zmax = a.z + math.sqrt(L * L - hor * hor)
        need = max(need, (H.z - zmax) * wgt)
    # soft ramp: starts lowering slightly before the hard limit
    x = need + soft
    if x <= 0:
        return 0.0
    return x * x / (4 * soft) if x < 2 * soft else x - soft


def cyc(t, T, k=1.0, ph=0.0):
    return math.sin(TAU * (k * t / T + ph))


def hand_pose(P, sfx, pose):
    """Finger curls: pose = dict(index=(mcp, pip), middle=..., ring=..., thumb=(c1, c2, opp, spread))."""
    for fname, bname in (('index', 'Index'), ('middle', 'Middle'), ('ring', 'Ring')):
        a, b = pose[fname]
        P.q[bname + '1' + sfx] = Quaternion((1, 0, 0), -math.radians(a - REST_CURL[0]))
        P.q[bname + '2' + sfx] = Quaternion((1, 0, 0), -math.radians(b - REST_CURL[1]))
    c1, c2, opp, spr = pose['thumb']
    P.q['Thumb1' + sfx] = (Quaternion((0, 1, 0), math.radians(opp)) @ Quaternion((0, 0, 1), math.radians(spr))
                           @ Quaternion((1, 0, 0), -math.radians(c1)))
    P.q['Thumb2' + sfx] = Quaternion((1, 0, 0), -math.radians(c2))


HANDS = {
    'grip_r': dict(index=(38, 52), middle=(78, 92), ring=(84, 92), thumb=(22, 28, 0, 0)),
    'fore_l': dict(index=(70, 84), middle=(78, 90), ring=(82, 90), thumb=(26, 26, 0, 0)),
    'relaxed': dict(index=(22, 30), middle=(26, 34), ring=(30, 38), thumb=(8, 12, 0, 0)),
    'fist': dict(index=(85, 100), middle=(88, 102), ring=(90, 102), thumb=(30, 40, 0, 0)),
    'open': dict(index=(6, 8), middle=(6, 8), ring=(8, 10), thumb=(0, 4, 0, 0)),
    'point': dict(index=(8, 10), middle=(70, 90), ring=(80, 95), thumb=(20, 30, 0, 0)),
}


def blend_hand(a, b, t):
    out = {}
    for k in a:
        out[k] = tuple(lerp(x, y, t) for x, y in zip(a[k], b[k]))
    return out


# rifle <-> hand relations
G_GRIP = None
G_FORE = None


def rifle_frames():
    """G_GRIP: rifle frame relative to the right hand; G_FORE: left-hand frame relative to the rifle."""
    global G_GRIP, G_FORE
    G_GRIP = grip_frame_in_hand()
    # left hand on the foregrip: thumb up the grip, back of the hand facing the rifle's left side
    xh = V(0, 0.10, 1.0).normalized()          # toward the thumb (left hand), slight rake
    zh = V(1, 0, 0)                            # dorsal
    yh = zh.cross(xh)
    M = frame_xyz(xh, yh, zh).to_4x4()
    fc = FOREGRIP_C.copy()                     # foregrip centre (rifle frame)
    M.translation = fc - yh * FORE['fwd'] + zh * FORE['palm']
    G_FORE = M


FORE = dict(fwd=0.064, palm=0.035)


def rifle_matrix(grip, barrel, up_hint=V(0, 0, 1)):
    """Rifle object world matrix from the grip position and barrel direction (rifle local -Y)."""
    b = Vector(barrel).normalized()
    z = perp(Vector(up_hint), b)
    y = -b
    x = y.cross(z)
    M = frame_xyz(x, y, z).to_4x4()
    M.translation = Vector(grip)
    return M


def hold(P, M_rifle, pole_r, pole_l, left=True, tag='', grip_hand='grip_r', fore_hand='fore_l'):
    """Both hands on the rifle: right hand on the grip, left on the foregrip (IK)."""
    Mh = M_rifle @ G_GRIP.inverted()
    ik(P, 'arm_R', Mh.translation, pole_r, tag)
    P.set_world_rot('Hand_R', Mh.to_3x3().normalized())
    hand_pose(P, '_R', HANDS[grip_hand] if isinstance(grip_hand, str) else grip_hand)
    if left:
        Ml = M_rifle @ G_FORE
        ik(P, 'arm_L', Ml.translation, pole_l, tag)
        P.set_world_rot('Hand_L', Ml.to_3x3().normalized())
        hand_pose(P, '_L', HANDS[fore_hand] if isinstance(fore_hand, str) else fore_hand)


def body(P, hips, hip_rot, spine=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0)):
    """Pelvis position (Hips bone head, world) + rotations (yaw, pitch, roll) in degrees."""
    P.set_world_pos('Hips', hips)
    P.set_anat('Hips', eul(*hip_rot))
    P.set_anat('Spine', eul(*spine))
    P.set_anat('Chest', eul(*chest))
    P.set_anat('Neck', eul(*neck))
    P.set_anat('Head', eul(*head))


def look(P, fwd, up=V(0, 0, 1), amount=1.0):
    """Turn the head so its face points along `fwd` (world), blended by `amount`."""
    R_rest = P.rig.rest3['Head']
    cur = P.R('Head')
    face = cur @ (R_rest.transposed() @ V(0, -1, 0))
    q = face.rotation_difference(Vector(fwd).normalized())
    q = Quaternion().slerp(q, amount)
    P.set_world_rot('Head', q.to_matrix() @ cur)


def shoulders(P, l=(0, 0, 0), r=(0, 0, 0)):
    """Clavicle rotations (yaw = protraction forward, roll = elevation), degrees, mirrored for the right."""
    P.set_anat('Shoulder_L', eul(l[0], l[1], l[2]))
    P.set_anat('Shoulder_R', eul(-r[0], r[1], -r[2]))


def chest_space(P, M_rest_world):
    """Express a placement given in rest-pose world terms in the posed chest frame."""
    return P.delta('Chest') @ M_rest_world


# =====================================================================================  animation: clips
CLIPS = {}


CLIP_FPS = {}


def clip(name, duration, loop=True, fps=FPS):
    def deco(fn):
        CLIPS[name] = (fn, duration, loop)
        CLIP_FPS[name] = fps
        return fn
    return deco


REST_HIPS = HIPS_HEAD.copy()


def low_ready(P, t=0.0, bob=V(0, 0, 0), aim_mix=0.0):
    """Rifle at low ready, carried with the chest (muzzle forward-down-left)."""
    grip = V(-0.118, -0.235, 1.155) + bob
    barrel = V(0.25, -0.84, -0.48)
    M = rifle_matrix(grip, barrel, V(-0.30, 0.0, 1.0))
    return chest_space(P, M)


def ready(P, bob=V(0, 0, 0)):
    """Rifle at ready (higher, muzzle forward and slightly down) carried with the chest."""
    grip = V(-0.118, -0.270, 1.225) + bob
    barrel = V(0.17, -0.93, -0.30)
    M = rifle_matrix(grip, barrel, V(-0.22, 0.0, 1.0))
    return chest_space(P, M)


AIM_GRIP = V(-0.105, -0.345, 1.425)
AIM_CHEST = V(0.0, 0.0, 0.0)          # chest head position in the Aim clip (filled in by animate())


def aimed(P, sway=V(0, 0, 0), kick=0.0, climb=0.0, world=True):
    """Rifle shouldered and level, aligned with the aim direction (-Y). kick moves it back, climb pitches up."""
    grip = AIM_GRIP + sway + V(0, kick, 0)
    barrel = (Quaternion((1, 0, 0), -math.radians(climb)) @ V(0, -1, 0))
    return rifle_matrix(grip, barrel, V(0, 0, 1))


@clip('Idle', 3.0)
def clip_idle(P, t):
    T = 3.0
    br = cyc(t, T, 2, -0.25)                # breathing (2 breaths per loop)
    sway = cyc(t, T, 1, 0.0)                # weight shift
    hips = V(0.024 * sway - 0.006, 0.012, 0.956 + 0.004 * br - 0.004 * abs(sway))
    body(P, hips, (-14 + 2.0 * sway, 2.0, -3.0 * sway),
         spine=(5, 1.0 - 0.8 * br, 1.6 * sway), chest=(5, 1.0 - 2.2 * br, 1.4 * sway),
         neck=(0, -2.0 + 1.0 * br, -0.6 * sway))
    # head look: glance left, back, small glance right
    gl = smoothstep(0.70, 1.10, t) * (1 - smoothstep(1.65, 2.05, t))
    gr = smoothstep(2.20, 2.50, t) * (1 - smoothstep(2.62, 2.95, t))
    P.set_anat('Head', eul(4 + 24 * gl - 10 * gr, -3 + 3 * gl - 2 * gr, -3 * gl + 2 * gr))
    shoulders(P, l=(1, 0, 1.2 * max(0, br)), r=(1, 0, 1.2 * max(0, br)))
    plant(P, '_L', V(0.130, -0.075, ANKLE_Z), 13, 0, 0, tag='Idle')
    plant(P, '_R', V(-0.135, 0.075, ANKLE_Z), -17, 0, 0, tag='Idle')
    shoulders(P, l=(8, 0, 2.0 * max(0, br)), r=(2, 0, 2.0 * max(0, br)))
    bob = V(0, 0, 0.006 * br)
    hold(P, low_ready(P, t, bob), V(-0.6, 0.6, -0.4), V(0.7, 0.2, -0.7), tag='Idle')


def locomotion(P, t, g, hips_z, lean, bob_amp, yaw_amp, roll_amp, sway_amp, carry, arm_poles, tag,
               chest_yaw=0.0, hip_yaw=0.0, head_level=0.8, spine_twist=0.6, hips_y=0.0, extra=None):
    T = g.T
    # vertical bob: lowest at each mid-stance
    cL = (t / T) % 1.0
    ph = cL - g.duty * 0.5
    bobz = -bob_amp * math.cos(TAU * 2 * ph)
    yaw = hip_yaw - yaw_amp * math.cos(TAU * cL)          # left leg forward at c=0 -> pelvis turned right
    roll = -roll_amp * math.sin(TAU * (cL - g.duty * 0.5) + math.pi / 2) * 0
    roll = roll_amp * math.cos(TAU * 2 * ph) * (1 if math.cos(TAU * cL) > 0 else -1) * 0 + \
        -roll_amp * math.sin(TAU * cL)
    sway = sway_amp * math.cos(TAU * (cL - g.duty * 0.5))
    hips = V(sway, hips_y, hips_z + bobz)
    # shoulders counter-rotate against the pelvis (net chest yaw opposite to the hips)
    sp_yaw = -yaw * (0.5 + 0.5 * spine_twist) * 0.5 + chest_yaw * 0.5 - (yaw - hip_yaw) * 0.25
    body(P, hips, (yaw, lean * 0.5, roll),
         spine=(sp_yaw, lean * 0.3 + 1.5 * math.cos(TAU * 2 * ph), -roll * 0.5),
         chest=(sp_yaw, lean * 0.2, -roll * 0.3))
    feet = {sfx: g.foot(sfx, t) for sfx in ('_L', '_R')}
    dz = auto_hips(P, hip_weights(feet))
    if dz > 0:
        hips.z -= dz
        P.set_world_pos('Hips', hips)
    # keep the head stable and level
    P.set_anat('Neck', eul(0, -lean * 0.35 * head_level, 0))
    P.set_anat('Head', eul(0, -lean * 0.45 * head_level, 0))
    look(P, V(0, -1, -0.05), amount=head_level)
    for sfx in ('_L', '_R'):
        a, yw, pt, toe, st, _s = feet[sfx]
        plant(P, sfx, a, yw, pt, toe, tag=tag if st else tag + '(swing)')
    shoulders(P, l=(8, 0, 0), r=(2, 0, 0))
    if extra:
        extra(P, t, cL, bobz)
    if carry is not None:
        # the rifle lags the body bob a little (overlap)
        lag = -bob_amp * math.cos(TAU * 2 * (ph - 0.07)) - bobz
        hold(P, carry(P, t, cL, bobz + lag * 1.4), arm_poles[0], arm_poles[1], tag=tag)


@clip('Walk', 1.0, fps=60)
def clip_walk(P, t):
    g = Gait(1.0, 2.4, 0.36, land=0.27, lift=0.15, x_l=0.100, x_r=-0.100, p_land=12, p_off=-40,
             yaw_l=5, yaw_r=-5, peak=0.40, flat=(0.14, 0.52), swing_pitch=-14, ramp=(0.10, 0.10))
    carry = lambda P, t, c, bz: low_ready(P, t, V(0, 0, -0.35 * bz))
    locomotion(P, t, g, 0.922, lean=6, bob_amp=0.012, yaw_amp=7, roll_amp=2.5, sway_amp=0.012,
               carry=carry, arm_poles=(V(-0.6, 0.6, -0.4), V(0.7, 0.2, -0.7)), tag='Walk')


@clip('Run', 0.72, fps=60)
def clip_run(P, t):
    g = Gait(0.72, 6.0, 0.215, land=0.30, lift=0.36, x_l=0.085, x_r=-0.085, p_land=6, p_off=-48,
             yaw_l=3, yaw_r=-3, peak=0.34, flat=(0.10, 0.42), swing_pitch=-38, lift_power=0.9,
             ramp=(0.08, 0.08))
    carry = lambda P, t, c, bz: ready(P, V(0, 0, -0.45 * bz))
    locomotion(P, t, g, 0.905, lean=12, bob_amp=0.026, yaw_amp=10, roll_amp=3, sway_amp=0.008,
               carry=carry, arm_poles=(V(-0.7, 0.5, -0.4), V(0.7, 0.2, -0.7)), tag='Run')


@clip('Aim', 1.0)
def clip_aim(P, t):
    T = 1.0
    br = cyc(t, T, 1, -0.25)
    sw = cyc(t, T, 1, 0.1)
    hips = V(-0.010, 0.020, 0.950 + 0.002 * br)
    body(P, hips, (-18, 3, 0), spine=(6, 2, 0), chest=(7, 3 - 1.0 * br, 0), neck=(3, 6, 0), head=(4, 8, -6))
    shoulders(P, l=(6, 0, 0), r=(2, 0, 3))
    plant(P, '_L', V(0.125, -0.115, ANKLE_Z), 8, 0, 0, tag='Aim')
    plant(P, '_R', V(-0.150, 0.120, ANKLE_Z), -28, 0, 0, tag='Aim')
    M = aimed(P, V(0.002 * sw, 0, 0.0025 * br))
    hold(P, M, V(-0.8, 0.3, -0.5), V(0.5, 0.0, -0.9), tag='Aim')


@clip('Fire', 0.18, loop=False)
def clip_fire(P, t):
    k = t / 0.18
    kick = bump(k, 0.16, 0.8)                      # sharp recoil, smooth recovery
    hips = V(-0.010, 0.020, 0.950)
    body(P, hips, (-18, 3, 0), spine=(6, 2 - 3 * kick, 0), chest=(7, 3 - 6 * kick, 0), neck=(3, 6 - 2 * kick, 0),
         head=(4, 8 - 5 * kick, -6))
    shoulders(P, l=(6, 0, 0), r=(2 - 4 * kick, 0, 3 + 2 * kick))
    plant(P, '_L', V(0.125, -0.115, ANKLE_Z), 8, 0, 0, tag='Fire')
    plant(P, '_R', V(-0.150, 0.120, ANKLE_Z), -28, 0, 0, tag='Fire')
    M = aimed(P, V(0.004 * kick, 0, 0.010 * kick), kick=0.050 * kick, climb=10 * kick)
    hold(P, M, V(-0.8, 0.3, -0.5), V(0.5, 0.0, -0.9), tag='Fire')


def free_arm(P, sfx, t, T, phase, fwd, back, pole, hand='fist', amp=1.0):
    """Swinging free arm: hand position oscillates between `fwd` and `back` offsets from the shoulder."""
    sh = P.K('UpperArm' + sfx).translation
    k = 0.5 + 0.5 * math.cos(TAU * (t / T + phase))      # 1 = forward
    k = lerp(0.5, k, amp)
    off = Vector(back).lerp(Vector(fwd), smoothstep(0.0, 1.0, k))
    # arc: lift the hand a little through the middle of the swing
    off.z += 0.03 * math.sin(math.pi * k)
    target = sh + off
    ik(P, 'arm' + sfx, target, pole)
    # fist roughly aligned with the forearm, knuckles forward
    fa = P.R('LowerArm' + sfx)
    P.set_world_rot('Hand' + sfx, fa @ P.rig.rest3['LowerArm' + sfx].transposed() @ P.rig.rest3['Hand' + sfx])
    hand_pose(P, sfx, HANDS[hand])


def across_chest(P, bob=V(0, 0, 0), swing=0.0):
    """Rifle carried diagonally across the chest in the right hand (sprint)."""
    grip = V(-0.090, -0.205, 1.235) + bob
    barrel = (Quaternion((0, 1, 0), math.radians(swing)) @ V(0.62, -0.42, 0.66))
    M = rifle_matrix(grip, barrel, V(-0.55, -0.6, 0.3))
    return chest_space(P, M)


@clip('Sprint', 0.56, fps=60)
def clip_sprint(P, t):
    T = 0.56
    g = Gait(T, 9.5, 0.17, land=0.30, lift=0.50, x_l=0.072, x_r=-0.072, p_land=-6, p_off=-55,
             yaw_l=2, yaw_r=-2, peak=0.30, flat=(0.12, 0.40), swing_pitch=-42, lift_power=0.75,
             ramp=(0.06, 0.07))

    def extra(P, t, c, bz):
        free_arm(P, '_L', t, T, 0.5, fwd=V(-0.02, -0.34, -0.05), back=V(0.07, 0.27, -0.42),
                 pole=V(0.45, 0.8, -0.25))
        hand_pose(P, '_L', HANDS['fist'])

    def carry(P, t, c, bz):
        return across_chest(P, V(0, 0, -0.4 * bz), swing=6 * math.cos(TAU * c))
    locomotion(P, t, g, 0.880, lean=26, bob_amp=0.022, yaw_amp=13, roll_amp=3, sway_amp=0.006,
               carry=None, arm_poles=None, tag='Sprint', extra=extra, head_level=0.7)
    M = carry(P, t, (t / T) % 1.0, 0.0)
    Mh = M @ G_GRIP.inverted()
    ik(P, 'arm_R', Mh.translation, V(-0.6, 0.6, -0.5), 'Sprint')
    P.set_world_rot('Hand_R', Mh.to_3x3().normalized())
    hand_pose(P, '_R', HANDS['grip_r'])


def aim_upper(P, t, T, tag, chest_yaw_world=-6.0, breathe=True, kick=0.0, climb=0.0):
    """Aiming upper body on top of any leg motion: chest turned to aim, rifle world-aligned."""
    br = cyc(t, T, 1, -0.25) if breathe else 0.0
    hips_q = P.R('Hips') @ P.rig.rest3['Hips'].transposed()
    hips_yaw = math.degrees(math.atan2(-(hips_q @ V(0, -1, 0)).x, -(hips_q @ V(0, -1, 0)).y)) * -1
    tw = chest_yaw_world - hips_yaw
    P.set_anat('Spine', eul(tw * 0.45, 3, 0))
    P.set_anat('Chest', eul(tw * 0.55, 4 - br, 0))
    P.set_anat('Neck', eul(0, 4, 0))
    P.set_anat('Head', eul(0, 6, -5))
    look(P, V(-0.02, -1, -0.12), amount=0.85)
    shoulders(P, l=(6, 0, 0), r=(2, 0, 3))
    # rifle stays level and pointed at the aim direction, but rides with the chest's translation
    follow = P.head('Chest') - AIM_CHEST
    M = aimed(P, follow + V(0, 0, 0.002 * br), kick=kick, climb=climb)
    hold(P, M, V(-0.8, 0.3, -0.5), V(0.5, 0.0, -0.9), tag=tag)


def strafe(P, t, sign, tag):
    """sign +1 = StrafeLeft (moving toward +X), -1 = StrafeRight."""
    T = 0.72
    g = Gait(T, 5.0, 0.22, land=0.25, lift=0.24, x_l=-0.075 * sign, x_r=0.075 * sign, p_land=4, p_off=-40,
             direction=V(sign, 0, 0), yaw_l=40 * sign, yaw_r=40 * sign, peak=0.38, flat=(0.12, 0.45),
             swing_pitch=-20, phase_r=0.5, ramp=(0.06, 0.08))
    cL = (t / T) % 1.0
    ph = cL - g.duty * 0.5
    bobz = -0.018 * math.cos(TAU * 2 * ph)
    hip_yaw = 32 * sign + 6 * math.cos(TAU * cL) * sign
    hips = V(0.0, 0.012, 0.905 + bobz)
    body(P, hips, (hip_yaw, 7, 0))
    feet = {sfx: g.foot(sfx, t) for sfx in ('_L', '_R')}
    dz = auto_hips(P, hip_weights(feet))
    if dz > 0:
        hips.z -= dz
        P.set_world_pos('Hips', hips)
    for sfx in ('_L', '_R'):
        a, yw, pt, toe, st, _s = feet[sfx]
        pole = (foot_rot(yw, 0) @ V(0, -1, 0))
        plant(P, sfx, a, yw, pt, toe, tag=tag if st else tag + '(swing)', pole=pole)
    aim_upper(P, t, T, tag)


@clip('StrafeLeft', 0.72, fps=60)
def clip_strafe_l(P, t):
    strafe(P, t, 1, 'StrafeLeft')


@clip('StrafeRight', 0.72, fps=60)
def clip_strafe_r(P, t):
    strafe(P, t, -1, 'StrafeRight')


@clip('Backpedal', 0.8, fps=60)
def clip_backpedal(P, t):
    T = 0.8
    g = Gait(T, 3.5, 0.27, land=0.25, lift=0.16, x_l=0.10, x_r=-0.10, p_land=-14, p_off=12,
             direction=V(0, 1, 0), yaw_l=8, yaw_r=-8, peak=0.5, flat=(0.25, 0.70),
             swing_pitch=6, ramp=(0.05, 0.10))
    cL = (t / T) % 1.0
    ph = cL - g.duty * 0.5
    bobz = -0.014 * math.cos(TAU * 2 * ph)
    hips = V(0.008 * math.cos(TAU * cL), 0.03, 0.902 + bobz)
    body(P, hips, (-14 + 6 * math.cos(TAU * cL), -2, 2 * math.sin(TAU * cL)))
    feet = {sfx: g.foot(sfx, t) for sfx in ('_L', '_R')}
    dz = auto_hips(P, hip_weights(feet))
    if dz > 0:
        hips.z -= dz
        P.set_world_pos('Hips', hips)
    for sfx in ('_L', '_R'):
        a, yw, pt, toe, st, _s = feet[sfx]
        plant(P, sfx, a, yw, pt, toe, tag='Backpedal' if st else 'Backpedal(swing)')
    aim_upper(P, t, T, 'Backpedal')


IDLE_FEET = {'_L': (V(0.130, -0.075, ANKLE_Z), 13), '_R': (V(-0.135, 0.075, ANKLE_Z), -17)}


def stand_feet(P, tag, lift_l=0.0, lift_r=0.0, pitch_l=0.0, pitch_r=0.0, spread=0.0, fwd=(0.0, 0.0)):
    for sfx, lift, pitch, f in (('_L', lift_l, pitch_l, fwd[0]), ('_R', lift_r, pitch_r, fwd[1])):
        a, yaw = IDLE_FEET[sfx]
        a = a.copy() + V(spread * (1 if sfx == '_L' else -1), f, 0)
        if pitch < 0 and lift <= 0:
            ball = a + foot_rot(yaw, 0) @ FOOT_BALL[sfx]
            ball.z = 0.0
            ank = ankle_from_contact(sfx, ball, yaw, pitch, 'ball')
            plant(P, sfx, ank, yaw, pitch, -pitch * 0.9, tag=tag)
        else:
            plant(P, sfx, a + V(0, 0, lift), yaw, pitch, 0.0, tag=tag)


@clip('JumpStart', 0.25, loop=False)
def clip_jump_start(P, t):
    k = t / 0.25
    crouch = smoothstep(0.0, 0.45, k) * (1 - smoothstep(0.45, 0.85, k))
    launch = smoothstep(0.45, 1.0, k)
    hz = 0.958 - 0.150 * crouch + 0.080 * launch
    body(P, V(0, 0.020 - 0.035 * crouch, hz), (-10, 18 * crouch - 4 * launch, 0),
         spine=(4, 10 * crouch - 5 * launch, 0), chest=(4, 8 * crouch - 7 * launch, 0),
         neck=(0, -8 * crouch + 2 * launch, 0), head=(0, -5 * crouch + 3 * launch, 0))
    heel = smoothstep(0.55, 0.85, k)
    off = smoothstep(0.78, 1.0, k)
    for sfx in ('_L', '_R'):
        a, yaw = IDLE_FEET[sfx]
        pitch = -42 * heel - 8 * off
        ball = a + foot_rot(yaw, 0) @ FOOT_BALL[sfx]
        ball.z = 0.0
        ank = ankle_from_contact(sfx, ball, yaw, pitch, 'ball') if pitch < 0 else a.copy()
        ank.z += 0.05 * off
        plant(P, sfx, ank, yaw, pitch, -pitch * 0.85 * (1 - off), tag='JumpStart')
    shoulders(P, l=(8, 0, 0), r=(2, 0, 0))
    Ma, Mb = low_ready(P, bob=V(0, 0.01 * crouch, -0.01 * crouch)), ready(P)
    hold(P, mat_lerp(Ma, Mb, launch), V(-0.6, 0.6, -0.4), V(0.7, 0.2, -0.7), tag='JumpStart')


def mat_lerp(A, B, t):
    qa, qb = A.to_quaternion(), B.to_quaternion()
    q = qa.slerp(qb, t)
    M = q.to_matrix().to_4x4()
    M.translation = A.translation.lerp(B.translation, t)
    return M


FALL_HIPS = 1.0


def fall_pose(P, t, T=0.8, amt=1.0):
    w1 = cyc(t, T, 1, 0.0)
    w2 = cyc(t, T, 1, 0.25)
    body(P, V(0, 0.015, FALL_HIPS + 0.010 * w2), (-6 + 5 * w1, -4 + 3 * w2, 4 * w1),
         spine=(2, 2, -2 * w1), chest=(2, -3 + 3 * w2, -3 * w1), neck=(0, 4, 0), head=(0, 3 - 3 * w2, 2 * w1))
    # legs tucked, pedalling a little out of phase
    for sfx, ph, sx in (('_L', 0.0, 1), ('_R', 0.5, -1)):
        a = cyc(t, T, 1, ph)
        b = cyc(t, T, 1, ph + 0.25)
        ank = V(sx * (0.12 + 0.02 * b), -0.03 + 0.11 * a, 0.25 + 0.06 * b)
        pitch = -30 + 12 * b
        plant(P, sfx, ank, 8 * sx, pitch, 6, tag='Fall', pole=V(sx * 0.2, -1, 0.1))
    shoulders(P, l=(6, 0, 3 + 2 * w2), r=(2, 0, 3 + 2 * w2))
    M = ready(P, V(0.02 * w1, 0.01 * w2, 0.03 * w2))
    hold(P, M, V(-0.9, 0.4, -0.1 + 0.2 * w1), V(0.9, 0.2, -0.3 + 0.2 * w2), tag='Fall')


@clip('Fall', 0.8)
def clip_fall(P, t):
    fall_pose(P, t)


@clip('Land', 0.35, loop=False)
def clip_land(P, t):
    k = t / 0.35
    imp = bump(k, 0.24, 0.9)                    # deepest squat at ~0.08 s
    settle = smoothstep(0.35, 1.0, k)
    hz = lerp(0.990, 0.958, settle) - 0.175 * imp
    body(P, V(0, 0.020 - 0.035 * imp, hz), (-10 * settle - 4 * (1 - settle), 2 + 16 * imp, 0),
         spine=(4 * settle, 1 + 10 * imp, 0), chest=(5 * settle, 1.2 + 8 * imp, 0),
         neck=(0, -2 - 10 * imp, 0), head=(4 * settle, -3 - 6 * imp, 0))
    touch = smoothstep(0.0, 0.12, k)
    for sfx in ('_L', '_R'):
        a, yaw = IDLE_FEET[sfx]
        pitch = -18 * (1 - touch)
        ball = a + foot_rot(yaw, 0) @ FOOT_BALL[sfx]
        ball.z = 0.0
        ank = ankle_from_contact(sfx, ball, yaw, pitch, 'ball') if pitch < 0 else a.copy()
        plant(P, sfx, ank, yaw, pitch, -pitch * 0.8, tag='Land')
    shoulders(P, l=(8, 0, -3 * imp), r=(2, 0, -3 * imp))
    Ma = low_ready(P, bob=V(0, 0.01 * imp, -0.012 * imp))
    hold(P, Ma, V(-0.6, 0.6, -0.4), V(0.7, 0.2, -0.7), tag='Land')


@clip('Jetpack', 1.2)
def clip_jetpack(P, t):
    T = 1.2
    w = cyc(t, T, 1, 0.0)
    w2 = cyc(t, T, 1, 0.3)
    body(P, V(0, 0.02, 1.02 + 0.012 * w), (-4, 9 + 1.5 * w2, 1.2 * w2), spine=(2, 2, 0), chest=(2, 1 - w, 0),
         neck=(0, -4, 0), head=(0, -5, 0))
    for sfx, sx, ph in (('_L', 1, 0.0), ('_R', -1, 0.18)):
        sw = cyc(t, T, 1, ph)
        ank = V(sx * 0.085, 0.07 + 0.025 * sw, 0.235 + 0.010 * sw)
        plant(P, sfx, ank, 6 * sx, -34 + 4 * sw, 4, tag='Jetpack', pole=V(sx * 0.1, -1, 0.15))
    shoulders(P, l=(6, 0, 2), r=(2, 0, 2))
    hold(P, ready(P, V(0, 0, 0.012 * w2)), V(-0.7, 0.5, -0.4), V(0.7, 0.2, -0.7), tag='Jetpack')


@clip('Dash', 0.35, loop=False)
def clip_dash(P, t):
    k = t / 0.35
    ant = bump(k, 0.10, 1.0) * (1 - smoothstep(0.15, 0.3, k))
    lunge = smoothstep(0.12, 0.40, k)
    rec = smoothstep(0.70, 1.0, k)
    L = lunge * (1 - 0.45 * rec)
    hz = 0.958 - 0.04 * ant - 0.165 * L
    body(P, V(0, 0.02 + 0.04 * L, hz), (-6 - 4 * L, -3 * ant + 24 * L, 0),
         spine=(2, 10 * L, 0), chest=(2, 8 * L, 0), neck=(0, -14 * L, 0), head=(0, -12 * L, 0))
    # front foot steps forward, rear foot pushes off onto its toes
    fl = V(0.120, -0.075 - 0.40 * L, ANKLE_Z)
    plant(P, '_L', fl, 8, 0, 0, tag='Dash')
    pr = -46 * L
    ball = V(-0.13, 0.075 + 0.46 * L, 0) + foot_rot(-10, 0) @ FOOT_BALL['_R']
    ball.z = 0.0
    ank = ankle_from_contact('_R', ball, -10, pr, 'ball') if pr < 0 else V(-0.135, 0.075, ANKLE_Z)
    plant(P, '_R', ank, -10, pr, -pr * 0.85, tag='Dash')
    shoulders(P, l=(8, 0, -2 * L), r=(2, 0, -2 * L))
    Ma = mat_lerp(low_ready(P), ready(P, V(0.03, 0.06, -0.03)), L)
    hold(P, Ma, V(-0.7, 0.6, -0.3), V(0.7, 0.4, -0.6), tag='Dash')


@clip('Interact', 0.8, loop=False)
def clip_interact(P, t):
    k = t / 0.8
    reach = smoothstep(0.18, 0.46, k) * (1 - smoothstep(0.66, 0.95, k))
    lower = smoothstep(0.02, 0.22, k) * (1 - smoothstep(0.80, 1.0, k))
    body(P, V(0.008 * reach, 0.012 - 0.02 * reach, 0.958 - 0.01 * reach), (-12 + 10 * reach, 2 + 3 * reach, 0),
         spine=(4 - 3 * reach, 1 + 3 * reach, 0), chest=(5 - 3 * reach, 1.2 + 4 * reach, 0),
         neck=(0, -2 + 6 * reach, 0), head=(4 + 6 * reach, -3 + 8 * reach, 0))
    stand_feet(P, 'Interact')
    shoulders(P, l=(8 + 10 * reach, 0, 2 * reach), r=(2, 0, 0))
    # rifle: one-handed low carry at the right side while the left hand reaches
    Ma = low_ready(P)
    side = rifle_matrix(V(-0.205, -0.140, 1.000), V(0.10, -0.80, -0.60), V(-0.6, 0, 0.8))
    Mb = chest_space(P, side)
    M = mat_lerp(Ma, Mb, lower * smoothstep(0.0, 0.6, reach + 0.3 * lower))
    Mh = M @ G_GRIP.inverted()
    ik(P, 'arm_R', Mh.translation, V(-0.7, 0.5, -0.4), 'Interact')
    P.set_world_rot('Hand_R', Mh.to_3x3().normalized())
    hand_pose(P, '_R', HANDS['grip_r'])
    # left hand: foregrip (at low ready) -> panel at chest height -> foregrip
    Mf = Ma @ G_FORE
    # hand flat-ish, palm down, index finger pointing forward onto the button
    yh = V(-0.10, -0.97, -0.20).normalized()       # along the hand: forward, slightly down
    zh = perp(V(0.25, 0.0, 1.0), yh)               # back of the hand up (thumb side toward the body centre)
    xh = yh.cross(zh)
    Rp = frame_xyz(xh, yh, zh)
    press = smoothstep(0.42, 0.52, k) * (1 - smoothstep(0.60, 0.70, k))
    button = V(0.035, -0.505 + 0.012 * press, 1.230)
    panel = Rp.to_4x4()
    panel.translation = button - Rp @ V(-0.033, L_HAND + 0.085, -0.006)
    reach_s = smoothstep(0.0, 1.0, reach)
    Ml = mat_lerp(Mf, panel, reach_s)
    ik(P, 'arm_L', Ml.translation, V(0.7, 0.4, -0.6), 'Interact')
    P.set_world_rot('Hand_L', Ml.to_3x3().normalized())
    hand_pose(P, '_L', blend_hand(HANDS['fore_l'], HANDS['point'], reach_s))


# ---- AirBass: slung rifle, groove, fretting and plucking an invisible bass
BASS_BRIDGE = V(-0.060, -0.185, 1.075)
BASS_NECK = V(0.90, -0.24, 0.37).normalized()


def bass_frame(P):
    """Bass placement (bridge point and neck/fingerboard axes); the strap hangs it from the chest."""
    D = P.delta('Chest')
    b = D @ BASS_BRIDGE
    n = (D.to_3x3() @ BASS_NECK).normalized()
    f = perp(D.to_3x3() @ V(0, -1, 0.25), n)       # fingerboard faces forward
    u = n.cross(f)                                  # across the strings
    return b, n, f, u


SLING = None


def sling_matrix():
    """Rifle hanging muzzle-down at the right side, behind the arm (rest-pose world terms)."""
    return rifle_matrix(V(-0.235, 0.080, 1.135), V(0.02, 0.16, -1.0), V(-1, 0.25, 0))


NOTES = [  # (beat time in beats, fret distance from the bridge along the neck, string 0..3, finger)
    (0.0, 0.665, 0, 'index'), (0.5, 0.665, 0, 'ring'), (1.0, 0.610, 1, 'index'), (1.5, 0.665, 0, 'index'),
    (2.0, 0.683, 1, 'index'), (2.5, 0.645, 1, 'ring'), (3.0, 0.610, 2, 'index'), (3.5, 0.640, 1, 'middle'),
]


@clip('AirBass', 2.0)
def clip_airbass(P, t):
    T = 2.0
    beat = t / T * 4.0                     # 4 beats per loop (120 bpm)
    bph = beat % 1.0
    nod = (math.cos(TAU * (bph - 0.10)) * 0.5 + 0.5) ** 1.8     # 1 just after the beat (laid-back groove)
    bar = cyc(t, T, 1, 0.0)
    bounce = (math.cos(TAU * (bph - 0.04)) * 0.5 + 0.5) ** 1.4
    hz = 0.938 - 0.026 * bounce
    body(P, V(0.020 * bar, 0.022, hz), (-22 + 3 * bar, -3, 2.5 * bar),
         spine=(7, -2 + 1.5 * bounce, -1.5 * bar), chest=(9, -2 + 2.5 * bounce, -2 * bar),
         neck=(0, 2 + 8 * nod, 0), head=(8 + 5 * bar, -2 + 20 * nod, 5 * bar))
    # feet: wide stance, right toe taps on beats 2 and 4
    tap = 0.0
    if 1 <= beat % 2 < 2:
        tap = bump((beat % 2) - 1.0, 0.25, 1.0)
    for sfx, base, yaw in (('_L', V(0.165, -0.085, ANKLE_Z), 18), ('_R', V(-0.150, 0.085, ANKLE_Z), -22)):
        if sfx == '_R' and tap > 0:
            pitch = 16 * tap                    # toes lift, heel stays down
            heel = base + foot_rot(yaw, 0) @ FOOT_HEEL[sfx]
            heel.z = 0.0
            ank = ankle_from_contact(sfx, heel, yaw, pitch, 'heel')
            plant(P, sfx, ank, yaw, pitch, -4 * tap, tag='AirBass')
        else:
            plant(P, sfx, base, yaw, 0, 0, tag='AirBass')
    shoulders(P, l=(16, 0, 3 + 2 * bounce), r=(-4, 0, 2 * bounce))
    b, n, f, u = bass_frame(P)
    # ---- left hand fretting: slides between note positions along the neck
    def note_at(bt):
        bt = bt % 4.0
        cur = NOTES[-1]
        for nt in NOTES:
            if nt[0] <= bt + 1e-6:
                cur = nt
        return cur
    cur = note_at(beat)
    nxt = note_at(beat + 0.5 - (beat % 0.5) + 1e-3)
    frac = (beat % 0.5) / 0.5
    slide = smoothstep(0.70, 1.0, frac)
    fret = lerp(cur[1], nxt[1], slide)
    string = lerp(cur[2], nxt[2], slide)
    neck_pt = b + n * fret
    # palm under the neck: fingers wrap up around the front onto the fingerboard, thumb behind the neck
    yh = (f * 0.80 - u * 0.40 + n * 0.12).normalized()
    zh = perp(u + f * 0.25, yh)
    xh = yh.cross(zh)
    Rl = frame_xyz(xh, yh, zh)
    wrist = neck_pt - yh * 0.058 + zh * 0.040 + u * (0.007 * string)
    ik(P, 'arm_L', wrist, V(0.6, 0.3, -0.75), 'AirBass')
    P.set_world_rot('Hand_L', Rl)
    press = 1.0 - smoothstep(0.55, 0.75, frac) * (1 - smoothstep(0.92, 1.0, frac))
    fp = {'index': (58, 80), 'middle': (54, 78), 'ring': (52, 78), 'thumb': (34, 30, 0, 0)}
    finger = cur[3]
    if finger == 'index':
        fp['index'] = (lerp(50, 72, press), lerp(70, 96, press))
    elif finger == 'middle':
        fp['middle'] = (lerp(48, 74, press), lerp(70, 98, press))
    else:
        fp['ring'] = (lerp(48, 78, press), lerp(70, 100, press))
    hand_pose(P, '_L', fp)
    # ---- right hand plucking near the pickups: index and middle alternate on eighth notes
    pick = b + n * 0.11
    eighth = (beat * 2.0) % 1.0
    which = int(beat * 2.0) % 2
    pl = bump(eighth, 0.18, 0.9)
    yr = (u * 0.88 + f * 0.12 - n * 0.22).normalized()          # fingers point down across the strings
    zr = perp(f + n * 0.2, yr)                                  # back of the hand faces the audience
    xr = yr.cross(zr)
    Rr = frame_xyz(xr, yr, zr)
    wr = pick - u * 0.098 + f * 0.030 + u * 0.014 * pl - f * 0.010 * pl
    ik(P, 'arm_R', wr, V(-0.8, 0.5, -0.1), 'AirBass')
    P.set_world_rot('Hand_R', Rr)
    ia = 24 + (62 * pl if which == 0 else 8 * pl)
    ma = 26 + (62 * pl if which == 1 else 8 * pl)
    hand_pose(P, '_R', {'index': (ia, 30 + 0.5 * (ia - 30)), 'middle': (ma, 30 + 0.5 * (ma - 30)),
                        'ring': (54, 70), 'thumb': (6, 10, 0, 0)})
    # ---- rifle slung: socket counter-animated so the rifle stays with the torso
    Mr = P.delta('Chest') @ sling_matrix()
    Ms = Mr @ CONV.inverted()
    P.set_world_rot('WeaponSocket', Ms.to_3x3().normalized())
    P.set_world_pos('WeaponSocket', Ms.translation)


def foot_contact_locals(rig):
    out = {}
    for sfx in ('_L', '_R'):
        R = rig.rest3['Foot' + sfx]
        out[sfx] = {'heel': list(R.transposed() @ FOOT_HEEL[sfx]), 'ball': list(R.transposed() @ FOOT_BALL[sfx])}
    return out


def animate(arm):
    rig = Rig(arm)
    rifle_frames()
    P0 = Pose(rig)
    clip_aim(P0, 0.0)
    AIM_CHEST[:] = P0.head('Chest')
    C.write_json('/tmp/claude-0/agent/foot_contacts.json', foot_contact_locals(rig))
    durations = {}
    arm.animation_data_create()
    for name, (fn, D, loop) in CLIPS.items():
        if ONLY_CLIPS and name not in ONLY_CLIPS:
            continue
        N = max(2, int(round(D * CLIP_FPS.get(name, FPS))))
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm.animation_data.action = act
        frames = []
        warns = []
        for i in range(N + 1):
            t = D * i / N
            if loop and i == N:
                t = 0.0
            P = Pose(rig)
            fn(P, t)
            warns += P.warn
            frames.append((dict(P.q), dict(P.t)))
        write_action(arm, act, rig, frames)
        durations[name] = D
        arm.animation_data.action = None
        msg = ('; '.join(sorted(set(w.split(' overreach')[0] for w in warns)))[:160]) if warns else 'ok'
        print('  clip %-11s %.3fs %3d frames  ik: %s' % (name, D, N + 1, msg))
        if warns:
            worst = max(float(w.split('overreach ')[1].split(' ')[0]) for w in warns)
            print('      worst overreach %.1f mm (%d frames)' % (worst, len(warns)))
    return durations


LOC_BONES = ('Hips', 'WeaponSocket')


def write_action(arm, act, rig, frames):
    prev = {}
    for n in rig.names:
        qs = []
        for qd, td in frames:
            q = qd[n].normalized()
            if n in prev and prev[n].dot(q) < 0:
                q = -q
            prev[n] = q
            qs.append(q)
        path = 'pose.bones["%s"].rotation_quaternion' % n
        for i in range(4):
            fc = act.fcurve_ensure_for_datablock(arm, path, index=i)
            fc.keyframe_points.add(len(qs))
            co = []
            for f, q in enumerate(qs):
                co += [float(f), q[i]]
            fc.keyframe_points.foreach_set('co', co)
            fc.update()
        if n in LOC_BONES:
            path = 'pose.bones["%s"].location' % n
            for i in range(3):
                fc = act.fcurve_ensure_for_datablock(arm, path, index=i)
                fc.keyframe_points.add(len(frames))
                co = []
                for f, (qd, td) in enumerate(frames):
                    co += [float(f), td[n][i]]
                fc.keyframe_points.foreach_set('co', co)
                fc.update()


if __name__ == '__main__':
    main()
