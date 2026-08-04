/**
 * Instanced vegetation and settlements. HANDOFF §7.3 tier 2, §7.4.
 *
 * Density comes from the `vegetation` field, which is *simulation state*
 * (§3.7) — the same field that damps water transfer in §4.3. So when a player
 * cuts a notch in a treeline and the next flood focuses through it, the trees
 * that vanished are the ones that stopped damping. The picture and the mechanic
 * are the same number.
 *
 * Everything is one instanced draw call per kind. §7.3's draw-call ceiling is
 * 150 at tier 2 and the terrain alone is 96 chunks, so vegetation gets to spend
 * two.
 */

import * as THREE from "three";
import type { Sim } from "../main";
import type { QualityTier } from "../main";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirection } from "./planet";

/** Vegetation density below which a cell grows nothing worth drawing. */
const VEGETATION_THRESHOLD = 40;
/** Instance budget. Beyond this the planet reads as moss, not as forest. */
const MAX_TREES = 6000;
const MAX_BUILDINGS = 512;
/** Cells are sampled every N-th cell, so a full forest is legible not solid. */
const SAMPLE_STRIDE = 2;

export interface Vegetation {
  readonly group: THREE.Group;
  sync(): void;
}

export function createVegetation(sim: Sim, tier: QualityTier): Vegetation {
  const group = new THREE.Group();

  const treeGeometry = new THREE.ConeGeometry(0.4, 1.0, 5);
  treeGeometry.translate(0, 0.5, 0);
  const trees = new THREE.InstancedMesh(
    treeGeometry,
    new THREE.MeshLambertMaterial({ color: 0x2f5a2a }),
    MAX_TREES,
  );
  trees.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  trees.frustumCulled = false;
  trees.count = 0;

  // Settlements are drawn as blocks whose size is their tier. Population
  // distribution at a glance is half of "the planet is the scoreboard".
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  buildingGeometry.translate(0, 0.5, 0);
  const buildings = new THREE.InstancedMesh(
    buildingGeometry,
    new THREE.MeshLambertMaterial({ color: 0xd8cbb0 }),
    MAX_BUILDINGS,
  );
  buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  buildings.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_BUILDINGS * 3),
    3,
  );
  buildings.frustumCulled = false;
  buildings.count = 0;

  // Walkers: tiny, and they must separate from any terrain, so they get a rim
  // light in the shader rather than relying on contrast (§7.3 tier 1).
  const walkerGeometry = new THREE.CapsuleGeometry(0.25, 0.5, 3, 6);
  walkerGeometry.translate(0, 0.5, 0);
  const walkers = new THREE.InstancedMesh(walkerGeometry, walkerMaterial(), 1024);
  walkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  walkers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(1024 * 3), 3);
  walkers.frustumCulled = false;
  walkers.count = 0;

  // Lighting lives in `atmosphere.ts`, with the sun it represents.
  if (tier >= 2) group.add(trees);
  group.add(buildings, walkers);

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const colour = new THREE.Color();

  const place = (
    mesh: THREE.InstancedMesh,
    slot: number,
    dir: THREE.Vector3,
    radius: number,
    scale: number,
  ): void => {
    dummy.position.copy(dir).multiplyScalar(radius);
    dummy.quaternion.setFromUnitVectors(up, dir);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  };

  /** Radius at a cell, using the same height scale the mesher uses. */
  const radiusAt = (face: number, x: number, y: number): number => {
    const c = sim.idx(face, x, y);
    const h = sim.height[c] ?? 0;
    const w = sim.water[c] ?? 0;
    return BASE_RADIUS + (h + Math.max(w, 0)) * HEIGHT_TO_RADIUS;
  };

  return {
    group,
    sync(): void {
      // --- trees -------------------------------------------------------------
      if (tier >= 2) {
        let n = 0;
        // Cell scale: one face edge spans a quarter of the circumference.
        const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;
        for (let face = 0; face < 6 && n < MAX_TREES; face++) {
          for (let y = 0; y < sim.N && n < MAX_TREES; y += SAMPLE_STRIDE) {
            for (let x = 0; x < sim.N && n < MAX_TREES; x += SAMPLE_STRIDE) {
              const veg = sim.vegetation[sim.idx(face, x, y)] ?? 0;
              if (veg < VEGETATION_THRESHOLD) continue;
              const dir = cellDirection(face, x, y, sim.N);
              const scale = cellScale * (0.5 + (veg / 255) * 1.1);
              place(trees, n, dir, radiusAt(face, x, y), scale);
              n += 1;
            }
          }
        }
        trees.count = n;
        trees.instanceMatrix.needsUpdate = true;
      }

      // --- settlements -------------------------------------------------------
      const settlements = sim.settlements();
      const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;
      let b = 0;
      for (const s of settlements) {
        if (b >= MAX_BUILDINGS) break;
        const dir = cellDirection(s.face, s.x, s.y, sim.N);
        place(buildings, b, dir, radiusAt(s.face, s.x, s.y), cellScale * (0.4 + s.size * 0.14));
        // Warm for the first god, cool for the second — the same two moods the
        // terrain shader blends by influence.
        colour.setRGB(s.owner === 0 ? 0.95 : 0.62, 0.82, s.owner === 0 ? 0.6 : 0.98);
        buildings.instanceColor?.setXYZ(b, colour.r, colour.g, colour.b);
        b += 1;
      }
      buildings.count = b;
      buildings.instanceMatrix.needsUpdate = true;
      if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;

      // --- walkers -----------------------------------------------------------
      const people = sim.walkers();
      let k = 0;
      for (const p of people) {
        if (k >= 1024) break;
        // Sub-cell position: the simulation moves a point in Q16.16 and the
        // renderer draws a figure around it (§4.5). No feedback, ever.
        const dir = cellDirection(p.face, Math.floor(p.x), Math.floor(p.y), sim.N);
        const radius = radiusAt(p.face, Math.floor(p.x), Math.floor(p.y));
        place(walkers, k, dir, radius, cellScale * (0.3 + p.strength * 0.05));
        colour.setRGB(p.owner === 0 ? 1.0 : 0.5, 0.85, p.owner === 0 ? 0.5 : 1.0);
        walkers.instanceColor?.setXYZ(k, colour.r, colour.g, colour.b);
        k += 1;
      }
      walkers.count = k;
      walkers.instanceMatrix.needsUpdate = true;
      if (walkers.instanceColor) walkers.instanceColor.needsUpdate = true;
    },
  };
}

/** Lambert plus a rim term, so a walker never disappears into the ground. */
function walkerMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <output_fragment>",
      `#include <output_fragment>
       vec3 vd = normalize(vViewPosition);
       float rimTerm = pow(1.0 - max(dot(normalize(vNormal), vd), 0.0), 2.0);
       gl_FragColor.rgb += rimTerm * 0.55;`,
    );
  };
  return material;
}
