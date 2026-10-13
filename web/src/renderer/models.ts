/**
 * The procedural models: flora, buildings, the props on the ground.
 *
 * HANDOFF §7.5 — everything is procedural, and this is where the geometry that
 * is not terrain comes from. Two tiers, chosen once at start-up (§7.3):
 *
 * - **Tier 1** is the set of primitives the game shipped with — a cone is a
 *   conifer, a box is a house — because the reference floor of §7.6 is an
 *   office machine with integrated graphics and a forest is up to 8,700
 *   instances. The flora is kept here verbatim — shown by the model gallery,
 *   though the game itself builds no flora at tier 1 (vegetation is a tier-2
 *   feature, §7.3). The buildings are still blocks, each now under a roof in
 *   its owner's colour, so a tier-1 village says whose it is.
 * - **Tier 2** is the same silhouettes with the detail that makes them read as
 *   the thing rather than as the primitive: a trunk under the crown, tiers on
 *   the conifer, a roof on the house, a chin on the villager. Every model here
 *   carries a triangle budget in its comment, and the budgets are chosen so
 *   that a fully grown planet at every cap is around 0.6 M triangles — a
 *   number integrated graphics rasterises comfortably, and only at tier 2.
 *
 * # Colour is a vertex attribute
 *
 * An `InstancedMesh` has one material and therefore one colour, which is why
 * every broadleaf used to be green from the ground up, trunk included. The
 * parts here carry a `color` attribute, merged by `mergeGeometries`, and the
 * material multiplies it by the per-instance tint: brown trunks, terracotta
 * roofs and green crowns in one draw call. Tier-1 flora carries no colour
 * attribute and its material keeps the single colour it always had.
 *
 * # The side's colour is a mask
 *
 * The per-instance tint is the owner's colour, and it used to land on every
 * vertex: the thatch, the door and the chimney of a village were all washed
 * amber or sky. Buildings, the magnet and the figure now carry a second
 * attribute, `team` (0..1, `teamPart`), and the settlement and walker shaders
 * put the owner's colour only where it says so — a pennant, a banner, a roof
 * cap, a tabard — and leave the rest the colour it was painted. See
 * `TEAM_MASK_GLSL` in `palette.ts`. Team parts are painted white, so the
 * colour on them is the side's at full strength.
 *
 * # Variants
 *
 * A forest of one model is a forest of clones however it is jittered. Each
 * species has two geometries; `vegetation.ts` picks per cell by hash. Two
 * instanced meshes per species is eight draw calls for the flora against a
 * ceiling of 150.
 */

import * as THREE from "three";
import { mergeGeometries, withTransform } from "./geometry";

export type ModelTier = 1 | 2;

// ---------------------------------------------------------------------------
// Part helpers
// ---------------------------------------------------------------------------

/** Paint every vertex of a part one colour, in the working (linear) space. */
export function tint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Mark a part as the owner's: the team mask, 0..1, read by `TEAM_MASK_GLSL`
 * (`palette.ts`). 1 takes the side's colour outright; a fraction blends it in,
 * which is how the magnet's obelisk is *a little* the owner's without its
 * banner losing the contrast.
 */
export function teamPart(geometry: THREE.BufferGeometry, amount = 1): THREE.BufferGeometry {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("team", new THREE.BufferAttribute(new Float32Array(count).fill(amount), 1));
  return geometry;
}

/** A 2D outline: `[x, y]` points in order, either winding. */
type Outline = readonly (readonly [number, number])[];
/** A triangulation of an outline, as index triples into it. */
type Caps = readonly (readonly [number, number, number])[];

/**
 * An outline extruded `depth` thick along z and centred on it, flat-shaded.
 *
 * `caps` triangulates the outline, by hand. The outlines here are a handful of
 * points and some are concave — a swallowtail, a roof chevron — so a fan will
 * not do, and three's `ExtrudeGeometry` brings `Shape`, the curve classes and
 * an ear-clipper with it: 29 kB of three for eleven triangles' worth of
 * cloth, enough to push the three chunk over Vite's 500 kB warning. Either
 * winding is accepted for both the outline and the caps; every face is wound
 * to its outward normal here.
 */
