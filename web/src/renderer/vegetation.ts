/**
 * Instanced vegetation, settlements, walkers, pickups and papal magnets.
 * HANDOFF §7.3 tier 2, §7.4.
 *
 * Density comes from the `vegetation` field, which is *simulation state*
 * (§3.7) — the same field that damps water transfer in §4.3. So when a player
 * cuts a notch in a treeline and the next flood focuses through it, the trees
 * that vanished are the ones that stopped damping. The picture and the mechanic
 * are the same number.
 *
 * Everything is one instanced draw call per kind.
 *
 * # Scale is not free choice here
 *
 * `HEIGHT_TO_RADIUS` puts the planet's entire relief at about 2.4 cell widths
 * (`docs/specs/rendering.md`). Anything standing on the surface is therefore
 * competing with the mountains for silhouette, and a tree that used to be
 * `cellScale * 1.6` tall was two thirds the height of the tallest peak on the
 * planet — from orbit the forests read as a lattice of spikes sawing through
 * the limb, which is precisely the curvature §7.2 calls the visual identity.
 * Everything here is sized as a fraction of a cell with that in mind.
 *
 * # Placement is hashed, not random
 *
 * Jitter and rotation come from a hash of `(face, x, y, slot)`, never from
 * `Math.random`. The look has to be identical on reload and identical between
 * two clients watching the same match, and a reshuffling forest would be a
 * distraction rather than a variation. This is render-side and deliberately
 * unconnected to the simulation PRNG (§10).
 */

import * as THREE from "three";
import type { Sim } from "../main";
import type { QualityTier } from "../main";
import { SKY_GLSL } from "./atmosphere";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirectionInto } from "./planet";
import type { View } from "./view";

/** Vegetation density below which a cell grows nothing worth drawing. */
const VEGETATION_THRESHOLD = 40;
/** Instance budget. Beyond this the planet reads as moss, not as forest. */
const MAX_TREES = 6000;
/** Settlements draw as a cluster, so the budget is blocks and not settlements. */
const MAX_BLOCKS = 2048;
const MAX_WALKERS = 1024;
const MAX_PICKUPS = 32;
/** Cells are sampled every N-th cell, so a full forest is legible not solid. */
const SAMPLE_STRIDE = 2;
/** Ticks between tree rebuilds. Vegetation grows over minutes, not frames. */
const TREE_REBUILD_TICKS = 15;

/** Walker flag bits, mirroring `world.rs`. */
const WALKER_LEADER = 1 << 1;
const WALKER_CHAMPION = 1 << 2;

export interface Vegetation {
  readonly group: THREE.Group;
  sync(tick: number): void;
}

/**
 * Deterministic hash to the unit interval.
 *
 * Integer mixing rather than `Math.sin` tricks: this is called tens of thousands
 * of times per rebuild, and a hash with visible structure would put that
 * structure into the forest.
 */
