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