function slab(outline: Outline, caps: Caps, depth: number): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  /** One triangle facing `n`, whichever way round its corners were given. */
  const face = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3) => {
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const [p, q] = ab.cross(ac).dot(n) < 0 ? [c, b] : [b, c];
    for (const v of [a, p, q]) {
      position.push(v.x, v.y, v.z);
      normal.push(n.x, n.y, n.z);
    }
  };
  const at = (i: number, z: number): THREE.Vector3 => {
    const [x, y] = outline[i] ?? [0, 0];
    return new THREE.Vector3(x, y, z);
  };
  const front = new THREE.Vector3(0, 0, 1);
  const back = new THREE.Vector3(0, 0, -1);
  for (const [i, j, k] of caps) {
    face(at(i, depth / 2), at(j, depth / 2), at(k, depth / 2), front);
    face(at(i, -depth / 2), at(j, -depth / 2), at(k, -depth / 2), back);
  }
  // The sides: each edge's outward normal is to its right when the outline
  // runs counter-clockwise, to its left when it runs clockwise.
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i] ?? [0, 0];
    const [x1, y1] = outline[(i + 1) % outline.length] ?? [0, 0];
    area += x0 * y1 - x1 * y0;
  }
  const turn = area > 0 ? 1 : -1;
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const [x0, y0] = outline[i] ?? [0, 0];
    const [x1, y1] = outline[j] ?? [0, 0];
    const n = new THREE.Vector3((y1 - y0) * turn, (x0 - x1) * turn, 0).normalize();
    face(at(i, -depth / 2), at(j, -depth / 2), at(j, depth / 2), n);
    face(at(i, -depth / 2), at(j, depth / 2), at(i, depth / 2), n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  return g;
}

/**
 * Cloth, extruded `depth` thick and centred on z. Three cuts:
 *
 * - `pennant`: a triangle hoisted at x = 0 and flying toward +x, top at y = 0.
 *   8 triangles.
 * - `flag`: a swallowtail flying toward +x, the same hoist. 16 triangles.
 * - `banner`: a swallowtail hanging from y = 0, centred on x — the shape that
 *   hangs on a wall or from a crossbar. 16 triangles.
 *
 * Extruded rather than a double-sided quad: every material here is
 * `FrontSide`, and a quad seen from behind is not there.
 */
function cloth(
  cut: "pennant" | "flag" | "banner",
  w: number,
  h: number,
  depth = 0.025,
): THREE.BufferGeometry {
  if (cut === "pennant") {
    return slab(
      [
        [0, 0],
        [0, -h],
        [w, -h / 2],
      ],
      [[0, 1, 2]],
      depth,
    );
  }
  if (cut === "flag") {
    // The notch is the fourth point; the three triangles fan round it.
    return slab(
      [
        [0, 0],
        [0, -h],
        [w, -h],
        [w * 0.72, -h / 2],
        [w, 0],
      ],
      [
        [0, 1, 3],
        [1, 2, 3],
        [0, 3, 4],
      ],
      depth,
    );
  }
  return slab(
    [
      [-w / 2, 0],
      [-w / 2, -h],
      [0, -h * 0.74],
      [w / 2, -h],
      [w / 2, 0],
    ],
    [
      [0, 1, 2],
      [0, 2, 4],
      [2, 3, 4],
    ],
    depth,
  );
}

/**
 * A cross-section run along x: `outline` is `(z, y)` points, `caps` its
 * triangulation, extruded `length` and centred. A gable wall, a roof chevron,
 * anything that is the same shape from end to end. `n` points cost
 * `2n + 2(n - 2)` triangles.
 */
function profile(outline: Outline, caps: Caps, length: number): THREE.BufferGeometry {
  const g = slab(outline, caps, length);
  // Drawn in xy and extruded along z; a quarter turn about y puts the
  // extrusion along x and the drawing's x along z (mirrored, which a symmetric
  // outline does not notice).
  g.rotateY(Math.PI / 2);
  return g;
}

/**
 * A four-sided roof, `w` by `d` at the eaves and `h` tall, standing on y = 0.
 * Open underneath: the box it sits on closes it. 4 triangles.
 */