function hash01(a: number, b: number, c: number, d: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0;
  h = (h + Math.imul(c, 2246822519) + Math.imul(d, 3266489917)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createVegetation(sim: Sim, tier: QualityTier, view: View): Vegetation {
  const group = new THREE.Group();

  // A cone this slender reads as a conifer at the scales below; a fatter one
  // reads as a traffic cone.
  const treeGeometry = new THREE.ConeGeometry(0.34, 1.0, 5);
  treeGeometry.translate(0, 0.5, 0);
  const trees = new THREE.InstancedMesh(
    treeGeometry,
    // Lighter than the old 0x2f5a2a: at this ambient level a dark albedo made
    // every face away from the sun read as black rather than as shadow.
    //
    // Hazed like the ground it stands on. A forest is the densest edge detail on
    // the planet, so a treeline that stayed crisp against ground the air had
    // already washed out was the one thing that gave the horizon away as a
    // painted band rather than as distance.
    hazedLambert(view, 0x4a7a3c),
    MAX_TREES,
  );
  trees.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  trees.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TREES * 3), 3);
  trees.frustumCulled = false;
  trees.count = 0;

  // Settlements are drawn as a *cluster* of blocks whose count is their tier.
  // Population distribution at a glance is half of "the planet is the
  // scoreboard", and one box scaled up by tier is the same silhouette at every
  // tier — a village and a town differed only in how many pixels they covered.
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  buildingGeometry.translate(0, 0.5, 0);
  const buildingMaterial = settlementMaterial(view);
  const buildings = new THREE.InstancedMesh(buildingGeometry, buildingMaterial, MAX_BLOCKS);
  buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  buildings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOCKS * 3), 3);
  buildings.frustumCulled = false;
  buildings.count = 0;

  // Walkers: tiny, and they must separate from any terrain, so they get a rim
  // light in the shader rather than relying on contrast (§7.3 tier 1).
  const walkerGeometry = new THREE.CapsuleGeometry(0.25, 0.5, 3, 6);
  walkerGeometry.translate(0, 0.5, 0);
  const walkers = new THREE.InstancedMesh(walkerGeometry, walkerMaterial(view), MAX_WALKERS);
  walkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  walkers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WALKERS * 3), 3);
  walkers.frustumCulled = false;
  walkers.count = 0;

  // One-shot pickups (§5.3): free single-use powers lying on the terrain.
  // Contested map objects, so they have to be findable from orbit — hence a
  // bright unlit octahedron rather than something that shades into the ground.
  const pickupMesh = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 }),
    MAX_PICKUPS,
  );
  pickupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pickupMesh.frustumCulled = false;
  pickupMesh.count = 0;

  // The papal magnet (§5.1). It had no visual at all, despite being the game's
  // only click-verb and the anchor of the leader-invincibility rule of §4.7 —
  // "my leader is safe on the magnet" is unusable advice if you cannot see
  // where the magnet is. A spire, because it has to be findable from orbit and
  // anything lying flat on the ground is not.
  const magnetGeometry = new THREE.ConeGeometry(0.16, 1.0, 4);
  magnetGeometry.translate(0, 0.5, 0);
  const magnets = new THREE.InstancedMesh(magnetGeometry, walkerMaterial(view), 2);
  magnets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  magnets.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(2 * 3), 3);
  magnets.frustumCulled = false;
  magnets.count = 0;

  // Lighting lives in `atmosphere.ts`, with the sun it represents.
  if (tier >= 2) group.add(trees);
  group.add(buildings, walkers, pickupMesh, magnets);

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const colour = new THREE.Color();
  /** Hoisted: this is inside a per-walker loop that runs every tick. */
  const leaderTint = new THREE.Color(1.0, 0.95, 0.7);
  /** One face edge spans a quarter of the circumference. */
  const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;

  /**
   * Write one instance, standing on the surface along `dir`.
   *
   * `turn` rotates the model about its own local up, which is what stops a few
   * thousand identical cones from reading as clones of one asset.
   */
  const place = (
    mesh: THREE.InstancedMesh,
    slot: number,
    radius: number,
    scale: number,
    turn: number,
  ): void => {
    dummy.position.copy(dir).multiplyScalar(radius);
    dummy.quaternion.setFromUnitVectors(up, dir);
    if (turn !== 0) {
      spin.setFromAxisAngle(dir, turn);
      dummy.quaternion.premultiply(spin);
    }
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  };

  /** Surface radius at a cell, using the same height scale the mesher uses. */
  const radiusAt = (face: number, x: number, y: number): number => {
    const c = sim.idx(face, x, y);
    const h = sim.height[c] ?? 0;
    const w = sim.water[c] ?? 0;
    return BASE_RADIUS + (h + Math.max(w, 0)) * HEIGHT_TO_RADIUS;
  };

  /**
   * Keep a continuous face coordinate on its own face.
   *
   * Face coordinates run `0..N`. Hashed jitter and settlement spread both push
   * past that near an edge — a tree sampled at `x = 0` can land at `-0.5` — and
   * `cellDirectionInto` projects rather than switching faces, so it happily
   * extrapolates a direction *past* the cube face and the instance ends up off
   * the surface it belongs to, doubled up with the neighbouring face's. Clamping
   * is the right answer rather than seam-crossing: the offset is decorative, and
   * a tree pinned to the edge of its face is in the right place to within a
   * fraction of a cell.
   */
  const onFace = (f: number): number => (f < 0 ? 0 : f > sim.N ? sim.N : f);

  /**
   * Surface radius at a continuous face coordinate, bilinearly.
   *
   * A walker moving across a slope should climb it, not step up at each cell
   * boundary. Cell `i` is centred at `i + 0.5`, so the four cells bracketing a
   * position are found by flooring `f - 0.5`.
   */
  const surfaceAt = (face: number, fx: number, fy: number): number => {
    const last = sim.N - 1;
    const gx = fx - 0.5;
    const gy = fy - 0.5;
    const x0 = Math.min(last, Math.max(0, Math.floor(gx)));
    const y0 = Math.min(last, Math.max(0, Math.floor(gy)));
    const x1 = Math.min(last, x0 + 1);
    const y1 = Math.min(last, y0 + 1);
    const tx = Math.min(1, Math.max(0, gx - x0));
    const ty = Math.min(1, Math.max(0, gy - y0));
    const r00 = radiusAt(face, x0, y0);
    const r10 = radiusAt(face, x1, y0);
    const r01 = radiusAt(face, x0, y1);
    const r11 = radiusAt(face, x1, y1);
    return r00 * (1 - tx) * (1 - ty) + r10 * tx * (1 - ty) + r01 * (1 - tx) * ty + r11 * tx * ty;
  };

  const rebuildTrees = (): void => {
    let n = 0;
    for (let face = 0; face < 6 && n < MAX_TREES; face++) {
      for (let y = 0; y < sim.N && n < MAX_TREES; y += SAMPLE_STRIDE) {
        for (let x = 0; x < sim.N && n < MAX_TREES; x += SAMPLE_STRIDE) {
          const veg = sim.vegetation[sim.idx(face, x, y)] ?? 0;
          if (veg < VEGETATION_THRESHOLD) continue;
          // Denser cells get more stems rather than one bigger stem, so
          // density reads as density and not as gigantism.
          const stems = 1 + Math.floor((veg / 256) * 3);
          for (let s = 0; s < stems && n < MAX_TREES; s++) {
            // Offset inside the sampled block, so the lattice disappears.
            const jx = onFace(x + 0.5 + (hash01(face, x, y, s * 3 + 1) - 0.5) * SAMPLE_STRIDE);
            const jy = onFace(y + 0.5 + (hash01(face, x, y, s * 3 + 2) - 0.5) * SAMPLE_STRIDE);
            cellDirectionInto(dir, face, jx, jy, sim.N);
            const vary = hash01(face, x, y, s * 3 + 3);
            // A third of a cell, give or take: present in the silhouette,
            // nowhere near competing with the relief.
            const scale = cellScale * (0.2 + (veg / 255) * 0.16 + vary * 0.1);
            place(trees, n, surfaceAt(face, jx, jy), scale, vary * Math.PI * 2);
            // Two greens and everything between, so a forest is not one colour.
            const tint = 0.82 + vary * 0.36;
            colour.setRGB(tint * 0.92, tint, tint * 0.78);
            trees.instanceColor?.setXYZ(n, colour.r, colour.g, colour.b);
            n += 1;
          }
        }
      }
    }
    trees.count = n;
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
  };

  let treesBuiltAt = -TREE_REBUILD_TICKS;
  let builtAt = -1;

  return {
    group,
    sync(tick: number): void {
      // Every instance below is a function of simulation state, which only
      // changes on a tick. At 60 fps against a 30 Hz simulation this was doing
      // all of it twice per tick, and on a 144 Hz display nearly five times.
      if (tick === builtAt) return;
      builtAt = tick;

      // --- trees -------------------------------------------------------------
      // Vegetation grows over minutes. Rebuilding 6,000 instances every tick to
      // show it was the single most expensive thing in the frame.
      if (tier >= 2 && tick - treesBuiltAt >= TREE_REBUILD_TICKS) {
        treesBuiltAt = tick;
        rebuildTrees();
      }

      // --- settlements -------------------------------------------------------
      const settlements = sim.settlements();
      let b = 0;
      for (const s of settlements) {
        // Warm for the first god, cool for the second — the same two moods the
        // terrain shader blends by influence.
        colour.setRGB(s.owner === 0 ? 0.95 : 0.62, 0.82, s.owner === 0 ? 0.6 : 0.98);
        const blocks = Math.min(6, 1 + s.tier);
        for (let k = 0; k < blocks && b < MAX_BLOCKS; k++) {
          // The first block sits on the centre; the rest ring it, so a tier
          // rise adds buildings to a village instead of inflating one house.
          const angle = hash01(s.face, s.x, s.y, k) * Math.PI * 2;
          const spread = k === 0 ? 0 : 0.55 + hash01(s.face, s.x, s.y, k + 8) * 0.5;
          const fx = onFace(s.x + 0.5 + Math.cos(angle) * spread);
          const fy = onFace(s.y + 0.5 + Math.sin(angle) * spread);
          cellDirectionInto(dir, s.face, fx, fy, sim.N);
          const scale = cellScale * (k === 0 ? 0.42 : 0.26 + hash01(s.face, s.x, s.y, k) * 0.12);
          place(buildings, b, surfaceAt(s.face, fx, fy), scale, angle);
          buildings.instanceColor?.setXYZ(b, colour.r, colour.g, colour.b);
          b += 1;
        }
      }
      buildings.count = b;
      buildings.instanceMatrix.needsUpdate = true;
      if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;

      // --- walkers -----------------------------------------------------------
      const people = sim.walkers();
      let k = 0;
      for (const p of people) {
        if (k >= MAX_WALKERS) break;
        // Sub-cell position: the simulation moves a point in Q16.16 and the
        // renderer draws a figure around it (§4.5). Flooring it here — which is
        // what this did — threw that away and teleported every walker from one
        // cell centre to the next. No feedback, ever: this reads, never writes.
        // Clamped for the same reason as the trees: a walker part-way through a
        // seam crossing can carry a sub-cell offset just outside its face.
        const wx = onFace(p.x);
        const wy = onFace(p.y);
        cellDirectionInto(dir, p.face, wx, wy, sim.N);
        // Rank, not strength, drives size. Scaling by `strength` turned a
        // veteran into a giant, and §4.7 lets strength reach 255.
        const champion = (p.flags & WALKER_CHAMPION) !== 0;
        const leader = (p.flags & WALKER_LEADER) !== 0;
        const scale = cellScale * (champion ? 0.95 : leader ? 0.78 : 0.5);
        place(walkers, k, surfaceAt(p.face, wx, wy), scale, 0);
        // Owner hue, then rank on top of it: a champion has to be findable in a
        // crowd of its own colour, and it had no distinguishing mark at all.
        if (p.owner === 0) colour.setRGB(1.0, 0.85, 0.5);
        else colour.setRGB(0.5, 0.85, 1.0);
        if (champion) colour.setRGB(1.0, 0.42, 0.24);
        else if (leader) colour.lerp(leaderTint, 0.55);
        walkers.instanceColor?.setXYZ(k, colour.r, colour.g, colour.b);
        k += 1;
      }
      walkers.count = k;
      walkers.instanceMatrix.needsUpdate = true;
      if (walkers.instanceColor) walkers.instanceColor.needsUpdate = true;

      // --- pickups -----------------------------------------------------------
      const drops = sim.pickups();
      let q = 0;
      for (const d of drops) {
        if (q >= MAX_PICKUPS) break;
        cellDirectionInto(dir, d.face, d.x + 0.5, d.y + 0.5, sim.N);
        // Floating just clear of the ground so it reads as an object rather
        // than as terrain decoration, and turning, so it catches the eye.
        place(
          pickupMesh,
          q,
          radiusAt(d.face, d.x, d.y) + cellScale * 0.9,
          cellScale * 0.5,
          (tick / 30) * 1.2,
        );
        q += 1;
      }
      pickupMesh.count = q;
      pickupMesh.instanceMatrix.needsUpdate = true;

      // --- papal magnets -----------------------------------------------------
      let m = 0;
      for (let player = 0; player < 2; player++) {
        if (sim.e.dio_magnet_active(player) === 0) continue;
        const face = sim.e.dio_magnet_face(player);
        const mx = sim.e.dio_magnet_x(player);
        const my = sim.e.dio_magnet_y(player);
        cellDirectionInto(dir, face, mx + 0.5, my + 0.5, sim.N);
        place(magnets, m, radiusAt(face, mx, my), cellScale * 2.2, (tick / 30) * 0.35);
        colour.setRGB(player === 0 ? 1.0 : 0.55, 0.9, player === 0 ? 0.55 : 1.0);
        magnets.instanceColor?.setXYZ(m, colour.r, colour.g, colour.b);
        m += 1;
      }
      magnets.count = m;
      magnets.instanceMatrix.needsUpdate = true;
      if (magnets.instanceColor) magnets.instanceColor.needsUpdate = true;
    },
  };
}

