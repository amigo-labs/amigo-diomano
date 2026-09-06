/**
 * Build `web/public/models/villager.glb` — the figure the population is drawn
 * with.
 *
 * # Why this is generated rather than downloaded
 *
 * HANDOFF §7.5 is "CC0 only", and CC0 humanoids are harder to come by than they
 * sound: the Khronos sample set's people are CC-BY (CesiumMan is © Cesium), the
 * three.js example humanoid is a robot, and the packs that *are* CC0 — Kenney,
 * Quaternius — ship as zips behind pages rather than as fetchable files. A model
 * we author is CC0 by construction, has no provenance to keep checkable, and is
 * ~9 KB.
 *
 * It is a real glTF, deliberately, and not a runtime-procedural blob: the
 * loading path in `vegetation.ts` derives limbs from vertex *positions* rather
 * than from anything this file writes, so any humanoid in a roughly upright pose
 * can replace this one by dropping a `.glb` in its place. Swapping in a
 * downloaded CC0 character is a file copy, not a code change.
 *
 * No skinning. A thousand skinned meshes is not a budget this project has; the
 * walk cycle is a vertex-shader rotation about hard-coded joint heights, which
 * is why the proportions below are also constants in `vegetation.ts`.
 *
 * Run: `node scripts/build-figure.mjs`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = join(ROOT, "web/public/models");

/**
 * The figure, as boxes. One unit tall, standing on y = 0, facing -Z. This is
 * the **tier-1** figure — `villager-low.glb` — drawn when a thousand of them
 * may be on screen on integrated graphics (§7.6). The tier-2 figure is
 * `DETAILED_PARTS` below.
 *
 * The joint heights matter beyond the silhouette: `vegetation.ts` reads limbs
 * back out of the geometry by comparing vertex height against HIP and SHOULDER,
 * and vertex x-sign against the torso's half width. Move a limb across one of
 * those lines here and it will swing as the wrong limb there.
 */
const HIP = 0.46;
const SHOULDER = 0.70;
const TORSO_HALF_WIDTH = 0.115;

/** [centre x, y, z], [size x, y, z] — and a taper on the top face, 0..1. */
const PARTS = [
  // head and neck
  [[0, 0.905, 0.005], [0.2, 0.2, 0.21], 0.82],
  [[0, 0.79, 0], [0.09, 0.07, 0.09], 1],
  // chest and belly: two boxes, so the torso has a waist
  [[0, 0.665, 0], [0.29, 0.19, 0.18], 0.88],
  [[0, 0.525, 0], [0.24, 0.13, 0.16], 1.1],
  // hips
  [[0, 0.435, 0], [0.26, 0.09, 0.17], 1],
  // arms: upper, fore, hand — hung outside TORSO_HALF_WIDTH so the limb test
  // below cannot mistake them for chest
  [[-0.185, 0.645, 0], [0.085, 0.2, 0.095], 0.9],
  [[0.185, 0.645, 0], [0.085, 0.2, 0.095], 0.9],
  [[-0.185, 0.475, 0], [0.07, 0.17, 0.08], 0.95],
  [[0.185, 0.475, 0], [0.07, 0.17, 0.08], 0.95],
  [[-0.185, 0.365, 0], [0.075, 0.075, 0.085], 1],
  [[0.185, 0.365, 0], [0.075, 0.075, 0.085], 1],
  // legs: thigh, shin, foot
  [[-0.075, 0.32, 0], [0.105, 0.24, 0.11], 1.05],
  [[0.075, 0.32, 0], [0.105, 0.24, 0.11], 1.05],
  [[-0.075, 0.115, 0], [0.085, 0.19, 0.09], 1.1],
  [[0.075, 0.115, 0], [0.085, 0.19, 0.09], 1.1],
  [[-0.075, 0.025, -0.03], [0.09, 0.05, 0.19], 1],
  [[0.075, 0.025, -0.03], [0.09, 0.05, 0.19], 1],
];