function pyramid(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, true);
  // A four-sided cone has a corner on +z; a quarter of a quarter turn puts its
  // edges square to the box under it.
  g.rotateY(Math.PI / 4);
  g.scale(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

/**
 * Shade each face of an unlit part by which way it faces: brighter toward the
 * top, a step apart between neighbours. A `MeshBasicMaterial` has no light to
 * pick out facets with, and a crystal without facets is a flat diamond-shaped
 * sticker. Non-indexed, flat-normalled geometry only — every polyhedron three
 * builds at detail 0 is.
 */
function facetShade(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geometry.getAttribute("normal");
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const shade = 0.66 + 0.3 * (n.getY(i) * 0.5 + 0.5) + (n.getX(i) * n.getZ(i) > 0 ? 0.06 : -0.02);
    colors.fill(Math.min(1, shade), i * 3, i * 3 + 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * A box whose top face is `taper` times the size of its bottom face. Standing
 * on y = 0. The one shape that turns a stack of boxes into a body: a finger, a
 * chimney, an obelisk and a torso are all boxes that are narrower at one end.
 */
export function taperedBox(w: number, h: number, d: number, taper: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * taper);
      p.setZ(i, p.getZ(i) * taper);
    }
  }
  g.translate(0, h / 2, 0);
  // The side faces are no longer vertical; the box's baked normals are wrong
  // for them, and every face has its own vertices so flat shading survives.
  g.computeVertexNormals();
  return g;
}

/** Move, turn and scale a part in one call. Rotation is applied Z, X, Y. */
export function at(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rot: readonly [number, number, number] = [0, 0, 0],
  scale: number | readonly [number, number, number] = 1,
): THREE.BufferGeometry {
  const [sx, sy, sz] = typeof scale === "number" ? [scale, scale, scale] : scale;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], "ZXY")),
    new THREE.Vector3(sx, sy, sz),
  );
  geometry.applyMatrix4(m);
  return geometry;
}

/** A solid of revolution from a `(radius, height)` profile, base at the first point. */
function lathe(
  profile: readonly (readonly [number, number])[],
  segments: number,
): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, segments);
}

// ---------------------------------------------------------------------------
// Palette. Lighter than they look like they should be, for the reason
// `vegetation.ts` gives: at this ambient level a dark albedo goes black.
// ---------------------------------------------------------------------------

const BARK = 0x7a5a3a;
const BARK_PALE = 0xa08a66;
const NEEDLE = 0x36802a;
const LEAF = 0x4f9c33;
const FROND = 0x67a83c;
const SCRUB_GREEN = 0x5c7a2c;
const COCONUT = 0x6b4a2a;
const WALL = 0xe8dcc2;
const THATCH = 0xc9a86a;
const TILE = 0xb85c3a;
const STONE = 0xb9b3a4;
const STONE_DARK = 0x948e80;
const DOOR = 0x5a3d26;
const TIMBER = 0x6e4c30;
const MARBLE = 0xf0ece2;
/** Team parts: white, so the side's colour arrives at full strength. */
const CLOTH = 0xffffff;

// ---------------------------------------------------------------------------
// Flora
// ---------------------------------------------------------------------------

/** Species order, shared with `vegetation.ts`. */
export const SPECIES = { conifer: 0, broadleaf: 1, palm: 2, scrub: 3 } as const;

export interface FloraModels {
  /** `[species][variant]`. One geometry per species at tier 1, two at tier 2. */
  geometries: THREE.BufferGeometry[][];
  /**
   * Material colour per species. White where the geometry carries its own
   * colours, so the vertex colour is the colour.
   */
  colours: number[];
}

export function floraModels(tier: ModelTier): FloraModels {
  if (tier < 2) {
    return {
      geometries: [[coniferTier1()], [broadleafTier1()], [palmTier1()], [scrubTier1()]],
      colours: [NEEDLE, LEAF, FROND, SCRUB_GREEN],
    };
  }
  return {
    geometries: [
      [conifer(3, 0.34, 1.0), conifer(4, 0.27, 1.12)],
      [broadleaf(false), broadleaf(true)],
      [palm(0.13, 1.0), palm(0.24, 0.82)],
      [scrub(false), scrub(true)],
    ],
    colours: [0xffffff, 0xffffff, 0xffffff, 0xffffff],
  };
}

// --- tier 1: the shipped primitives, verbatim -------------------------------