/**
 * A `MeshLambertMaterial` that stands in the same air as the terrain, plus an
 * optional snippet of its own.
 *
 * # Why everything here goes through one function
 *
 * The aerial perspective of `atmosphere.ts` is what makes the horizon read as
 * sky, and it only works if *everything* on the ground obeys it. Instanced
 * objects are the easiest to forget and the worst to get wrong: they are the
 * high-frequency detail in the frame, so a forest or a town that stays crisp
 * against hazed ground is more conspicuous than the haze itself.
 *
 * # Two shader patches that were quietly doing nothing
 *
 * The settlement night-lights and the walker rim light were both injected at
 * `#include <output_fragment>`, and three renamed that chunk to `opaque_fragment`
 * in r155 — this project is on r180. `String.replace` with no match returns the
 * string unchanged and reports nothing, so both features had been compiled out
 * for as long as the dependency has been current: the night hemisphere had no
 * settlement lights on it (§7.3 tier 2's stated readability argument) and
 * walkers had no rim (§7.3 tier 1). Injecting *before* `opaque_fragment` and
 * writing `outgoingLight` rather than `gl_FragColor` is also the correct place
 * on its own merits — it lands before tone mapping and colour conversion instead
 * of adding linear light to an sRGB pixel.
 *
 * `extra` therefore runs on `outgoingLight`, and the haze is applied after it,
 * so a lit window seen across the planet is dimmed by the air like everything
 * else.
 */