/**
 * The tier-2 figure — `villager.glb`. The same person with the parts a
 * silhouette this size can actually show: a head with a jaw and a cap of hair,
 * a neck, shoulders, a tunic with a belt over the hips, arms with elbows and
 * hands, legs with knees and boots. ~500 triangles against the tier-1 figure's
 * 204, which at 1,024 walkers is half a million — comfortable at tier 2, and
 * the reason tier 1 keeps the boxes.
 *
 * # The joint lines still hold
 *
 * `vegetation.ts` classifies vertices by position: below HIP is a leg, between
 * HIP and SHOULDER and outboard of TORSO_HALF_WIDTH is an arm, everything else
 * is body. So every torso part between the hip and the shoulder is kept inside
 * the torso half width — the tunic's hem included, which is why it does not
 * flare — and the shoulder pads sit *above* the shoulder line, where they count
 * as body and do not swing.
 *
 * Entries are `[centre, size, taper]` boxes as above, or
 * `{ prism: [centre, radius, height, sides, taper] }` for the round parts.
 */
const DETAILED_PARTS = [
  // head: an octagonal prism narrowing toward the crown, a jaw under it, a nose,
  // a cap of hair, two ears
  { prism: [[0, 0.905, 0.0], 0.105, 0.19, 8, 0.86] },
  [[0, 0.822, 0.01], [0.15, 0.05, 0.14], 0.8],
  [[0, 0.885, -0.11], [0.035, 0.04, 0.035], 0.9],
  { prism: [[0, 0.985, 0.005], 0.112, 0.055, 8, 0.7] },
  [[-0.11, 0.9, 0.01], [0.025, 0.05, 0.04], 1],
  [[0.11, 0.9, 0.01], [0.025, 0.05, 0.04], 1],
  // neck
  [[0, 0.785, 0], [0.08, 0.06, 0.08], 1],
  // shoulders, above the shoulder line so they are body
  [[-0.15, 0.735, 0], [0.13, 0.06, 0.15], 0.75],
  [[0.15, 0.735, 0], [0.13, 0.06, 0.15], 0.75],
  // chest, belly, belt: all inside the torso half width
  [[0, 0.675, 0], [0.23, 0.13, 0.17], 0.94],
  [[0, 0.57, 0], [0.22, 0.09, 0.155], 1.04],
  [[0, 0.505, 0], [0.23, 0.05, 0.165], 1],
  // tunic pleats down the front
  [[-0.06, 0.6, -0.085], [0.03, 0.2, 0.012], 1],
  [[0.0, 0.6, -0.087], [0.03, 0.2, 0.012], 1],
  [[0.06, 0.6, -0.085], [0.03, 0.2, 0.012], 1],
  // hips: below the hip line, so they split left and right with the legs
  [[0, 0.44, 0], [0.24, 0.06, 0.17], 1],
  // arms: upper arm, elbow, forearm, hand, thumb — all outboard of the torso
  [[-0.19, 0.64, 0], [0.085, 0.13, 0.095], 0.9],
  [[0.19, 0.64, 0], [0.085, 0.13, 0.095], 0.9],
  [[-0.19, 0.565, 0], [0.09, 0.04, 0.1], 1],
  [[0.19, 0.565, 0], [0.09, 0.04, 0.1], 1],
  [[-0.19, 0.49, -0.005], [0.07, 0.12, 0.08], 0.9],
  [[0.19, 0.49, -0.005], [0.07, 0.12, 0.08], 0.9],
  [[-0.19, 0.41, -0.01], [0.075, 0.08, 0.085], 0.85],
  [[0.19, 0.41, -0.01], [0.075, 0.08, 0.085], 0.85],
  [[-0.155, 0.43, -0.045], [0.025, 0.04, 0.03], 1],
  [[0.155, 0.43, -0.045], [0.025, 0.04, 0.03], 1],
  // legs: thigh, knee, shin, boot cuff, foot
  [[-0.075, 0.335, 0], [0.105, 0.17, 0.11], 0.95],
  [[0.075, 0.335, 0], [0.105, 0.17, 0.11], 0.95],
  [[-0.075, 0.245, -0.005], [0.1, 0.035, 0.11], 1],
  [[0.075, 0.245, -0.005], [0.1, 0.035, 0.11], 1],
  [[-0.075, 0.15, 0], [0.085, 0.16, 0.09], 1.08],
  [[0.075, 0.15, 0], [0.085, 0.16, 0.09], 1.08],
  [[-0.075, 0.075, 0], [0.1, 0.035, 0.105], 1],
  [[0.075, 0.075, 0], [0.1, 0.035, 0.105], 1],
  [[-0.075, 0.025, -0.03], [0.095, 0.05, 0.2], 0.9],
  [[0.075, 0.025, -0.03], [0.095, 0.05, 0.2], 0.9],
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalise(v) {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Flat-shaded triangles from parts, for one figure. */
function build(parts) {
  const positions = [];
  const normals = [];

  /** One flat quad, `a b c d` counter-clockwise seen from outside. */
  const quad = (a, b, c, d) => {
    const n = normalise(cross(sub(b, a), sub(c, a)));
    for (const v of [a, b, c, a, c, d]) {
      positions.push(...v);
      normals.push(...n);
    }
  };

  /** Six quads, flat-shaded, with the top face optionally tapered. */
  function box([cx, cy, cz], [sx, sy, sz], taper) {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const tx = hx * taper;
    const tz = hz * taper;
    // Eight corners: bottom four at full width, top four tapered.
    const v = [
      [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz],
      [cx - tx, cy + hy, cz - tz], [cx + tx, cy + hy, cz - tz],
      [cx + tx, cy + hy, cz + tz], [cx - tx, cy + hy, cz + tz],
    ];
    // Counter-clockwise seen from *outside* the box, which is what `quad`
    // needs for both the winding and the normal it derives from it. The first
    // version listed these clockwise, and both villager models shipped inside
    // out — every outward triangle back-face culled, the far side lit by
    // inward normals — the same defect the planet mesh once had. `writeGlb`
    // now measures the signed volume so it cannot happen quietly again.
    const faces = [
      [0, 1, 2, 3], // bottom (-y)
      [4, 7, 6, 5], // top (+y)
      [0, 4, 5, 1], // -z
      [2, 6, 7, 3], // +z
      [1, 5, 6, 2], // +x
      [3, 7, 4, 0], // -x
    ];
    for (const [a, b, c, d] of faces) quad(v[a], v[b], v[c], v[d]);
  }

  /** A right prism on a regular polygon, flat-shaded, top tapered. */
  function prism([cx, cy, cz], radius, height, sides, taper) {
    const lo = [];
    const hi = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      lo.push([cx + Math.sin(a) * radius, cy - height / 2, cz + Math.cos(a) * radius]);
      hi.push([cx + Math.sin(a) * radius * taper, cy + height / 2, cz + Math.cos(a) * radius * taper]);
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      quad(lo[i], lo[j], hi[j], hi[i]);
    }
    // Caps as fans, wound outward.
    for (let i = 1; i < sides - 1; i++) {
      const n = [0, 1, 0];
      for (const v of [hi[0], hi[i], hi[i + 1]]) {
        positions.push(...v);
        normals.push(...n);
      }
      const m = [0, -1, 0];
      for (const v of [lo[0], lo[i + 1], lo[i]]) {
        positions.push(...v);
        normals.push(...m);
      }
    }
  }

  for (const [k, part] of parts.entries()) {
    const from = positions.length;
    if (Array.isArray(part)) box(part[0], part[1], part[2]);
    else prism(...part.prism);
    // Every part is a closed solid of its own, so each has to be wound outward
    // by itself. The whole-figure check in `assertWoundOutward` sums them, and
    // one inside-out thumb would disappear under the torso's volume.
    const v = signedVolume(positions, from, positions.length);
    if (!(v > 0)) {
      throw new Error(`part ${k}: signed volume ${v.toFixed(4)} — wound inward`);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
}

/**
 * Signed volume of the triangles in `positions[from, to)`: the divergence
 * theorem, one tetrahedron per triangle against the origin. Positive for a
 * closed, outward-wound surface.
 */
function signedVolume(positions, from, to) {
  let volume = 0;
  for (let i = from; i + 9 <= to; i += 9) {
    const a = [positions[i], positions[i + 1], positions[i + 2]];
    const b = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
    const n = cross(sub(b, a), sub(c, a));
    volume += (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) / 6;
  }
  return volume;
}

/**
 * The mesh must be wound outward: positive signed volume overall, and every
 * stored normal on the same side as the winding it was derived from.
 *
 * Inside out, the whole figure is culled by a `FrontSide` material and what
 * remains is lit by inward normals — and nothing else in the pipeline notices,
 * which is how both villagers shipped that way once. `build` already checks
 * each part's volume on its own; this is the whole-file check at the point
 * where the bytes are written. The stored-normal comparison can only fire for
 * the prism caps, whose normals are written by hand — `quad` derives its
 * normal from the very winding it emits.
 */
function assertWoundOutward(name, positions, normals) {
  const volume = signedVolume(positions, 0, positions.length);
  let disagree = 0;
  for (let i = 0; i + 9 <= positions.length; i += 9) {
    const a = [positions[i], positions[i + 1], positions[i + 2]];
    const b = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
    const n = cross(sub(b, a), sub(c, a));
    const stored = [normals[i], normals[i + 1], normals[i + 2]];
    if (n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] < 0) disagree += 1;
  }
  if (!(volume > 0)) {
    throw new Error(`${name}: signed volume ${volume.toFixed(4)} — the figure is inside out`);
  }
  if (disagree > 0) {
    throw new Error(`${name}: ${disagree} triangles store a normal against their winding`);
  }
}

// --- GLB assembly ----------------------------------------------------------
// Written by hand rather than with a library: this is one mesh with two
// attributes, and the whole container is a header, a JSON chunk and a binary
// chunk. A dependency to emit 9 KB would be the larger thing.
function writeGlb(name, { positions: posArray, normals: nrmArray }) {
  const count = posArray.length / 3;
  assertWoundOutward(name, posArray, nrmArray);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], posArray[i * 3 + k]);
      max[k] = Math.max(max[k], posArray[i * 3 + k]);
    }
  }
  const posBytes = Buffer.from(posArray.buffer);
  const nrmBytes = Buffer.from(nrmArray.buffer);
  const bin = Buffer.concat([posBytes, nrmBytes]);

  const gltf = {
    asset: {
      version: "2.0",
      generator: "diomano scripts/build-figure.mjs",
      copyright: "CC0 1.0 — authored for diomano, see docs/ASSETS.md",
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "villager" }],
    meshes: [{ name: "villager", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: nrmBytes.length, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const pad = (buf, to, fill) => {
    const extra = (to - (buf.length % to)) % to;
    return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, fill)]);
  };
  const jsonChunk = pad(Buffer.from(JSON.stringify(gltf), "utf8"), 4, 0x20);
  const binChunk = pad(bin, 4, 0);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

  mkdirSync(MODELS, { recursive: true });
  const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
  const out = join(MODELS, name);
  writeFileSync(out, glb);
  console.log(
    `${name}: ${glb.length} bytes, ${count} vertices, ${count / 3} triangles, ` +
      `hip ${HIP} shoulder ${SHOULDER} torso half width ${TORSO_HALF_WIDTH}`,
  );
}

writeGlb("villager-low.glb", build(PARTS));
writeGlb("villager.glb", build(DETAILED_PARTS));