function coniferTier1(): THREE.BufferGeometry {
  // A cone this slender reads as a conifer; a fatter one reads as a traffic
  // cone. Open-ended: the base is never visible.
  const g = new THREE.ConeGeometry(0.3, 1.0, 5, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

function broadleafTier1(): THREE.BufferGeometry {
  return mergeGeometries([
    withTransform(new THREE.CylinderGeometry(0.07, 0.11, 0.52, 5, 1, true), (g) =>
      g.translate(0, 0.26, 0),
    ),
    withTransform(new THREE.IcosahedronGeometry(0.42, 0), (g) => {
      g.scale(1.0, 0.78, 1.0);
      g.translate(0, 0.74, 0);
    }),
  ]);
}

function palmTier1(): THREE.BufferGeometry {
  const fronds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.PlaneGeometry(0.24, 0.86);
    frond.translate(0, -0.43, 0);
    frond.rotateX(-Math.PI / 2);
    frond.rotateZ(0.55);
    frond.rotateY((i / 6) * Math.PI * 2);
    frond.translate(0, 0.92, 0);
    fronds.push(frond);
  }
  return mergeGeometries([
    withTransform(new THREE.CylinderGeometry(0.045, 0.075, 0.94, 4, 1, true), (g) => {
      g.translate(0, 0.47, 0);
      g.rotateZ(0.13);
    }),
    ...fronds,
  ]);
}

function scrubTier1(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.55, 0.4, 6, 1, true);
  g.translate(0, 0.2, 0);
  return g;
}

// --- tier 2 -----------------------------------------------------------------

/**
 * A conifer: a trunk and `tiers` stacked, open cones, each set a little off
 * the axis so the tree is not a spindle. ~40 triangles at three tiers.
 */
function conifer(tiers: number, spread: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    tint(at(new THREE.CylinderGeometry(0.03, 0.065, 0.36, 5, 1, true), 0, 0.18, 0), BARK),
  ];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = spread * (1 - t * 0.62);
    const h = 0.42 * height * (1 - t * 0.18);
    const base = 0.16 + t * 0.66 * height;
    // A hash of the tier index, so the offsets differ between the two variants.
    const wobble = ((i * 37 + tiers * 11) % 7) / 7 - 0.5;
    parts.push(
      tint(
        at(new THREE.ConeGeometry(r, h, 7, 1, true), wobble * 0.05, base + h / 2, -wobble * 0.04),
        NEEDLE,
      ),
    );
  }
  return mergeGeometries(parts);
}

/**
 * A broadleaf: a trunk that flares at the root, two branches, a crown made of
 * one large lobe and two small ones so the outline is not a ball. ~170
 * triangles. `wide` is the variant that spreads rather than rises.
 */
function broadleaf(wide: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    tint(
      lathe(
        [
          [0.17, 0],
          [0.1, 0.06],
          [0.075, 0.3],
          [0.06, 0.58],
        ],
        6,
      ),
      BARK,
    ),
  ];
  const branches: [number, number][] = wide
    ? [
        [0.55, 0.9],
        [-0.7, 2.6],
      ]
    : [
        [0.4, 0.4],
        [-0.5, 3.4],
      ];
  for (const [lean, turn] of branches) {
    parts.push(
      tint(
        at(
          new THREE.CylinderGeometry(0.02, 0.04, 0.34, 4, 1, true),
          Math.sin(turn) * 0.12,
          0.62,
          Math.cos(turn) * 0.12,
          [lean, 0, 0],
        ),
        BARK,
      ),
    );
  }
  const crownY = wide ? 0.7 : 0.78;
  const crown: [number, number, number] = wide ? [1.25, 0.66, 1.25] : [1.0, 0.82, 1.0];
  parts.push(
    tint(at(new THREE.IcosahedronGeometry(0.4, 1), 0, crownY, 0, [0, 0.4, 0], crown), LEAF),
  );
  const lobes: [number, number, number][] = wide
    ? [
        [0.36, 0.6, 0.12],
        [-0.3, 0.64, -0.22],
        [0.05, 0.62, 0.36],
      ]
    : [
        [0.26, 0.62, 0.1],
        [-0.22, 0.68, -0.18],
      ];
  for (const [x, y, z] of lobes) {
    parts.push(
      tint(at(new THREE.IcosahedronGeometry(0.22, 0), x, y, z, [0.3, 0.7, 0.1], [1, 0.8, 1]), LEAF),
    );
  }
  return mergeGeometries(parts);
}

/**
 * A palm: a trunk that leans and curves, ringed where the old fronds fell,
 * seven bent fronds and three coconuts. ~100 triangles.
 */
