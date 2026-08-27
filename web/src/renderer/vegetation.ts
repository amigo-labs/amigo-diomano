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
import { mergeGeometries, readGlb, withTransform } from "./geometry";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirectionInto } from "./planet";
import type { View } from "./view";

/** Vegetation density below which a cell grows a tree. */
const VEGETATION_THRESHOLD = 40;
/**
 * Density below which a cell grows nothing at all.
 *
 * Between this and `VEGETATION_THRESHOLD` a cell grows *undergrowth*. That band
 * used to draw nothing: the terrain shader greens ground from `fertility` the
 * moment a match starts, so a cell that was visibly becoming meadow carried no
 * object of any kind until it crossed 40 in one step and a whole conifer
 * appeared on it. Scrub is what actually grows there.
 */
const UNDERGROWTH_THRESHOLD = 12;

/**
 * Per-species instance budgets.
 *
 * Sized so the worst case is about the same triangle load as the single
 * 6,000-cone forest this replaced (~90k), not four times it: the scrub and the
 * conifer are open-ended cones of five and six triangles, and only the
 * broadleaf pays for a trunk and a crown.
 */
const MAX_CONIFERS = 2400;
const MAX_BROADLEAVES = 1600;
const MAX_PALMS = 700;
const MAX_SCRUB = 4000;
/** Settlements draw as a cluster, so the budget is blocks and not settlements. */
const MAX_BLOCKS = 2048;
const MAX_WALKERS = 1024;
const MAX_PICKUPS = 32;
/** Cells are sampled every N-th cell, so a full forest is legible not solid. */
const SAMPLE_STRIDE = 2;
/** Ticks between flora rebuilds. Vegetation grows over minutes, not frames. */
const FLORA_REBUILD_TICKS = 15;

/** Material ids, mirroring `world.rs`. Only the two the flora keys off. */
const MAT_SAND = 1;
const MAT_SOIL = 2;

/**
 * Height units above the current sea level under which sand is *beach* sand.
 *
 * The same 0.0075 radii the terrain shader draws its beach band over
 * (`planet.ts`), converted back through `HEIGHT_TO_RADIUS`. Palms belong on the
 * strip the shader is already painting as beach, and mirroring the number is
 * how the two agree about where that strip is.
 */
const BEACH_TOP = 0.0075 / HEIGHT_TO_RADIUS;

/** Above this, conifers only: the treeline, in height units above sea level. */
const CONIFER_LINE = 360;

/** Fertility under which a cell grows conifers whatever its altitude. */
const CONIFER_FERTILITY = 96;

/** Fertility a beach sand cell needs before it grows a palm. */
const PALM_FERTILITY = 60;

/**
 * Fertility at which bare ground grows scrub even with nothing sprouted yet.
 *
 * Measured rather than guessed. `vegetation` is capped at `fertility`, so the
 * *most* fertile ground is exactly the ground that becomes forest and never
 * needs scrub; on a grown archipelago at tick 9,000 only ~57 land cells carry
 * fertility above 192 and every one of them is already wooded. The band that
 * has nowhere else to go is the middle one — fertile enough to be painted as
 * meadow by the terrain shader, never fertile enough to raise a tree.
 */
const SCRUB_FERTILITY = 40;

/** Walker flag bits, mirroring `world.rs`. */
const WALKER_LEADER = 1 << 1;
const WALKER_CHAMPION = 1 << 2;

/**
 * The figure's proportions, mirroring `scripts/build-figure.mjs`.
 *
 * The model carries no rig — a thousand skinned meshes is not a budget this
 * project has — so the walk cycle is a vertex-shader rotation about these
 * heights, and the limbs are read back out of the geometry by comparing each
 * vertex against them. Move a joint in the generator without moving it here and
 * an arm will swing as a torso.
 *
 * Reading limbs from *positions* rather than from an attribute the generator
 * writes is deliberate: it means any humanoid in a roughly upright pose can
 * replace `villager.glb` by being dropped in its place, which is what keeps the
 * door open to a downloaded CC0 character.
 */
const FIGURE = { hip: 0.46, shoulder: 0.7, torsoHalfWidth: 0.115 } as const;

