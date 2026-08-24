/**
 * Verb effects. HANDOFF §5.2, §5.3, §8.
 *
 * # What was missing
 *
 * Flood, volcano, swamp, earthquake and armageddon had no visual of any kind.
 * The only feedback a cast produced was a procedural audio one-shot and, on the
 * next re-mesh, terrain that had quietly changed — so a power that took effect
 * off screen, or one whose terrain change was subtle, was indistinguishable from
 * a power that never fired. With no HUD (§8) there was nothing else to read.
 *
 * # Driven by the simulation, not by the click
 *
 * Effects come from the verb-event ring in `world.rs`, which records verbs *past*
 * cost and availability gating. Two consequences, both wanted:
 *
 * - a refused power throws no sparks, so the picture never claims something the
 *   simulation declined to do;
 * - the *opponent's* casts are visible, which a click-driven effect system could
 *   not manage — the client sees its own commands and never theirs.
 *
 * The ring is instrumentation and excluded from the state hash, so nothing here
 * can desync a match.
 *
 * # One draw call
 *
 * Every particle for every effect is an instance of one small octahedron, in one
 * `InstancedMesh` with per-instance colour. Particles are integrated on the CPU
 * because there are hundreds, not hundreds of thousands, and a GPU simulation
 * would need a second render target for a feature this size.
 */

import * as THREE from "three";
import type { Sim, VerbEventView } from "../main";
import { VERB } from "../verbs";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirectionInto } from "./planet";

/** Live particles. Beyond this the oldest are recycled. */
const MAX_PARTICLES = 900;

interface Particle {
  /** Unit direction from the planet centre. */
  dir: THREE.Vector3;
  /** Radial and tangential velocity, in radii and radians per second. */
  rise: number;
  drift: THREE.Vector3;
  radius: number;
  life: number;
  maxLife: number;
  size: number;
  colour: THREE.Color;
  /** Fraction of gravity applied to `rise`; 0 for smoke that keeps climbing. */
  fall: number;
}

export interface Effects {
  readonly group: THREE.Group;
  /**
   * Spawn from the events the simulation recorded, then advance.
   *
   * @param dtMs Real frame time. Particles are cosmetic and run on wall clock, so
   *   they neither stutter at 30 Hz nor slow down when the tick rate does.
   * @returns Camera shake amplitude in radii, for the caller to apply.
   */
  sync(sim: Sim, events: readonly VerbEventView[], dtMs: number): number;
}