function palm(lean: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segments = 5;
  const segH = (0.94 * height) / segments;
  let x = 0;
  let y = 0;
  let angle = lean * 0.3;
  for (let i = 0; i < segments; i++) {
    // The lean grows along the trunk, so it curves rather than tilts.
    angle = lean * (0.3 + (i / segments) * 1.4);
    const rBot = 0.075 - i * 0.006;
    const rTop = rBot - 0.008;
    // Alternating radius steps read as the rings left by shed fronds.
    const ring = i % 2 === 0 ? 1.0 : 0.88;
    parts.push(
      tint(
        at(
          new THREE.CylinderGeometry(rTop * ring, rBot, segH, 5, 1, true),
          x + Math.sin(angle) * segH * 0.5,
          y + Math.cos(angle) * segH * 0.5,
          0,
          [0, 0, -angle],
        ),
        i % 2 === 0 ? BARK_PALE : BARK,
      ),
    );
    x += Math.sin(angle) * segH;
    y += Math.cos(angle) * segH;
  }
  // Fronds: two quads each, the outer one drooping further, pivoted at the stem.
  for (let i = 0; i < 7; i++) {
    const turn = (i / 7) * Math.PI * 2 + 0.3;
    const droop = 0.5 + ((i * 5) % 3) * 0.12;
    const inner = new THREE.PlaneGeometry(0.2, 0.42);
    inner.translate(0, -0.21, 0);
    inner.rotateX(-Math.PI / 2 + droop);
    const outer = new THREE.PlaneGeometry(0.16, 0.44);
    outer.translate(0, -0.22, 0);
    outer.rotateX(-Math.PI / 2 + droop + 0.55);
    outer.translate(0, -Math.cos(droop) * 0.42 * 0.5, -Math.sin(droop) * 0.42);
    for (const f of [inner, outer]) {
      f.rotateY(turn);
      f.translate(x, y, 0);
      parts.push(tint(f, FROND));
    }
  }
  for (let i = 0; i < 3; i++) {
    const turn = i * 2.1;
    parts.push(
      tint(
        at(
          new THREE.OctahedronGeometry(0.045, 0),
          x + Math.sin(turn) * 0.06,
          y - 0.05,
          Math.cos(turn) * 0.06,
        ),
        COCONUT,
      ),
    );
  }
  return mergeGeometries(parts);
}

