/**
 * The procedural models: flora, buildings, the props on the ground.
 *
 * HANDOFF §7.5 — everything is procedural, and this is where the geometry that
 * is not terrain comes from. Two tiers, chosen once at start-up (§7.3):
 *
 * - **Tier 1** is the set of primitives the game shipped with — a cone is a
 *   conifer, a box is a house — because the reference floor of §7.6 is an
 *   office machine with integrated graphics and a forest is up to 8,700
 *   instances. They are moved here verbatim so tier 1 looks exactly as before.
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
 * roofs and green crowns in one draw call. Tier 1 geometry carries no colour
 * attribute and its material keeps the single colour it always had.
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
const SLATE = 0x6d7480;
const STONE = 0xb9b3a4;
const DOOR = 0x5a3d26;

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
  /** Hut, house, tower, wall segment — one geometry each, unit footprint. */
  hut: THREE.BufferGeometry;
  house: THREE.BufferGeometry;
  tower: THREE.BufferGeometry;
  wall: THREE.BufferGeometry;
  /** White where the geometry carries vertex colours. */
  colour: number;
}

export function buildingModels(tier: ModelTier): BuildingModels {
  if (tier < 2) {
    // Settlements drew as a cluster of blocks whose count is their tier. Every
    // kind is the same block, so tier 1 looks exactly as it did.
    const block = () => {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0);
      return g;
    };
    return { hut: block(), house: block(), tower: block(), wall: block(), colour: 0xd8cbb0 };
  }
  return { hut: hut(), house: house(), tower: tower(), wall: wallSegment(), colour: 0xffffff };
}

/** An eight-sided hut under a thatch cone that overhangs the wall. 48 triangles. */
function hut(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(at(new THREE.CylinderGeometry(0.4, 0.44, 0.5, 8, 1, true), 0, 0.25, 0), WALL),
    tint(at(new THREE.ConeGeometry(0.6, 0.5, 8, 1, true), 0, 0.72, 0), THATCH),
    tint(at(new THREE.BoxGeometry(0.16, 0.28, 0.06), 0, 0.14, 0.42), DOOR),
  ]);
}

/**
 * A house: walls, a pitched roof that overhangs the gables, a door and a
 * chimney. A three-sided cylinder on its side is a gable roof; scaling its
 * height sets the pitch. ~40 triangles.
 */
function house(): THREE.BufferGeometry {
  const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.06, 3, 1, false);
  // Axis along x, one edge of the triangle pointing straight up.
  roof.rotateZ(Math.PI / 2);
  roof.rotateX(Math.PI / 2 + Math.PI / 6);
  roof.scale(1, 0.72, 0.9);
  return mergeGeometries([
    tint(at(new THREE.BoxGeometry(0.9, 0.62, 0.68), 0, 0.31, 0), WALL),
    tint(at(roof, 0, 0.62 + 0.22, 0), TILE),
    tint(at(new THREE.BoxGeometry(0.16, 0.3, 0.06), 0.18, 0.15, 0.35), DOOR),
    tint(at(taperedBox(0.14, 0.34, 0.14, 0.85), -0.28, 0.72, 0.12), STONE),
  ]);
}

/** A tower: an eight-sided keep, eight merlons and a slate cap. ~90 triangles. */
function tower(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    tint(at(new THREE.CylinderGeometry(0.34, 0.4, 1.1, 8, 1, true), 0, 0.55, 0), STONE),
    tint(at(new THREE.CylinderGeometry(0.38, 0.38, 0.08, 8, 1, false), 0, 1.14, 0), STONE),
    tint(at(new THREE.ConeGeometry(0.3, 0.38, 8, 1, true), 0, 1.36, 0), SLATE),
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    parts.push(
      tint(
        at(new THREE.BoxGeometry(0.1, 0.12, 0.08), Math.sin(a) * 0.36, 1.24, Math.cos(a) * 0.36, [
          0,
          a,
          0,
        ]),
        STONE,
      ),
    );
  }
  return mergeGeometries(parts);
}

/** One segment of a low stone wall, laid tangentially around a citadel. 12 triangles. */
function wallSegment(): THREE.BufferGeometry {
  return mergeGeometries([tint(at(taperedBox(1.0, 0.3, 0.16, 0.8), 0, 0, 0), STONE)]);
}

// ---------------------------------------------------------------------------
// Props: pickups and the papal magnet
// ---------------------------------------------------------------------------

export interface PropModels {
  pickup: THREE.BufferGeometry;
  magnet: THREE.BufferGeometry;
}

export function propModels(tier: ModelTier): PropModels {
  if (tier < 2) {
    const magnet = new THREE.ConeGeometry(0.16, 1.0, 4);
    magnet.translate(0, 0.5, 0);
    return { pickup: new THREE.OctahedronGeometry(1, 0), magnet };
  }
  // A crystal: the octahedron it was, with a taller, thinner one through it at
  // a turn, so it has facets to catch the light and is findable from orbit.
  const pickup = mergeGeometries([
    new THREE.OctahedronGeometry(1, 0),
    at(new THREE.OctahedronGeometry(1, 0), 0, 0.15, 0, [0.2, Math.PI / 4, 0.1], [0.55, 1.55, 0.55]),
  ]);
  // The magnet: an obelisk on two steps with a finial, unlit-white like the
  // walkers so the owner tint is the colour.
  const magnet = mergeGeometries([
    at(new THREE.BoxGeometry(0.5, 0.06, 0.5), 0, 0.03, 0),
    at(new THREE.BoxGeometry(0.34, 0.06, 0.34), 0, 0.09, 0),
    taperedBox(0.2, 0.86, 0.2, 0.42).translate(0, 0.12, 0),
    at(new THREE.IcosahedronGeometry(0.075, 1), 0, 1.03, 0),
  ]);
  return { pickup, magnet };
}