/** Limb ids, as the vertex shader reads them. */
const LIMB = { body: 0, armLeft: 1, armRight: 2, legLeft: 3, legRight: 4 } as const;

export interface Vegetation {
  readonly group: THREE.Group;
  /**
   * `alpha` is the sub-tick interpolation factor from `loop.ts`.
   *
   * Everything here except the walkers is a function of simulation state and is
   * rebuilt only when `tick` changes; the walkers are drawn every frame, because
   * at 30 Hz against a 60 or 144 Hz display a population that only moved on a
   * tick visibly stepped. The factor has been available since the loop was
   * written and only the hand ever used it.
   */
  sync(tick: number, alpha: number): void;
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

  /**
   * One instanced mesh per species, wired the same way.
   *
   * The base colours are all lighter than they look like they should be: at
   * this ambient level a dark albedo makes every face away from the sun read as
   * black rather than as shadow. And every one of them is hazed like the ground
   * it stands on — a forest is the densest edge detail on the planet, so a
   * treeline that stayed crisp against ground the air had already washed out
   * was the one thing that gave the horizon away as a painted band rather than
   * as distance.
   */
  const species = (geometry: THREE.BufferGeometry, colour: number, cap: number) => {
    const mesh = new THREE.InstancedMesh(geometry, hazedLambert(view, colour), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.frustumCulled = false;
    mesh.count = 0;
    return mesh;
  };

  // A cone this slender reads as a conifer at the scales below; a fatter one
  // reads as a traffic cone. Open-ended: the base is never visible — the thing
  // stands on the ground — and it is a third of the triangles.
  const coniferGeometry = new THREE.ConeGeometry(0.3, 1.0, 5, 1, true);
  coniferGeometry.translate(0, 0.5, 0);
  const conifers = species(coniferGeometry, 0x36802a, MAX_CONIFERS);

  // A trunk and a crown, which is the whole difference: a broadleaf read at
  // this scale is a blob held up off the ground, and a conifer is a blob that
  // reaches it.
  const broadleafGeometry = mergeGeometries([
    withTransform(new THREE.CylinderGeometry(0.07, 0.11, 0.52, 5, 1, true), (g) =>
      g.translate(0, 0.26, 0),
    ),
    withTransform(new THREE.IcosahedronGeometry(0.42, 0), (g) => {
      g.scale(1.0, 0.78, 1.0);
      g.translate(0, 0.74, 0);
    }),
  ]);
  const broadleaves = species(broadleafGeometry, 0x4f9c33, MAX_BROADLEAVES);

  // A palm is its silhouette: a bare leaning stem with everything at the top.
  // Six fronds, each a flat wedge angled out and drooping, because a palm drawn
  // with a round crown is just a small broadleaf.
  const frondGeometries: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.PlaneGeometry(0.24, 0.86);
    // Pivot at the stem end, so the rotations below swing the frond rather than
    // sliding it.
    frond.translate(0, -0.43, 0);
    frond.rotateX(-Math.PI / 2);
    frond.rotateZ(0.55);
    frond.rotateY((i / 6) * Math.PI * 2);
    frond.translate(0, 0.92, 0);
    frondGeometries.push(frond);
  }
  const palmGeometry = mergeGeometries([
    withTransform(new THREE.CylinderGeometry(0.045, 0.075, 0.94, 4, 1, true), (g) => {
      g.translate(0, 0.47, 0);
      // A lean, so a stand of palms is not a row of posts.
      g.rotateZ(0.13);
    }),
    ...frondGeometries,
  ]);
  const palms = species(palmGeometry, 0x67a83c, MAX_PALMS);

  // Scrub: the cheapest thing that reads as ground cover rather than as a small
  // tree. Wider than it is tall, and it never gets a trunk.
  const scrubGeometry = new THREE.ConeGeometry(0.55, 0.4, 6, 1, true);
  scrubGeometry.translate(0, 0.2, 0);
  const scrub = species(scrubGeometry, 0x5c7a2c, MAX_SCRUB);