/** Scrub: three pressed lumps, never a trunk. 40 triangles. `flat` hugs the ground. */
function scrub(flat: boolean): THREE.BufferGeometry {
  const lumps: [number, number, number, number][] = flat
    ? [
        [0, 0.1, 0, 0.42],
        [0.3, 0.08, 0.1, 0.3],
      ]
    : [
        [0, 0.16, 0, 0.4],
        [0.26, 0.1, -0.14, 0.26],
      ];
  return mergeGeometries(
    lumps.map(([x, y, z, r]) =>
      tint(
        at(new THREE.IcosahedronGeometry(r, 0), x, y, z, [0.2, x * 3, 0.1], [1.25, 0.6, 1.25]),
        SCRUB_GREEN,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface BuildingModels {
  /**
   * Hut, house, keep, wall segment and citadel — one geometry each, about a
   * unit footprint (the citadel is wider: it is a compound, not a building).
   */
  hut: THREE.BufferGeometry;
  house: THREE.BufferGeometry;
  tower: THREE.BufferGeometry;
  wall: THREE.BufferGeometry;
  citadel: THREE.BufferGeometry;
  /** White: every model here carries vertex colours. */
  colour: number;
}

/**
 * Every settlement model, with its team parts marked.
 *
 * What a side's colour is *on* decides whether it reads from orbit, where the
 * camera mostly looks down: a flag seen from above is a line. So each model
 * carries its colour twice — on something that flies (pennant, banner, flag)
 * for the oblique view near the limb, and on something that faces the sky (a
 * roof cap, a ridge, a turret roof) for the view straight down.
 */
export function buildingModels(tier: ModelTier): BuildingModels {
  if (tier < 2) {
    // Blocks, as tier 1 always was, but each under a pyramid roof in the side's
    // colour: a box alone said neither "building" nor whose. 16 triangles a
    // block, 28 for the citadel's two, and the wall stays a plain slab.
    const block = (w: number, h: number, d: number, roof: number): THREE.BufferGeometry[] => [
      tint(at(new THREE.BoxGeometry(w, h, d), 0, h / 2, 0), WALL),
      teamPart(tint(at(pyramid(w * 1.12, roof, d * 1.12), 0, h, 0), CLOTH)),
    ];
    return {
      hut: mergeGeometries(block(0.9, 0.6, 0.9, 0.45)),
      house: mergeGeometries(block(1.0, 0.65, 0.8, 0.42)),
      tower: mergeGeometries(block(0.6, 1.15, 0.6, 0.38)),
      wall: mergeGeometries([tint(at(new THREE.BoxGeometry(1.0, 0.3, 0.16), 0, 0.15, 0), STONE)]),
      citadel: mergeGeometries([
        tint(at(new THREE.BoxGeometry(1.2, 0.5, 1.2), 0, 0.25, 0), STONE),
        ...block(0.55, 1.25, 0.55, 0.4),
      ]),
      colour: 0xffffff,
    };
  }
  return {
    hut: hut(),
    house: house(),
    tower: keep(),
    wall: wallSegment(),
    citadel: citadel(),
    colour: 0xffffff,
  };
}

/** A thin pole of `h` standing on `(x, y, z)`: four sides, open. 8 triangles. */
function pole(x: number, y: number, z: number, h: number): THREE.BufferGeometry {
  return tint(at(new THREE.CylinderGeometry(0.016, 0.02, h, 4, 1, true), x, y + h / 2, z), TIMBER);
}

/**
 * Merlons along a square parapet of half-width `half` at height `y`: one on
 * every corner, and one mid-side when `mid`. 12 triangles each.
 */
function battlements(half: number, y: number, size: number, mid: boolean): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    parts.push(
      tint(at(new THREE.BoxGeometry(size, size, size), sx * half, y + size / 2, sz * half), STONE),
    );
  }
  if (mid) {
    for (const [sx, sz] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      parts.push(
        tint(
          at(
            new THREE.BoxGeometry(sx === 0 ? size : size * 0.7, size, sz === 0 ? size : size * 0.7),
            sx * half,
            y + size / 2,
            sz * half,
          ),
          STONE,
        ),
      );
    }
  }
  return parts;
}

/**
 * A round hut under a thatch cone that overhangs the wall, a dyed cap on the
 * thatch and a pennant on a pole through the apex. 60 triangles.
 */
function hut(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(at(new THREE.CylinderGeometry(0.36, 0.4, 0.42, 8, 1, true), 0, 0.21, 0), WALL),
    // Base below the wall's top, so the eave hangs over it.
    tint(at(new THREE.ConeGeometry(0.56, 0.46, 8, 1, true), 0, 0.38 + 0.23, 0), THATCH),
    // The cap: the upper half of the thatch again, a hair proud of it, in the
    // side's colour. From straight above — the usual view — a hut is mostly
    // this; a smaller cap was invisible at play distance.
    teamPart(tint(at(new THREE.ConeGeometry(0.305, 0.25, 8, 1, true), 0, 0.727, 0), CLOTH)),
    tint(at(new THREE.BoxGeometry(0.15, 0.26, 0.06), 0, 0.13, 0.37), DOOR),
    pole(0, 0.78, 0, 0.46),
    teamPart(tint(at(cloth("pennant", 0.34, 0.18), 0.01, 1.23, 0), CLOTH)),
  ]);
}

/**
 * A timber-framed house: plaster walls between corner posts, a top plate and
 * a rail, a gable roof that overhangs the eaves, a chimney through it, a ridge
 * board in the side's colour and the side's banner beside the door. 132
 * triangles.
 */