function hazedLambert(view: View, colour: number, extra = ""): THREE.MeshLambertMaterial {
  // No `vertexColors: true`. It defines `USE_COLOR`, and `color_vertex.glsl`
  // then runs `vColor *= color` against a `color` attribute that does not exist
  // on this geometry. `MeshLambertMaterial` — unlike `ShaderMaterial` — has no
  // `defaultAttributeValues`, so the generic attribute is (0,0,0,1), `vColor`
  // collapses to zero, and every settlement and walker rendered *black*. The
  // per-instance colour arrives through `instanceColor`, which sets
  // `USE_INSTANCING_COLOR` on its own and needs no help from the material.
  const material = new THREE.MeshLambertMaterial({ color: colour });
  material.onBeforeCompile = (shader) => {
    // Shared by reference — see `view.ts`.
    shader.uniforms.uSunDirection = view.sunDirection;
    shader.uniforms.uCameraPosition = view.cameraPosition;
    shader.uniforms.uWarning = view.warning;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vDioWorld;`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
         // Through the instance matrix, which the world position this used to
         // compute did not go through: for an InstancedMesh, \`transformed\` is
         // still the *local* vertex, so the old
         // \`(modelMatrix * vec4(transformed, 1.0)).xyz\` gave every building on
         // the planet the same handful of positions near the origin — and the
         // night-side test below reduced to which corner of the box a fragment
         // was on rather than which side of the planet it stood on.
         vec4 dioLocal = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           dioLocal = instanceMatrix * dioLocal;
         #endif
         vDioWorld = (modelMatrix * dioLocal).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vDioWorld;
         uniform vec3 uSunDirection;
         uniform vec3 uCameraPosition;
         uniform float uWarning;
         ${SKY_GLSL}`,
      )
      .replace(
        "#include <opaque_fragment>",
        `${extra}
         {
           vec4 dioAir = dioAerial(vDioWorld, uCameraPosition, uSunDirection, uWarning);
           outgoingLight = mix(outgoingLight, dioAir.rgb, dioAir.a);
         }
         #include <opaque_fragment>`,
      );
  };
  return material;
}

/**
 * Settlements, with night-side lights (§7.3 tier 2).
 *
 * "Night side with emissive settlement lights. Doubles as readability —
 * population distribution at a glance." That second clause is the reason it is
 * tier 2 rather than tier 3: with no HUD, the night hemisphere is otherwise the
 * one place where you cannot read who holds what.
 */
function settlementMaterial(view: View): THREE.MeshLambertMaterial {
  return hazedLambert(
    view,
    0xd8cbb0,
    /* glsl */ `
      // Lights come on where the sun has gone down, and only there.
      float dioNight = smoothstep(0.12, -0.25, dot(normalize(vDioWorld), uSunDirection));
      outgoingLight += vColor * vec3(1.0, 0.72, 0.36) * dioNight * 0.9;`,
  );
}

/** Lambert plus a rim term, so a walker never disappears into the ground. */
function walkerMaterial(view: View): THREE.MeshLambertMaterial {
  return hazedLambert(
    view,
    0xffffff,
    /* glsl */ `
      vec3 dioView = normalize(vViewPosition);
      float dioRim = pow(1.0 - max(dot(normalize(vNormal), dioView), 0.0), 2.0);
      outgoingLight += dioRim * 0.55;`,
  );
}
