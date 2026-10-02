# Landmark specs

Every world has a flattened plateau (radius 100-150 m) around its main site. Landmarks sit on it at the layout positions in `game/world/layout.js`. All landmarks are built by `art/blender/landmarks.py` (shared helpers: `art/blender/common.py`) and exported **one GLB per world** plus a shared file:

- `public/models/landmarks-philosophy.glb`, `-experience.glb`, `-projects.glb`, `-mission.glb`, `-contact.glb`, `-shared.glb`

## Conventions (the game relies on these exactly)

- Every landmark is one top-level node whose name is the node name listed below (snake_case). Its origin is at ground level, at the center of its footprint.
- **Front**: the side the visitor approaches and reads from faces **-Y in Blender** (+Z in glTF/three.js). Visitors arrive from the front.
- Units are meters, +Z up in Blender. Bases extend about 0.3 m below z=0 so they never float on a slightly uneven plateau.
- Materials are referenced by slot name only. The game recolors per world, so pick good defaults from that world's palette in STYLE.md:
  `Stone`, `StoneDark`, `Trim`, `Accent`, `Glow` (emissive), `Metal`, `Glass`, plus `Wood` if needed.
- **POIs**: empties named `POI_<id>`, placed where a visitor stands to interact. Put them about 1.5-3 m in front of the thing, at z=0.
- **Labels**: empties named `LABEL_<id>`, placed where the game should float a title, usually 1-2 m above the object's top front.
- **Animated parts**: sub-objects named `ANIM_SPIN_<name>` (the game spins them about local up), `ANIM_BOB_<name>` (gentle vertical bob) or `ANIM_PULSE_<name>` (emissive pulse). Origins go at their pivots.
- **Colliders** are invisible proxy meshes. The game hides them and builds physics from their transform and bounding box:
  - `COL_BOX_<anything>`: oriented box. The top is walkable.
  - `COL_CYL_<anything>`: vertical cylinder. Radius comes from the x/y bounding box, height from z. The top is walkable.
  - Steps and stairs are boxes up to 0.45 m high (auto step-up).
  - Keep proxies simple and slightly smaller than the visuals. Never block POIs or the front approach.
- Triangle budget per landmark is ≤ 15k (main archives ≤ 25k). Prefer bevelled chunky forms and color blocking over tiny details.
- Text is never modelled. The game renders all text. Numerals and glyphs can be abstract shapes.
- Everything must be original. Where a landmark nods to something real (a concert hall, a lighthouse), keep it generic and stylized, never a replica.

## Shared (`landmarks-shared.glb`)
- `landing_pad`: a circular ship pad, 14 m across and 0.25 m high, with a soft bevel. It has painted ring markings in an inset `Trim` ring, four short light posts with `Glow` tops at the rim, and a chevron pointing +Y (the back). Add `POI_board` 5 m to one side. Colliders: one flat `COL_CYL_pad`.
- `essay_plinth`: a waist-high (1.1 m) tapered stone plinth with a floating open book above it, with `Glow` pages and the book as `ANIM_BOB_book`. Add `POI_read` in front and `LABEL_title` above.
- `archive_console`: a small standalone reading console, 1.3 m tall with an angled glowing screen. Add `POI_read` and `LABEL_title`.