function house(): THREE.BufferGeometry {
  const W = 0.9;
  const H = 0.5;
  const D = 0.66;
  /** The roof: span across the eaves, rise to the ridge, slab thickness, eave height. */
  const SPAN = 0.96;
  const RISE = 0.42;
  const SLAB = 0.04;
  const EAVE = H - 0.06;
  const RIDGE = EAVE + RISE;
  const parts: THREE.BufferGeometry[] = [
    // The walls with their gables, as one pentagon run the length of the
    // house: the gable apex sits just under the roof's underside, so the ends
    // show plaster under the eaves rather than a wall of tiles.
    tint(
      profile(
        [
          [-D / 2, 0],
          [D / 2, 0],
          [D / 2, H],
          [0, EAVE - SLAB + RISE - 0.02],
          [-D / 2, H],
        ],
        [
          [0, 1, 2],
          [0, 2, 4],
          [2, 3, 4],
        ],
        W,
      ),
      WALL,
    ),
    // The roof: a chevron of two slabs, open at the gables. The three-sided
    // cylinder it replaces was meant to be this and was rotated so its apex
    // pointed sideways — a lean-to with one vertical face.
    tint(
      profile(
        [
          [-SPAN / 2, EAVE],
          [0, RIDGE],
          [SPAN / 2, EAVE],
          [SPAN / 2, EAVE - SLAB],
          [0, RIDGE - SLAB],
          [-SPAN / 2, EAVE - SLAB],
        ],
        // Each slab is a quad, split on its diagonal.
        [
          [0, 5, 4],
          [0, 4, 1],
          [1, 4, 3],
          [1, 3, 2],
        ],
        1.06,
      ),
      TILE,
    ),
    // The frame: a plate along the top of the walls and a rail at the height
    // of the door's lintel. Boxes a hair larger than the walls, so they band
    // all four faces at once.
    tint(at(new THREE.BoxGeometry(W + 0.04, 0.05, D + 0.04), 0, H - 0.02, 0), TIMBER),
    tint(at(new THREE.BoxGeometry(W + 0.025, 0.035, D + 0.025), 0, 0.31, 0), TIMBER),
    // Along the ridge, sitting on it: from straight above, a stripe of the side.
    teamPart(tint(at(new THREE.BoxGeometry(1.1, 0.06, 0.1), 0, RIDGE, 0), CLOTH)),
    tint(at(new THREE.BoxGeometry(0.15, 0.28, 0.05), 0.2, 0.14, D / 2), DOOR),
    // Far enough off the ridge that it clears the roof: at z = 0.2 the roof
    // surface is at ~0.69, and the stack tops out at 0.95.
    tint(at(taperedBox(0.13, 0.5, 0.13, 0.85), -0.28, 0.45, 0.2), STONE),
    teamPart(tint(at(cloth("banner", 0.16, 0.24, 0.02), -0.17, H - 0.06, D / 2 + 0.018), CLOTH)),
  ];
  // Corner posts: four-sided open cylinders turned square to the walls. A box
  // would spend four more triangles each on end caps nobody sees.
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    parts.push(
      tint(
        at(
          new THREE.CylinderGeometry(0.05, 0.05, H, 4, 1, true),
          sx * (W / 2 - 0.01),
          H / 2,
          sz * (D / 2 - 0.01),
          [0, Math.PI / 4, 0],
        ),
        TIMBER,
      ),
    );
  }
  return mergeGeometries(parts);
}

/**
 * A square keep: a battered stone body, a parapet with eight merlons, a roof
 * in the side's colour inside them, and the side's flag on a mast. 160
 * triangles — the round tower it replaced was 152.
 */
function keep(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(taperedBox(0.6, 1.0, 0.6, 0.9), STONE),
    tint(at(new THREE.BoxGeometry(0.64, 0.1, 0.64), 0, 1.03, 0), STONE_DARK),
    ...battlements(0.26, 1.08, 0.12, true),
    teamPart(tint(at(pyramid(0.46, 0.3, 0.46), 0, 1.08, 0), CLOTH)),
    tint(at(new THREE.BoxGeometry(0.16, 0.3, 0.05), 0, 0.15, 0.3), DOOR),
    pole(0, 1.25, 0, 0.6),
    teamPart(tint(at(cloth("flag", 0.4, 0.24), 0.01, 1.84, 0), CLOTH)),
  ]);
}

/**
 * The citadel: a tall central keep with its flag, four round corner towers
 * under roofs in the side's colour, curtain walls between them, a gate, and
 * pennants on two of the towers. The centre of a tier-4 settlement, which the
 * wall ring in `vegetation.ts` then encloses. About 1.3 units across. 264
 * triangles.
 */
