# Agent spec: the playable explorer

The explorer is **an original hero-shooter-style agent who represents Max**, the site owner: a former touring bassist turned software engineer who now builds toward AI safety. The look must be **original**. It must not resemble any existing game character, and in particular no Valorant agent; borrow only the general quality bar of stylized hero shooters.

## Design
- Male, athletic, heroic proportions: about 1.86 m tall and 7.5 heads. Broad shoulders, slim waist, slightly oversized hands and boots for readability. The silhouette must read instantly from behind at 6 m, since this is a third-person game camera.
- **Helmet with full visor**: no visible face. A sleek, slightly angular helmet with a large wraparound glossy visor (`Visor`, dark teal, with a faint `Glow` rim line). On each side, built into the helmet, sit over-ear **headphone-style comm pods** with glowing ring accents (the musician motif).
- **Jacket**: a cropped tech-wear field jacket in ivory (`Suit`) with a tall asymmetric collar and coral (`Accent`) lining and accent panels. Sleeves end at the gloves with cuffs. Add a few large readable panel seams, not lots of small detail.
- **Bass-strap harness**: a wide strap crossing the chest diagonally from the left shoulder to the right hip (navy `SuitDark`) with a small metal buckle. It is a nod to a bass guitar strap.
- **Back unit, the "resonance pack"**: a compact, rounded backpack with a circular speaker-cone face (concentric rings, `Glow` center) and two small thruster nozzles at its bottom. These are the jetpack.
- Lower body: fitted navy (`SuitDark`) cargo pants with ivory knee guards, chunky boots (`Rubber` soles, `Suit`/`SuitDark` uppers, coral pull tabs) and gloves (`SuitDark` with `Metal` knuckle plates).
- **Rifle**: a compact, original stylized pulse rifle about 0.95 m long. Ivory and navy body, a coral accent stripe, a glowing teal energy cell and a muzzle ring. It has an empty `Muzzle` at the barrel tip (+Z is the firing direction in glTF).
- Palette: ivory #e9e4d5, navy #1a2433, coral #f0744e, teal glow #8cf0d1, gunmetal #5d6b75 and rubber #14191f.
- Material slot names (exact): `Suit`, `SuitDark`, `Fabric`, `Accent`, `Visor`, `Glow`, `Metal`, `Rubber`.
- Triangle budget: ≤ 25k for the agent plus the rifle.

## Rig (exact names; no dots, since three.js strips them)
`Root` → `Hips` → `Spine` → `Chest` → `Neck` → `Head`
`Chest` → `Shoulder_L` → `UpperArm_L` → `LowerArm_L` → `Hand_L` (and the same for `_R`)
`Hips` → `UpperLeg_L` → `LowerLeg_L` → `Foot_L` → `Toe_L` (and the same for `_R`)
Extra bones:
- `WeaponSocket` is a child of `Hand_R`. The rifle mesh is parented to this bone in Blender, so it is exported as a child of the bone in glTF.
- `Jet_L` and `Jet_R` are children of `Chest`, at the thruster nozzle exits and pointing down/backward.

Skin with at most 4 influences per vertex. Rigid hard-surface pieces (helmet, armor, rifle, pack) are 100% weighted to one bone. Joints need clean deformation (shoulders, elbows, hips, knees) and must hide interpenetration with overlapping pads/cuffs.

## Orientation and scale
Feet sit at z=0 and the character faces **-Y in Blender** (glTF +Z). Meters. Rest pose is a relaxed A-pose (arms about 45° down) or similar. Export `Root` at the origin.

## Animations (exact clip names; in place, no root motion; 30 fps)
Hold the rifle in both hands in every combat clip: right hand on the grip, left hand on the foregrip. The rifle stays roughly aligned with the camera aim when the clip says "aim".

| Clip | Loop | Duration | Notes |
|---|---|---|---|
| `Idle` | yes | ~3.0 s | Low-ready rifle, weight shift, breathing, a slight head look |
| `Walk` | yes | 1.0 s cycle | Matches 2.4 m/s with no foot sliding; rifle at low ready |
| `Run` | yes | ~0.72 s cycle | Matches 6.0 m/s; rifle at ready, slight forward lean |
| `Sprint` | yes | ~0.56 s cycle | Matches 9.5 m/s; rifle held across the chest, strong arm swing on the free arm (left hand may leave the foregrip), stronger lean |
| `StrafeLeft` / `StrafeRight` | yes | ~0.72 s | Side-stepping at 5 m/s, upper body facing forward, aiming |
| `Backpedal` | yes | ~0.8 s | Walking backward at 3.5 m/s while aiming |
| `JumpStart` | no | 0.25 s | Crouch-and-launch |
| `Fall` | yes | 0.8 s | Airborne, knees slightly tucked, subtle flailing |
| `Land` | no | 0.35 s | Impact squat and recovery to idle stance |
| `Jetpack` | yes | 1.2 s | Hovering, legs together and slightly bent, body slightly forward |
| `Dash` | no | 0.35 s | Explosive forward lunge, low and fast |
| `Fire` | no | 0.18 s | Aimed pose with a sharp recoil kick and recovery (the upper body matters; the game layers it over locomotion) |
| `Aim` | yes | 1.0 s | Rifle shouldered, sighting forward, a subtle breathing sway |
| `AirBass` | yes | ~2.0 s | Emote: the agent slings the rifle and **mimes playing bass guitar** (left hand fretting up and down an invisible neck, right hand plucking, head nodding to the groove). Hide nothing; the rifle stays in `WeaponSocket` but is posed out of the way (e.g. hanging down) |
| `Interact` | no | 0.8 s | Reaching forward to touch a console or panel at chest height |

Cycle feet so the contact frames land at sensible beats (contact, down, passing, up). Pose arcs must be readable at game distance: exaggerate a little, in hero-shooter style.