## Philosophy (`landmarks-philosophy.glb`): calm, sacred, luminous
Palette: ivory stone (`Stone` #e6ece6), deep teal stone (`StoneDark` #2f5d5a), `Trim` teal #8cf0d1, `Accent` warm gold #e8c27a, and `Glow` #8cf0d1.
- `origin_monument` (the main archive, "The Origin"): a 3-step circular plinth, 15 m across, with steps 0.35 m high. It carries a monumental open triangular frame made of three thick, bevelled ivory beams, about 13 m tall (an equilateral triangle standing upright). A smaller inner triangular prism floats and spins in the frame: `ANIM_SPIN_core`, `Glow` edges with a `Glass` body. A short vertical stem and a crossbar sit under the triangle, echoing the site's logo mark (a triangle above a small cross). Add inset `Trim` light lines on the steps, `POI_archive` at the front of the plinth and `LABEL_title` above the frame. Colliders: the steps as stacked cylinders and the beam legs as boxes.
- `pillar_health`, `pillar_family`, `pillar_mission`: three different monumental pillars, each about 9 m tall on a 3 m square stepped base.
  - Health ("I / the foundation"): broad and grounded, with a stacked-stone feel and a smooth sphere crowning it.
  - Family ("II / the center"): two interlocking rings at the top, as `ANIM_SPIN_rings`.
  - Mission ("III / the fire"): a faceted flame-like crystal crown, as `ANIM_PULSE_flame` (`Glow`).
  Each has a recessed plaque area where the game draws a roman numeral, plus `POI_read` and `LABEL_title`.
- `depth_span`: an installation about 24 m wide. It has a raised circular "well" ring (8 m across) whose inner disc is dark (`StoneDark`) with concentric glowing rings stepping down (illusion of depth), and a long graceful arch ("span") crossing over the well from one side to the other, 9 m high. Add `POI_read` and `LABEL_title`. Colliders: the ring rim (several boxes or one cylinder ring approximation) and the arch feet.
- `filter_stones`: five standing stones (2.4 to 3.6 m, slightly varied, gently curving line about 22 m long along x), each with a carved inset holding a glowing glyph (an abstract mark, numbered 1-5 by shape complexity). Add `POI_read` at the middle stone and `LABEL_title`.
- `reading_pavilion`: an open pavilion with 4 slender columns (about 5.5 m) and a gently curved roof slab, 9 x 7 m. Inside are three lecterns, each holding a glowing book (`ANIM_BOB_book_0..2`). Add `POI_essay_0`, `POI_essay_1` and `POI_essay_2` in front of each lectern, plus `LABEL_title`. Colliders: columns and lecterns. The floor slab is a walkable box 0.3 m high.

## Experience (`landmarks-experience.glb`): warm copper, theatre and workshop
Palette: terracotta stone (`Stone` #d9a07a), `StoneDark` #6e3a30, brass `Trim` #f0c27a, `Accent` coral #f0744e, `Glow` amber #ff9a62, and `Metal` dark bronze #4a3a33.
- `arc_gate` (the main archive, "The Arc"): a huge bevelled arch spanning 26 m and 22 m tall, made of three parallel stacked bands (front, middle, back) like layered stages. It has inset `Glow` lines along its curve and an `archive_console`-like reading lectern at its base center. Add `POI_archive` and `LABEL_title`. Colliders: the two feet.
- `bass_stage` ("The bass years"): an outdoor concert stage with a ribbed quarter-dome shell (art-deco feeling with concentric arches; generic, not a replica of any real hall), about 16 m wide and 10 m tall.
  - The stage platform is 14 x 8 m and 1 m high, with front steps and two speaker stacks.
  - Center stage holds a giant stylized electric bass guitar sculpture, about 8 m tall, standing upright on a stand. It is original: a long neck, 4 strings as thin `Glow` lines, and a body with an offset-waist shape.
  - Eight glowing note pads (1.2 m square tiles, `ANIM_PULSE_pad_0..7`) are set into the stage floor in a row. Put `POI_pad_0..7` at each pad center (on top of the platform: z = platform top).
  - Add `POI_read` at the stage front (on the ground) and `LABEL_title`.
  - Colliders: the platform as a walkable box, the steps as boxes, plus the speakers, the bass stand and the shell walls.
- `arena` ("The arena years"): a circular arena 26 m across with a 1.2 m perimeter wall, two entrance gaps (front and back), four corner pillars with `Glow` caps and a scoreboard monolith at the back. Add `SPAWN_target_0..7` empties floating 2-6 m high, spread inside, `POI_arena` at the front entrance and `LABEL_title`. Colliders: wall segments and pillars.
- `workshop` ("The build years"): a compact workshop/foundry with a monolithic server tower about 12 m tall (with glowing vertical slits), a sturdy workbench, two crates, a small satellite dish and cables. Add `POI_read` and `LABEL_title`.
- `tool_glyphs`: five low pedestals (0.9 m) in a gentle arc about 12 m wide, each with a different floating abstract glyph (a hexagon knot, two interlocking brackets, a flame-ish loop, a node graph, a shield). Each glyph is `ANIM_SPIN_glyph_0..4`. Add `LABEL_glyph_0..4`, `POI_read` and `LABEL_title`.

## Projects (`landmarks-projects.glb`): violet crystal frontier, a maker's workshop
Palette: `Stone` #8d7fbf, `StoneDark` #2c2742, `Trim` #e2b8ff, `Accent` #8fd9ff, `Glow` #e2b8ff, `Glass` violet-tinted, and `Metal` #3d3557.
- `workshop_core` (the main archive, "The Workshop"): a hexagonal raised platform 16 m across with a ring of six slim tech pylons. A large faceted crystal core floats above the center, as `ANIM_SPIN_core` / `ANIM_BOB_core`, and a holographic ring circles it (`ANIM_SPIN_ring`, `Glow`). Add `POI_archive` and `LABEL_title`.
- `project_beacn`: a slender 14 m tower topped by a big emblem: an outer circle with two separated inner arcs (inside, opposite each other). The emblem uses `Glow` with `Trim`, with `ANIM_SPIN_emblem` slow. Add `POI_read` and `LABEL_title`.
- `project_heard`: a 10 m sculpture of a central pillar with concentric sound-wave arcs radiating from it to one side (like a voice carrying), in navy (`StoneDark`) and gold (`Accent` overridden in game to gold). Add `POI_read` and `LABEL_title`.
- `project_crystal_0` ... `project_crystal_4`: five distinct crystal monoliths, 6-8 m on small tech bases, each with a slowly spinning holo ring. Vary them: a single tall shard, a twin shard, a cluster, a split geode and a stacked prism. Add `POI_read` and `LABEL_title` on each.
- `build_log`: a terminal kiosk 2 m tall with a floating holographic screen panel. Add `POI_read` and `LABEL_title`.

## Mission (`landmarks-mission.glb`): azure ocean world, an observatory at the edge
Palette: white stone (`Stone` #e9eef4), `StoneDark` #3b5f86, `Trim` #83e8ff, `Accent` #f0744e, `Glow` #83e8ff, `Metal` #4a5566 and `Glass` blue.
- `observatory` (the main archive, "The Horizon"): a domed observatory 12 m across, its dome opened by a slit, with a large telescope tube angled up out of the slit. A slender lighthouse tower about 22 m tall is attached beside it, with a glowing lamp room (`ANIM_PULSE_lamp`). Add a short entry stair and `POI_archive` at the entrance, plus `LABEL_title`.
- `principle_beacon_0..3`: slender beacon pylons about 12 m tall with glowing tops (`ANIM_PULSE_top`). They stand on tall sea stacks in the game, so the base is a simple flared foot. Add `LABEL_title`. There are no POIs on these.
- `principle_lens_0..3`: small cliff-edge plinths (1 m) with a tilted lens/telescope pointing out to sea. These are where visitors read each principle. Add `POI_read` and `LABEL_title`.
- `long_view_bench`: a stone bench and a small leaning monument stone overlooking the sea. Add `POI_read` and `LABEL_title`.

## Contact (`landmarks-contact.glb`): golden outpost, signals across the dunes
Palette: sandstone (`Stone` #e2c08f), `StoneDark` #7a4330, brass `Trim` #ffd27a, `Accent` #f0744e, `Glow` #ffd27a, `Metal` #5a4636.
- `signal_dish` (the main archive, "The Signal"): a giant radio dish 18 m across tilted toward the sky, on a rotating yoke mount and a concrete base. It has a small control hut with a door and window, a glowing beacon at the receiver tip (`ANIM_PULSE_beacon`) and cables. Add `POI_archive` and `LABEL_title`.
- `contact_antenna_0..3`: four distinct 6-8 m antennas.
  - 0 "email": a tower carrying a stylized envelope-shaped transmitter panel.
  - 1 "github": a branching tree-like antenna, its branches forking like a version graph.
  - 2 "linkedin": a lattice tower with linked rings.
  - 3 "public square": a horn/megaphone array.
  Each has `POI_read` and `LABEL_title`.
- `closing_monolith`: a 5 m sunset-facing monolith with a recessed panel (the game writes the closing line on it) and a soft `Glow` seam. Add `POI_read` and `LABEL_title`.