function citadel(): THREE.BufferGeometry {
  const T = 0.55;
  const parts: THREE.BufferGeometry[] = [
    // The keep: the same build as `keep()`, taller and with corner merlons only.
    tint(taperedBox(0.56, 1.3, 0.56, 0.9), STONE),
    tint(at(new THREE.BoxGeometry(0.58, 0.1, 0.58), 0, 1.32, 0), STONE_DARK),
    ...battlements(0.23, 1.37, 0.12, false),
    teamPart(tint(at(pyramid(0.42, 0.3, 0.42), 0, 1.37, 0), CLOTH)),
    pole(0, 1.5, 0, 0.7),
    teamPart(tint(at(cloth("flag", 0.46, 0.28), 0.01, 2.18, 0), CLOTH)),
    // Curtain walls, tower to tower.
    tint(at(new THREE.BoxGeometry(2 * T, 0.5, 0.12), 0, 0.25, T), STONE_DARK),
    tint(at(new THREE.BoxGeometry(2 * T, 0.5, 0.12), 0, 0.25, -T), STONE_DARK),
    tint(at(new THREE.BoxGeometry(0.12, 0.5, 2 * T), T, 0.25, 0), STONE_DARK),
    tint(at(new THREE.BoxGeometry(0.12, 0.5, 2 * T), -T, 0.25, 0), STONE_DARK),
    tint(at(new THREE.BoxGeometry(0.2, 0.3, 0.16), 0, 0.15, T), DOOR),
  ];
  for (const [k, [sx, sz]] of (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
  ).entries()) {
    const x = sx * T;
    const z = sz * T;
    parts.push(
      tint(at(new THREE.CylinderGeometry(0.17, 0.19, 0.85, 6, 1, true), x, 0.425, z), STONE),
      teamPart(tint(at(new THREE.ConeGeometry(0.23, 0.36, 6, 1, true), x, 0.85 + 0.18, z), CLOTH)),
    );
    // Pennants on two opposite towers: four would be a fence of them.
    if (k % 2 === 0) {
      parts.push(
        pole(x, 1.15, z, 0.36),
        teamPart(tint(at(cloth("pennant", 0.26, 0.14), x + 0.01, 1.5, z), CLOTH)),
      );
    }
  }
  return mergeGeometries(parts);
}

/**
 * One segment of a low stone wall with two merlons, laid tangentially around a
 * citadel. 36 triangles.
 */
function wallSegment(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(at(taperedBox(1.0, 0.3, 0.16, 0.8), 0, 0, 0), STONE),
    tint(at(new THREE.BoxGeometry(0.16, 0.1, 0.12), -0.24, 0.34, 0), STONE),
    tint(at(new THREE.BoxGeometry(0.16, 0.1, 0.12), 0.24, 0.34, 0), STONE),
  ]);
}

// ---------------------------------------------------------------------------
// Props: pickups and the papal magnet
// ---------------------------------------------------------------------------

export interface PropModels {
  /** Facet-shaded through a `color` attribute; the power's hue is the instance colour. */
  pickup: THREE.BufferGeometry;
  /** Coloured and team-masked, like the buildings. */
  magnet: THREE.BufferGeometry;
}

export function propModels(tier: ModelTier): PropModels {
  if (tier < 2) {
    // The spire, entirely the side's, as it always was.
    const magnet = teamPart(tint(new THREE.ConeGeometry(0.16, 1.0, 4).translate(0, 0.5, 0), CLOTH));
    return { pickup: facetShade(new THREE.OctahedronGeometry(1, 0)), magnet };
  }
  // A crystal: the octahedron it was, with a taller, thinner one through it at
  // a turn, so it has facets to catch the light and is findable from orbit.
  const pickup = facetShade(
    mergeGeometries([
      new THREE.OctahedronGeometry(1, 0),
      at(
        new THREE.OctahedronGeometry(1, 0),
        0,
        0.15,
        0,
        [0.2, Math.PI / 4, 0.1],
        [0.55, 1.55, 0.55],
      ),
    ]),
  );
  // The magnet: an obelisk on two steps with a finial, and a banner on a
  // crossbar on each face, so one always shows as it turns. The obelisk takes
  // a third of the side's colour, the banners and finial all of it: the stone
  // still says whose from orbit, and the banners say it up close.
  const banner = (side: number): THREE.BufferGeometry[] => [
    tint(at(new THREE.BoxGeometry(0.27, 0.03, 0.03), 0, 0.81, side * 0.08), TIMBER),
    teamPart(
      tint(
        at(cloth("banner", 0.22, 0.32, 0.02), 0, 0.8, side * 0.09, [0, side < 0 ? Math.PI : 0, 0]),
        CLOTH,
      ),
    ),
  ];
  const magnet = mergeGeometries([
    tint(at(new THREE.BoxGeometry(0.5, 0.06, 0.5), 0, 0.03, 0), STONE),
    tint(at(new THREE.BoxGeometry(0.34, 0.06, 0.34), 0, 0.09, 0), STONE),
    teamPart(tint(taperedBox(0.2, 0.86, 0.2, 0.42).translate(0, 0.12, 0), MARBLE), 0.35),
    teamPart(tint(at(new THREE.IcosahedronGeometry(0.075, 1), 0, 1.03, 0), CLOTH)),
    ...banner(1),
    ...banner(-1),
  ]);
  return { pickup, magnet };
}