export function createEffects(sim: Sim): Effects {
  const group = new THREE.Group();

  const mesh = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(1, 0),
    // Unlit and additive: these are sparks, embers and spray, all of which emit
    // rather than reflect. Additive also means they never darken the planet when
    // a burst is over water.
    new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    MAX_PARTICLES,
  );
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = 2;
  group.add(mesh);

  const pool: Particle[] = [];
  const dummy = new THREE.Object3D();
  const scratch = new THREE.Vector3();
  const tangentA = new THREE.Vector3();
  const tangentB = new THREE.Vector3();
  const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;

  /** Deterministic per-event jitter, so a replay looks the same twice. */
  let spark = 0x9e3779b9;
  const rand = (): number => {
    spark = (Math.imul(spark, 1664525) + 1013904223) >>> 0;
    return spark / 4294967296;
  };

  const surfaceAt = (face: number, x: number, y: number): number => {
    const c = sim.idx(face, x, y);
    const h = sim.height[c] ?? 0;
    const w = sim.water[c] ?? 0;
    return BASE_RADIUS + (h + Math.max(w, 0)) * HEIGHT_TO_RADIUS;
  };

  /** An orthonormal tangent frame at `dir`, for sideways velocity. */
  const tangentFrame = (dir: THREE.Vector3): void => {
    // Cross with whichever axis is least aligned, so the frame never degenerates.
    scratch.set(Math.abs(dir.x) < 0.9 ? 1 : 0, Math.abs(dir.x) < 0.9 ? 0 : 1, 0);
    tangentA.crossVectors(dir, scratch).normalize();
    tangentB.crossVectors(dir, tangentA).normalize();
  };

  /**
   * @param area Radius over the surface the burst *starts* spread across.
   *   Without this every particle spawns on one point, and additive blending
   *   turns a few dozen coincident sprites into one saturated white blob — which
   *   is what an earthquake looked like. It is also more truthful: earthquake,
   *   flood and swamp act over a brush radius, so the effect should occupy it
   *   from the first frame rather than growing into it.
   * @param spread Tangential *velocity*, on top of the initial area.
   */
  const emit = (
    dir: THREE.Vector3,
    radius: number,
    count: number,
    speed: number,
    area: number,
    spread: number,
    size: number,
    life: number,
    colour: THREE.Color,
    fall: number,
  ): void => {
    tangentFrame(dir);
    for (let i = 0; i < count; i++) {
      const p: Particle =
        pool.length < MAX_PARTICLES
          ? {
              dir: new THREE.Vector3(),
              drift: new THREE.Vector3(),
              rise: 0,
              radius: 0,
              life: 0,
              maxLife: 1,
              size: 1,
              colour: new THREE.Color(),
              fall: 1,
            }
          : // Recycle the oldest rather than dropping the new one: a burst the
            // player just caused matters more than one that is already fading.
            pool.reduce((a, b) => (a.life / a.maxLife > b.life / b.maxLife ? a : b));
      if (pool.length < MAX_PARTICLES) pool.push(p);

      // Scattered over the brush before it starts moving. `sqrt` of the sample
      // so the disc fills evenly instead of clumping at the centre.
      const spot = rand() * Math.PI * 2;
      const reach = area * Math.sqrt(rand());
      p.dir
        .copy(dir)
        .addScaledVector(tangentA, Math.cos(spot) * reach)
        .addScaledVector(tangentB, Math.sin(spot) * reach)
        .normalize();
      p.radius = radius;
      p.rise = speed * (0.55 + rand() * 0.9);
      const a = rand() * Math.PI * 2;
      const m = spread * rand();
      p.drift
        .copy(tangentA)
        .multiplyScalar(Math.cos(a) * m)
        .addScaledVector(tangentB, Math.sin(a) * m);
      p.maxLife = life * (0.7 + rand() * 0.6);
      p.life = 0;
      p.size = size * (0.6 + rand() * 0.8);
      p.colour.copy(colour);
      p.fall = fall;
    }
  };

  // Palettes per verb. Kept as plain data so a new power is a row.
  //
  // These are *per particle* under additive blending, so the brightness a player
  // sees is roughly this times however many overlap. Written at display strength
  // they summed to flat white and every effect looked identical — a burst has to
  // be dim enough that forty of them make a colour rather than a hole.
  const EMBER = new THREE.Color(0.34, 0.12, 0.02);
  const SPRAY = new THREE.Color(0.1, 0.15, 0.2);
  const DUST = new THREE.Color(0.15, 0.12, 0.09);
  const BILE = new THREE.Color(0.06, 0.14, 0.05);
  const HOLY = new THREE.Color(0.3, 0.07, 0.05);

  /** Shake left to decay, in radii. */
  let shake = 0;

  const spawn = (ev: VerbEventView): void => {
    const cells = Math.max(1, ev.radius);
    cellDirectionInto(scratch, ev.face, ev.x + 0.5, ev.y + 0.5, sim.N);
    const dir = scratch.clone();
    const radius = surfaceAt(ev.face, ev.x, ev.y);
    const brush = cellScale * cells;

    switch (ev.verb) {
      case VERB.VOLCANO:
        // Narrow at the base, fast upward, slow to fall: a volcano has to read as
        // a column rather than a puff.
        emit(dir, radius, 54, 0.055, brush * 0.5, brush * 0.6, cellScale * 0.38, 2.6, EMBER, 0.55);
        shake = Math.max(shake, cellScale * 0.35);
        break;
      case VERB.FLOOD:
        // Wide, shallow and cold. Flood raises the global sea, so this marks
        // where the cast was aimed rather than pretending to be the wave.
        emit(dir, radius, 44, 0.018, brush * 2.4, brush * 1.6, cellScale * 0.3, 2.0, SPRAY, 1.2);
        break;
      case VERB.EARTHQUAKE:
        // Spread across the whole brush from the first frame — the ground it
        // shatters is an area, not a point.
        emit(dir, radius, 44, 0.024, brush * 2.0, brush * 1.2, cellScale * 0.34, 1.7, DUST, 1.4);
        shake = Math.max(shake, cellScale * 0.7);
        break;
      case VERB.SWAMP:
        // Slow, low bubbles that barely leave the ground.
        emit(dir, radius, 30, 0.01, brush * 1.6, brush * 0.5, cellScale * 0.28, 2.8, BILE, 0.3);
        break;
      case VERB.ARMAGEDDON:
        emit(dir, radius, 160, 0.075, brush * 3.0, 0.1, cellScale * 0.5, 3.4, HOLY, 0.4);
        shake = Math.max(shake, cellScale * 2.0);
        break;
      case VERB.CHAMPION:
        // A brief upward flare where the champion was blessed.
        emit(dir, radius, 22, 0.045, brush * 0.4, brush * 0.3, cellScale * 0.32, 1.2, HOLY, 0.5);
        break;
      default:
        // Raise, lower, magnet and set-hand are continuous or instantaneous verbs
        // whose feedback is the terrain itself and the hand. Sparks on every
        // terrace step would be constant noise — §8 spends the information budget
        // on the world.
        break;
    }
  };

  return {
    group,
    sync(_sim: Sim, events: readonly VerbEventView[], dtMs: number): number {
      for (const ev of events) spawn(ev);

      const dt = Math.min(dtMs, 100) / 1000;
      let live = 0;
      for (const p of pool) {
        if (p.life >= p.maxLife) continue;
        p.life += dt;
        if (p.life >= p.maxLife) continue;
        // Radial velocity decays under "gravity"; tangential drift just decays.
        p.rise -= p.fall * 0.045 * dt;
        p.radius += p.rise * dt;
        p.dir.addScaledVector(p.drift, dt).normalize();
        p.drift.multiplyScalar(1 - Math.min(1, 1.4 * dt));
        // Do not sink through the ground.
        const floor = BASE_RADIUS * 0.999;
        if (p.radius < floor) {
          p.radius = floor;
          p.rise = 0;
        }

        const t = p.life / p.maxLife;
        // Shrink and fade together: additive blending has no alpha to fade, so
        // scale carries most of the disappearance and colour carries the rest.
        const fade = 1 - t * t;
        dummy.position.copy(p.dir).multiplyScalar(p.radius);
        dummy.scale.setScalar(p.size * fade);
        dummy.quaternion.identity();
        dummy.updateMatrix();
        mesh.setMatrixAt(live, dummy.matrix);
        mesh.instanceColor?.setXYZ(live, p.colour.r * fade, p.colour.g * fade, p.colour.b * fade);
        live += 1;
      }
      mesh.count = live;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      // Shake decays exponentially, frame-rate independently.
      shake *= Math.exp(-3.4 * dt);
      if (shake < 1e-5) shake = 0;
      return shake;
    },
  };
}
