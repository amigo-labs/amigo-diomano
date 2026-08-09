/**
 * The hand — the entire interface. HANDOFF §8, §4.2.
 *
 * > No HUD. The god has no body, only a hand — cursor, matter carrier and
 * > influence indicator in one.
 *
 * So there is no bar for held matter and no number for mana. The hand *visibly
 * fills and empties* as matter moves, which is the diegetic budget display §4.2
 * asks for, and it glows brighter with mana.
 *
 * Raise/lower deliberately has no gesture (§8): it is the constant verb, where
 * roughly 90% of playtime goes, and it must stay frictionless. Left-drag up
 * raises, left-drag down lowers, and the command is emitted every tick the
 * button is held — so the response is continuous rather than per-click.
 */

import * as THREE from "three";
import type { OrbitCamera } from "./camera";
import type { Sim } from "./main";
import { MOD, VERB } from "./main";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirection, pickCell } from "./renderer/planet";

/** Screen pixels of vertical drag per terrace command. */
const DRAG_PIXELS_PER_STEP = 14;

export interface Target {
  face: number;
  x: number;
  y: number;
}

export interface Hand {
  readonly group: THREE.Group;
  /** The cell currently under the hand, or `null` if it is off the planet. */
  target(): Target | null;
  /** Emit this tick's held-drag command, if any. Called before `sim.tick()`. */
  beforeTick(): void;
  /** Update the visual. `alpha` is the sub-tick interpolation factor. */
  sync(alpha: number): void;
}

