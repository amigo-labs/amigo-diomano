/**
 * Building geometry out of parts, without pulling in `three/examples/jsm`.
 *
 * The four post-processing passes are the only non-core three.js this project
 * depends on, and that is worth keeping: `examples/jsm` is a directory three
 * explicitly does not treat as API. `BufferGeometryUtils.mergeGeometries` does
 * what is here and a great deal more; forty lines buys the two attributes an
 * instanced Lambert mesh actually consumes.
 *
 * Used by the flora (a palm is a trunk and six fronds) and by the hand (a palm,
 * five fingers and their knuckles).
 */

import * as THREE from "three";

/**
 * Apply transforms to a geometry and hand it back, so a merge list reads as a
 * list of parts rather than as a sequence of statements with a variable each.
 */
export function withTransform(
  geometry: THREE.BufferGeometry,
  edit: (g: THREE.BufferGeometry) => void,
): THREE.BufferGeometry {
  edit(geometry);
  return geometry;
}

/**
 * Concatenate geometries into one, positions and normals only.
 *
 * `three/examples/jsm/utils/BufferGeometryUtils` does this and more, but the
 * only non-core three.js imports in this project are the four post-processing
 * passes, and that is worth keeping: every one of them is a dependency on a
 * directory three explicitly does not treat as API. Twenty lines here buys the
 * two attributes an instanced Lambert mesh actually consumes.
 *
 * Non-indexed throughout. These are a few dozen triangles built once at load;
 * an index buffer would save nothing and would have to be rebased per part.
 */
export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of flat) total += g.getAttribute("position").count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let at = 0;
  for (const g of flat) {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    position.set(p.array as Float32Array, at * 3);
    normal.set(n.array as Float32Array, at * 3);
    at += p.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return merged;
}

/**
 * Read positions and normals out of a binary glTF.
 *
 * # Why not `GLTFLoader`
 *
 * It works, and it costs 45 kB of its own plus **214 kB** of three that the
 * renderer otherwise tree-shakes away — animation, compressed textures,
 * materials this project does not use — to read one 15 KB mesh. The core chunk
 * went from 490 kB to 705 kB for a file whose entire content is two float
 * arrays. This is fifty lines and the same result.
 *
 * It also keeps the pattern the rest of the project already commits to: the
 * wasm module is loaded with `instantiateStreaming` and a table of `extern "C"`
 * functions rather than with generated glue, for the same reason.
 *
 * # What it accepts
 *
 * A GLB with one mesh whose first primitive is an indexed or non-indexed
 * triangle list of `POSITION` and `NORMAL` accessors, both `VEC3` of floats, in
 * the binary chunk. That is what `scripts/build-figure.mjs` writes and what a
 * plain Blender or `gltf-transform` export produces. It is *not* the whole
 * format: no Draco, no KTX2, no sparse accessors, no node transforms. A
 * replacement model has to be one of the simple kind, and `docs/ASSETS.md` says
 * so where it says a replacement is a file copy.
 *
 * Throws on anything it does not understand, rather than returning a geometry
 * that is quietly wrong — a figure with scrambled vertices is harder to
 * diagnose than a message naming the thing that was missing.
 */
export function readGlb(buffer: ArrayBuffer): THREE.BufferGeometry {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB: bad magic");
  if (view.getUint32(4, true) !== 2) throw new Error("GLB version is not 2");

  let offset = 12;
  let json: GlbJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    const body = new Uint8Array(buffer, offset + 8, length);
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GlbJson;
    else if (kind === 0x004e4942) bin = body;
    offset += 8 + length;
  }
  if (!json || !bin) throw new Error("GLB is missing its JSON or binary chunk");

  const primitive = json.meshes?.[0]?.primitives?.[0];
  if (!primitive) throw new Error("GLB holds no mesh primitive");
  if (primitive.mode !== undefined && primitive.mode !== 4) {
    throw new Error(`GLB primitive mode ${primitive.mode} is not a triangle list`);
  }

  const read = (accessorIndex: number, name: string): Float32Array => {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor) throw new Error(`GLB accessor ${accessorIndex} (${name}) is missing`);
    // 5126 is FLOAT. Anything else would need a conversion this does not do.
    if (accessor.componentType !== 5126 || accessor.type !== "VEC3") {
      throw new Error(`GLB ${name} is not a float VEC3`);
    }
    const bufferView = json.bufferViews?.[accessor.bufferView ?? -1];
    if (!bufferView) throw new Error(`GLB ${name} has no buffer view`);
    const start = bin.byteOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    // Copied rather than viewed: the accessor's start need not be four-byte
    // aligned within the file, and `Float32Array` over a misaligned offset
    // throws.
    return new Float32Array(buffer.slice(start, start + accessor.count * 12));
  };

  const positionAccessor = primitive.attributes.POSITION;
  if (positionAccessor === undefined) throw new Error("GLB primitive has no POSITION");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(read(positionAccessor, "POSITION"), 3),
  );
  const normalAccessor = primitive.attributes.NORMAL;
  if (normalAccessor === undefined) geometry.computeVertexNormals();
  else
    geometry.setAttribute("normal", new THREE.BufferAttribute(read(normalAccessor, "NORMAL"), 3));
  return geometry;
}

interface GlbJson {
  meshes?: { primitives?: { attributes: Record<string, number>; mode?: number }[] }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews?: { byteOffset?: number; byteLength: number }[];
}
