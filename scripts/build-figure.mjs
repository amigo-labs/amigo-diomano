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
const OUT = join(ROOT, "web/public/models/villager.glb");

/**
 * The figure, as boxes. One unit tall, standing on y = 0, facing -Z.
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

const positions = [];
const normals = [];

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
  const faces = [
    [0, 3, 2, 1], // bottom
    [4, 5, 6, 7], // top
    [0, 1, 5, 4], // -z
    [2, 3, 7, 6], // +z
    [1, 2, 6, 5], // +x
    [3, 0, 4, 7], // -x
  ];
  for (const [a, b, c, d] of faces) {
    const e1 = sub(v[b], v[a]);
    const e2 = sub(v[c], v[a]);
    const n = normalise(cross(e1, e2));
    for (const idx of [a, b, c, a, c, d]) {
      positions.push(...v[idx]);
      normals.push(...n);
    }
  }
}

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

for (const [centre, size, taper] of PARTS) box(centre, size, taper);

const count = positions.length / 3;
const posArray = new Float32Array(positions);
const nrmArray = new Float32Array(normals);

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i++) {
  for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], posArray[i * 3 + k]);
    max[k] = Math.max(max[k], posArray[i * 3 + k]);
  }
}

// --- GLB assembly ----------------------------------------------------------
// Written by hand rather than with a library: this is one mesh with two
// attributes, and the whole container is a header, a JSON chunk and a binary
// chunk. A dependency to emit 9 KB would be the larger thing.
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

mkdirSync(dirname(OUT), { recursive: true });
const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
writeFileSync(OUT, glb);
console.log(
  `villager.glb: ${glb.length} bytes, ${count} vertices, ${count / 3} triangles, ` +
    `hip ${HIP} shoulder ${SHOULDER} torso half width ${TORSO_HALF_WIDTH}`,
);