export function createHand(
  sim: Sim,
  camera: OrbitCamera,
  canvas: HTMLCanvasElement,
  player: number,
): Hand {
  const group = new THREE.Group();

  // The hand itself: a soft sphere that fills with what it carries. Not a
  // pointer icon — the player's whole read of "how much am I holding" is this.
  const palm = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    // `depthWrite: false` is load-bearing. The palm is a transparent shell with
    // the fill sphere strictly inside it; three sorts two transparent meshes at
    // the same position by creation order, so the palm drew first, wrote its
    // front-face depth, and the fill failed the depth test entirely. The one
    // diegetic readout §4.2 asks for — how much matter am I holding — was being
    // z-rejected by its own container.
    new THREE.MeshBasicMaterial({
      color: 0xfff0d8,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
  );
  const fill = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xc9a06a, transparent: true, opacity: 0.85 }),
  );
  // A ring on the ground showing the brush footprint, so the player knows what
  // a drag will touch before it touches it.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.0, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffe9c0,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(palm, fill, ring);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  let current: Target | null = null;

  let dragging = false;
  let dragOriginY = 0;
  /** Accumulated steps not yet emitted. Positive raises, negative lowers. */
  let pendingSteps = 0;
  let modifier = 0;

  /**
   * Which cell the pointer is over.
   *
   * The ray is intersected with the mean sphere first and then re-intersected
   * against the surface radius at whatever cell that found, twice. One
   * intersection against the mean sphere is only correct where the ground is at
   * sea level: relief reaches ~6% of the radius, and the error is
   * `height * tan(incidence)`, so on a mountain seen at a glancing angle the
   * mean-sphere pick lands several cells away from the ground the player is
   * looking at. Two refinement steps put it on the visible surface.
   *
   * The original reason for using the mean radius — that raising ground would
   * otherwise drag the cursor with it — survives the change: one terrace is
   * 16 height units, which is 0.05 of a cell, so the per-step feedback is far
   * below a cell. Where the pick does move over a long dig, it moves because the
   * surface really did.
   */
  const updateTarget = (): void => {
    raycaster.setFromCamera(pointer, camera.camera);
    let hit = intersectSphere(raycaster.ray, BASE_RADIUS);
    if (!hit) {
      current = null;
      return;
    }
    let cell = pickCell(hit, sim.N);
    for (let step = 0; step < 2; step++) {
      const c = sim.idx(cell.face, cell.x, cell.y);
      const height = sim.height[c] ?? 0;
      const water = sim.water[c] ?? 0;
      const surface = BASE_RADIUS + (height + Math.max(water, 0)) * HEIGHT_TO_RADIUS;
      const refined = intersectSphere(raycaster.ray, surface);
      // A ray that misses the raised surface still hit the mean sphere; keep
      // the coarser answer rather than dropping the target entirely.
      if (!refined) break;
      hit = refined;
      cell = pickCell(hit, sim.N);
    }
    current = cell;
  };

  canvas.addEventListener("pointermove", (ev) => {
    pointer.x = (ev.clientX / innerWidth) * 2 - 1;
    pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
    if (dragging) {
      // Vertical drag distance decides how much and which way. Upward raises,
      // which is the only mapping anybody guesses correctly.
      const dy = dragOriginY - ev.clientY;
      const steps = Math.trunc(dy / DRAG_PIXELS_PER_STEP);
      if (steps !== 0) {
        pendingSteps += steps;
        dragOriginY -= steps * DRAG_PIXELS_PER_STEP;
      }
    }
    updateTarget();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    dragOriginY = ev.clientY;
    pendingSteps = 0;
    // Thrown vs. poured, increased/extreme (§5.3) as drag modifiers, so the
    // constant verb stays a single uninterrupted motion.
    modifier =
      (ev.shiftKey ? MOD.THROWN : 0) |
      (ev.altKey ? MOD.INCREASED : 0) |
      (ev.ctrlKey ? MOD.EXTREME : 0);
    canvas.setPointerCapture(ev.pointerId);
  });

  const endDrag = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    // A click with no drag places the papal magnet — the only command in the
    // game (§5.1).
    if (Math.abs(dragOriginY - ev.clientY) < DRAG_PIXELS_PER_STEP && current) {
      sim.push(player, VERB.MAGNET, current.face, current.x, current.y, 0);
    }
    pendingSteps = 0;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Switching what the hand carries. Mixing is impossible (§4.2), and the sim
  // refuses the switch while the hand is full — nothing here needs to know that.
  addEventListener("keydown", (ev) => {
    const material = ev.key === "1" ? 0 : ev.key === "2" ? 1 : ev.key === "3" ? 2 : -1;
    if (material < 0) return;
    sim.push(player, VERB.SET_HAND, 0, material, 0, 0);
  });

  const position = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  /** `RingGeometry` lies in the XY plane, so its normal is +Z. Hoisted. */
  const ringNormal = new THREE.Vector3(0, 0, 1);

  return {
    group,
    target: () => current,

    beforeTick(): void {
      if (!current || pendingSteps === 0) return;
      // One terrace step per tick at most: the simulation applies exactly one
      // command per verb per tick, and queueing twenty would make a fast flick
      // dig a canyon.
      const step = pendingSteps > 0 ? 1 : -1;
      pendingSteps -= step;
      sim.push(
        player,
        step > 0 ? VERB.RAISE : VERB.LOWER,
        current.face,
        current.x,
        current.y,
        modifier,
      );
    },

    sync(alpha: number): void {
      // Re-pick every frame, not only on `pointermove`. Orbiting or zooming with
      // the pointer held still used to leave the target on the cell it had been
      // over before the planet turned, and a click then acted on that stale
      // cell. This is two sphere intersections and a projection inverse.
      updateTarget();
      // Visible whenever it is over the planet, including while orbiting. The
      // page sets `cursor: none`, so hiding the hand during a camera drag left
      // the screen with no pointer of any kind.
      group.visible = current !== null;
      if (!current) return;

      const dir = cellDirection(current.face, current.x, current.y, sim.N);
      const c = sim.idx(current.face, current.x, current.y);
      const height = sim.height[c] ?? 0;
      const water = sim.water[c] ?? 0;
      const surface = BASE_RADIUS + (height + Math.max(water, 0)) * HEIGHT_TO_RADIUS;

      // The hand hovers a little above the ground it is working.
      targetPosition.copy(dir).multiplyScalar(surface + 0.035);
      // Interpolated towards, so the hand glides rather than snapping between
      // cell centres — the only place `alpha` is used, and purely cosmetic.
      position.lerp(targetPosition, 0.25 + alpha * 0.25);
      palm.position.copy(position);
      fill.position.copy(position);

      const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;
      palm.scale.setScalar(cellScale * 1.5);

      // How full the hand is, straight from the simulation. This is the matter
      // budget of pillar 4, shown as a volume rather than as a number.
      const carried = sim.e.dio_hand_amount(player) / sim.e.dio_hand_capacity();
      fill.scale.setScalar(cellScale * 1.5 * Math.cbrt(Math.max(carried, 0.001)));
      const material = sim.e.dio_hand_material(player);
      const mat = fill.material as THREE.MeshBasicMaterial;
      mat.color.setHex(material === 1 ? 0x4fa8d8 : material === 2 ? 0xff6a2a : 0xc9a06a);

      // Mana as a glow on the palm: more mana, brighter hand. Diegetic, and it
      // reads peripherally without ever being a number (§8).
      const mana = Math.min(sim.e.dio_mana(player) / 800, 1);
      (palm.material as THREE.MeshBasicMaterial).opacity = 0.2 + mana * 0.45;

      // Footprint ring, lying flat on the surface.
      ring.position.copy(dir).multiplyScalar(surface + 0.002);
      ring.quaternion.setFromUnitVectors(ringNormal, dir);
      const radius = 1 + (modifier & MOD.THROWN ? 1 : 0) + (modifier & MOD.EXTREME ? 3 : 0);
      ring.scale.setScalar(cellScale * (radius + 0.5) * 2);
    },
  };
}

/**
 * Nearest intersection of a ray with a sphere centred on the origin.
 *
 * `THREE.Raycaster` against the terrain meshes would work and would cost a
 * traversal of 96 chunks with constantly-changing vertex data every pointer
 * move. The planet is a sphere to within a few percent, and picking wants
 * stability more than it wants millimetres.
 */
function intersectSphere(ray: THREE.Ray, radius: number): THREE.Vector3 | null {
  const o = ray.origin;
  const d = ray.direction;
  const b = 2 * o.dot(d);
  const c = o.dot(o) - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  if (t < 0) return null;
  return o.clone().addScaledVector(d, t);
}