  /** Species indices into `flora`, so the rules below read as what they mean. */
  const CONIFER = 0;
  const BROADLEAF = 1;
  const PALM = 2;
  const SCRUB = 3;
  const flora = [conifers, broadleaves, palms, scrub] as const;

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
  //
  // A capsule until the model lands, and then people. The capsule is not a
  // placeholder that was never replaced — it is what the population looks like
  // for the fraction of a second before `villager.glb` finishes loading, and
  // the swap costs one geometry assignment because the instance transforms do
  // not care what they are transforming.
  const walkerGeometry = new THREE.CapsuleGeometry(0.25, 0.5, 3, 6);
  walkerGeometry.translate(0, 0.5, 0);
  const walkerMat = walkerMaterial(view);
  const walkers: THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material> =
    new THREE.InstancedMesh(walkerGeometry, walkerMat, MAX_WALKERS);
  /**
   * Walk phase, one float per instance: the fraction is the phase and the sign
   * says whether this figure is moving. Attached to whichever geometry is
   * current, so it survives the swap from capsule to model.
   */
  const walkPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WALKERS), 1);
  walkPhase.setUsage(THREE.DynamicDrawUsage);
  /**
   * Every vertex of the stand-in capsule is "body", so it bobs and swings
   * nothing. The attribute has to exist on it regardless: a shader that
   * declares an attribute the geometry lacks reads a generic value, and three
   * gives no warning that it happened.
   */
  const capsuleLimbs = new Float32Array(walkerGeometry.getAttribute("position").count);
  walkerGeometry.setAttribute("limb", new THREE.BufferAttribute(capsuleLimbs, 1));
  walkerGeometry.setAttribute("walk", walkPhase);
  walkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  walkers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WALKERS * 3), 3);
  walkers.frustumCulled = false;
  walkers.count = 0;

  /**
   * Fetch the figure and put the population inside it.
   *
   * Fetched rather than bundled, and read by `readGlb` rather than by three's
   * `GLTFLoader` — which costs 45 kB of itself plus 214 kB of three it drags
   * back in, to read a file whose entire content is two float arrays. See
   * `geometry.ts` for the whole argument.
   *
   * The limb attribute is computed here rather than read from the file, so the
   * file stays a plain glTF that anything can produce — see `FIGURE`.
   */
  const loadFigure = async (): Promise<void> => {
    const response = await fetch("/models/villager.glb");
    if (!response.ok) throw new Error(`villager.glb: ${response.status}`);
    const geometry = readGlb(await response.arrayBuffer());

    const position = geometry.getAttribute("position");
    const limbs = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      // Order matters: a leg is decided by height alone, an arm needs height
      // *and* being outboard of the torso, or the chest swings with the arms.
      if (y < FIGURE.hip) limbs[i] = x < 0 ? LIMB.legLeft : LIMB.legRight;
      else if (y < FIGURE.shoulder && Math.abs(x) > FIGURE.torsoHalfWidth) {
        limbs[i] = x < 0 ? LIMB.armLeft : LIMB.armRight;
      } else limbs[i] = LIMB.body;
    }
    geometry.setAttribute("limb", new THREE.BufferAttribute(limbs, 1));

    geometry.setAttribute("walk", walkPhase);
    walkers.geometry.dispose();
    walkers.geometry = geometry;
  };

  // Started here rather than awaited anywhere: `createVegetation` runs behind
  // the title card, so the model and three's glTF loader arrive during the same
  // window the wasm and the renderer do, and the match never waits for them.
  //
  // A failure keeps the capsules. A population drawn as capsules is a worse
  // game than one drawn as people and it is still a game; a black screen
  // because a decorative mesh 404'd is not.
  void loadFigure().catch((err: unknown) => {
    console.warn("the figure model did not load; drawing capsules", err);
  });

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
  if (tier >= 2) group.add(...flora);
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

  /**
   * Which tree a *forested* cell grows, as an index into `flora`.
   *
   * Everything it reads is already in the renderer's views — material,
   * fertility, height against the live sea level — so this needs nothing new
   * from the simulation and cannot feed anything back into it. `vary` is the
   * cell's own deterministic hash: it blurs the two thresholds that would
   * otherwise draw a hard line across a hillside, which is the difference
   * between a treeline and a contour.
   */
  const treeAt = (material: number, fertility: number, above: number, vary: number): number => {
    // Cold and thin ground is conifer country, with the line itself softened by
    // a quarter of its own height.
    if (above > CONIFER_LINE * (0.85 + vary * 0.3)) return CONIFER;
    if (fertility < CONIFER_FERTILITY * (0.8 + vary * 0.4)) return CONIFER;
    // Rich soil grows broadleaves; rich anything-else does not.
    return material === MAT_SOIL ? BROADLEAF : CONIFER;
  };

  /**
   * Rebuild every species.
   *
   * # Two sources, deliberately
   *
   * Forest comes from `vegetation` — what actually grew, and what the water
   * solver is damped by. Palms and scrub come from `fertility` — the potential.
   * That split is not a shortcut, it is the same one the terrain shader already
   * makes and documents: generation writes fertility and leaves vegetation at
   * zero, so fertile ground reads as meadow from tick zero rather than staying
   * bare until trees appear.
   *
   * It is also the only rule that can put a palm on a beach at all. The
   * `VEGETATION` rule in `materials.rs` grows only where the material is
   * `MAT_SOIL`, so a sand cell's `vegetation` is zero for the whole match: a
   * palm gated on it would have been code that never once ran. Keying the beach
   * off sand plus fertility is what a palm fringe actually is.
   */
  const rebuildFlora = (): void => {
    const counts = [0, 0, 0, 0];
    const caps = [MAX_CONIFERS, MAX_BROADLEAVES, MAX_PALMS, MAX_SCRUB];
    const seaLevel = sim.e.dio_sea_level();

    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < sim.N; y += SAMPLE_STRIDE) {
        for (let x = 0; x < sim.N; x += SAMPLE_STRIDE) {
          const c = sim.idx(face, x, y);
          const above = (sim.height[c] ?? 0) - seaLevel;
          // Nothing grows under the sea, and the sea moves.
          if (above <= 0) continue;

          const veg = sim.vegetation[c] ?? 0;
          const fert = sim.fertility[c] ?? 0;
          const material = sim.material[c] ?? 0;
          const vary0 = hash01(face, x, y, 0);

          let kind: number;
          let stems: number;
          if (material === MAT_SAND && above < BEACH_TOP && fert >= PALM_FERTILITY) {
            // The beach fringe. One palm per sampled block at most: a palm is a
            // silhouette, and a thicket of them is a hedge.
            kind = PALM;
            stems = 1;
          } else if (veg >= VEGETATION_THRESHOLD) {
            kind = treeAt(material, fert, above, vary0);
            // Denser cells get more stems rather than one bigger stem, so
            // density reads as density and not as gigantism.
            stems = 1 + Math.floor((veg / 256) * 3);
          } else if (veg >= UNDERGROWTH_THRESHOLD || fert >= SCRUB_FERTILITY) {
            kind = SCRUB;
            stems = 1 + Math.floor(Math.max(veg, fert / 3) / 24);
          } else {
            continue;
          }

          const mesh = flora[kind];
          const cap = caps[kind] ?? 0;
          if (!mesh) continue;

          for (let stem = 0; stem < stems; stem++) {
            let n = counts[kind] ?? 0;
            if (n >= cap) break;
            // Offset inside the sampled block, so the lattice disappears.
            const jx = onFace(x + 0.5 + (hash01(face, x, y, stem * 3 + 1) - 0.5) * SAMPLE_STRIDE);
            const jy = onFace(y + 0.5 + (hash01(face, x, y, stem * 3 + 2) - 0.5) * SAMPLE_STRIDE);
            cellDirectionInto(dir, face, jx, jy, sim.N);
            const vary = hash01(face, x, y, stem * 3 + 3);
            // A third of a cell, give or take: present in the silhouette,
            // nowhere near competing with the relief. A palm stands taller than
            // it is wide and scrub is barely there, which is most of what makes
            // them read as different plants at all.
            const bulk = kind === PALM ? 0.3 : kind === SCRUB ? 0.14 : 0.2;
            const grown = kind === PALM || kind === SCRUB ? 0.06 : (veg / 255) * 0.16;
            const scale = cellScale * (bulk + grown + vary * 0.1);
            place(mesh, n, surfaceAt(face, jx, jy), scale, vary * Math.PI * 2);
            // A spread of greens per species, so no stand is one colour, and
            // the spreads do not overlap enough for two species to be mistaken
            // for each other at range.
            const tint = 0.82 + vary * 0.36;
            if (kind === PALM) colour.setRGB(tint * 0.86, tint, tint * 0.55);
            else if (kind === SCRUB) colour.setRGB(tint * 1.0, tint * 0.94, tint * 0.62);
            else colour.setRGB(tint * 0.92, tint, tint * 0.78);
            mesh.instanceColor?.setXYZ(n, colour.r, colour.g, colour.b);
            n += 1;
            counts[kind] = n;
          }
        }
      }
    }

    for (let kind = 0; kind < flora.length; kind++) {
      const mesh = flora[kind];
      if (!mesh) continue;
      mesh.count = counts[kind] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  /**
   * One record per living figure, keyed by the walker id the simulation gives
   * it, which is what lets a figure be *the same figure* from one tick to the
   * next — and therefore lets it have a heading and a stride at all.
   */
  interface Figure {
    face: number;
    /** Where it was last tick, and where it is now, in face cells. */
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** Facing, as a turn about the surface normal. */
    heading: number;
    /** Walk phase, 0..1, advanced by distance covered rather than by time. */
    phase: number;
    /** Whether it moved this tick. A standing figure must not pedal. */
    moving: boolean;
    /** Colour and size inputs, so the frame loop need not re-read the sim. */
    scale: number;
    r: number;
    g: number;
    b: number;
    /** Tick this record was last touched, for reaping the dead. */
    seen: number;
  }
  const figures = new Map<number, Figure>();
  /** How much walk phase a cell of travel is worth. Two steps per cell. */
  const STRIDE_PER_CELL = 2;

  const trackWalkers = (): void => {
    const tick = builtAt;
    for (const p of sim.walkers()) {
      // Clamped for the same reason as the trees: a walker part-way through a
      // seam crossing can carry a sub-cell offset just outside its face.
      const wx = onFace(p.x);
      const wy = onFace(p.y);
      const champion = (p.flags & WALKER_CHAMPION) !== 0;
      const leader = (p.flags & WALKER_LEADER) !== 0;
      // Owner hue, then rank on top of it: a champion has to be findable in a
      // crowd of its own colour, and it had no distinguishing mark at all.
      if (p.owner === 0) colour.setRGB(1.0, 0.85, 0.5);
      else colour.setRGB(0.5, 0.85, 1.0);
      if (champion) colour.setRGB(1.0, 0.42, 0.24);
      else if (leader) colour.lerp(leaderTint, 0.55);

      let f = figures.get(p.id);
      if (!f) {
        f = {
          face: p.face,
          fromX: wx,
          fromY: wy,
          toX: wx,
          toY: wy,
          heading: 0,
          phase: 0,
          moving: false,
          scale: 0,
          r: 0,
          g: 0,
          b: 0,
          seen: tick,
        };
        figures.set(p.id, f);
      }

      const crossed = f.face !== p.face;
      f.fromX = crossed ? wx : f.toX;
      f.fromY = crossed ? wy : f.toY;
      f.face = p.face;
      f.toX = wx;
      f.toY = wy;

      // Heading and stride from how far it actually travelled. A seam crossing
      // is skipped rather than measured: the two coordinate frames are
      // different, so the difference is meaningless and would spin the figure.
      const dx = f.toX - f.fromX;
      const dy = f.toY - f.fromY;
      const travelled = Math.hypot(dx, dy);
      // `SPEED` is a sixteenth of a cell per tick, so anything above a
      // hundredth is real movement rather than a settling offset.
      f.moving = !crossed && travelled > 0.01;
      if (f.moving) {
        // Face coordinates are the tangent frame `cellDirectionInto` builds
        // from, so an angle in them is an angle about the surface normal.
        f.heading = Math.atan2(dx, dy);
        f.phase = (f.phase + travelled * STRIDE_PER_CELL) % 1;
      }
      // Rank, not strength, drives size. Scaling by `strength` turned a veteran
      // into a giant, and §4.7 lets strength reach 255.
      //
      // Larger than the capsule these replaced, because a person is *thinner*
      // than a capsule: at the capsule's own height the figure read as a
      // scratch, and at the range this game is played from a walker has to
      // survive being a dozen pixels tall standing next to a house.
      f.scale = cellScale * (champion ? 1.5 : leader ? 1.25 : 0.95);
      f.r = colour.r;
      f.g = colour.g;
      f.b = colour.b;
      f.seen = tick;
    }
    // Reap the fallen. Without this the map grows for the whole match and the
    // draw below walks every walker that ever lived.
    for (const [id, f] of figures) {
      if (f.seen !== tick) figures.delete(id);
    }
  };

  /** Write the instance transforms for this *frame*, between two ticks. */
  const drawWalkers = (alpha: number): void => {
    let k = 0;
    for (const f of figures.values()) {
      if (k >= MAX_WALKERS) break;
      // Sub-cell position: the simulation moves a point in Q16.16 and the
      // renderer draws a figure around it (§4.5). This reads, never writes.
      const wx = onFace(f.fromX + (f.toX - f.fromX) * alpha);
      const wy = onFace(f.fromY + (f.toY - f.fromY) * alpha);
      cellDirectionInto(dir, f.face, wx, wy, sim.N);
      place(walkers, k, surfaceAt(f.face, wx, wy), f.scale, f.heading);
      walkers.instanceColor?.setXYZ(k, f.r, f.g, f.b);
      // The walk cycle's per-instance phase. Negative means standing, which is
      // how the shader knows not to pedal on the spot — see `WALK_GLSL`.
      walkPhase.setX(k, f.moving ? f.phase : -f.phase - 1);
      k += 1;
    }
    walkers.count = k;
    walkers.instanceMatrix.needsUpdate = true;
    if (walkers.instanceColor) walkers.instanceColor.needsUpdate = true;
    walkPhase.needsUpdate = true;
  };

  let floraBuiltAt = -FLORA_REBUILD_TICKS;
  let builtAt = -1;
  let rebuiltAt = -1;

  return {
    group,
    sync(tick: number, alpha: number): void {
      // The figures move between ticks; nothing else does.
      if (tick !== builtAt) {
        builtAt = tick;
        trackWalkers();
      }
      drawWalkers(Math.min(Math.max(alpha, 0), 1));

      // Everything below is a function of simulation state, which only changes
      // on a tick. At 60 fps against a 30 Hz simulation this was doing all of it
      // twice per tick, and on a 144 Hz display nearly five times.
      if (tick === rebuiltAt) return;
      rebuiltAt = tick;

      // --- flora -------------------------------------------------------------
      // Vegetation grows over minutes. Rebuilding thousands of instances every
      // tick to show it was the single most expensive thing in the frame.
      if (tier >= 2 && tick - floraBuiltAt >= FLORA_REBUILD_TICKS) {
        floraBuiltAt = tick;
        rebuildFlora();
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
function hazedLambert(
  view: View,
  colour: number,
  extra = "",
  walk?: { vertex: string; main: string },
): THREE.MeshLambertMaterial {
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
    let vertex = shader.vertexShader;
    vertex = inject(
      vertex,
      "#include <common>",
      `#include <common>
       varying vec3 vDioWorld;
       ${walk?.vertex ?? ""}`,
    );
    if (walk) {
      // After `begin_vertex`, which is where `transformed` is defined —
      // `beginnormal_vertex` runs before it, so `objectNormal` is already in
      // scope and both can be swung by the same rotation. Injecting before
      // either would compile against a variable that does not exist yet.
      vertex = inject(vertex, "#include <begin_vertex>", `#include <begin_vertex>\n${walk.main}`);
    }
    vertex = inject(
      vertex,
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
    shader.vertexShader = vertex;

    let fragment = shader.fragmentShader;
    fragment = inject(
      fragment,
      "#include <common>",
      `#include <common>
       varying vec3 vDioWorld;
       uniform vec3 uSunDirection;
       uniform vec3 uCameraPosition;
       uniform float uWarning;
       ${SKY_GLSL}`,
    );
    fragment = inject(
      fragment,
      "#include <opaque_fragment>",
      `${extra}
       {
         vec4 dioAir = dioAerial(vDioWorld, uCameraPosition, uSunDirection, uWarning);
         outgoingLight = mix(outgoingLight, dioAir.rgb, dioAir.a * dioNearHaze(vDioWorld, uCameraPosition));
       }
       #include <opaque_fragment>`,
    );
    shader.fragmentShader = fragment;
  };
  return material;
}

/**
 * `String.replace` against a three shader chunk, but it refuses to do nothing.
 *
 * The failure this exists to prevent already happened once, to two separate
 * features, and went unnoticed for a dependency upgrade: `replace` with no match
 * returns the string unchanged and reports nothing, so a renamed chunk does not
 * break the build, does not warn, and does not fail a test — it just quietly
 * deletes whatever was being injected. A shipped feature stops existing and the
 * only symptom is that the game looks slightly different to someone who
 * remembers.
 *
 * Throwing instead makes that class of upgrade impossible to miss: the first
 * frame that compiles the material fails loudly, in the one place that names the
 * chunk. Loud is the point — the alternative is not "it still works", it is
 * "the feature is gone and nothing said so".
 */
function inject(source: string, marker: string, replacement: string): string {
  if (!source.includes(marker)) {
    throw new Error(
      `shader chunk ${marker} is not in this material — three has renamed or removed it, and the patch that hooks it (aerial perspective, night lights, walker rim) would otherwise compile out in silence.`,
    );
  }
  return source.replace(marker, replacement);
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
    WALK_GLSL,
  );
}

/**
 * The walk cycle, as a vertex-shader hinge per limb.
 *
 * There is no rig. A thousand `SkinnedMesh`es would be a thousand draw calls
 * and a skinning cost this project has no budget for, and the figures are three
 * pixels tall most of the time — so the limbs swing about hard-coded joint
 * heights instead, and the whole population stays one instanced draw call.
 *
 * `limb` comes from `vegetation.ts`, which derives it from vertex positions at
 * load so the model file itself stays a plain glTF. `walk` is per instance: its
 * fractional part is the phase, so figures do not march in step, and its sign
 * carries whether this one is moving at all — a standing figure must not
 * pedal on the spot.
 *
 * Arms swing opposite their diagonal leg, which is the one detail that makes a
 * walk read as a walk rather than as a shuffle.
 */
const WALK_GLSL = {
  vertex: /* glsl */ `
    attribute float limb;
    attribute float walk;
  `,
  main: /* glsl */ `
    {
      float phase = fract(abs(walk));
      // A standing figure holds still: the sign of walk carries "moving".
      float stride = walk < 0.0 ? 0.0 : 1.0;
      float swingA = sin(phase * 6.2831853) * 0.85 * stride;
      float swingB = -swingA;
      float angle = 0.0;
      float pivotY = 0.0;
      if (limb > 2.5) {
        // Legs, from the hip.
        pivotY = ${(0.46).toFixed(3)};
        angle = limb > 3.5 ? swingB : swingA;
      } else if (limb > 0.5) {
        // Arms, from the shoulder, opposite the diagonal leg.
        pivotY = ${(0.7).toFixed(3)};
        angle = limb > 1.5 ? swingA : swingB;
        angle *= 0.7;
      }
      if (angle != 0.0) {
        float c = cos(angle);
        float sn = sin(angle);
        float y = transformed.y - pivotY;
        float z = transformed.z;
        transformed.y = pivotY + y * c - z * sn;
        transformed.z = y * sn + z * c;
        float ny = objectNormal.y;
        float nz = objectNormal.z;
        objectNormal.y = ny * c - nz * sn;
        objectNormal.z = ny * sn + nz * c;
      }
      // A little bob, so the body rises on each step rather than gliding.
      transformed.y += abs(sin(phase * 6.2831853)) * 0.035 * stride;
    }
  `,
};
