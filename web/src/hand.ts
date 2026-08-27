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
import { mergeGeometries, withTransform } from "./renderer/geometry";
import { BASE_RADIUS, HEIGHT_TO_RADIUS, cellDirection, pickCell } from "./renderer/planet";
import { MOD, POWER, VERB, readModifier } from "./verbs";

/** Screen pixels of vertical drag per terrace command. */
const DRAG_PIXELS_PER_STEP = 14;

/**
 * A press that moved less than this (squared pixels) and released within
 * `CLICK_MAX_MS` is a click. Distance from the *down point*, not a residue of
 * the step accumulator: the old test compared against what was left of
 * `dragOriginY` after steps were consumed, so nearly every sculpting drag
 * ended by accidentally teleporting the population.
 */
const CLICK_SLOP_SQ = 5 * 5;
const CLICK_MAX_MS = 400;

/** Cap on queued terrace steps: a wild flick drains for at most ~0.8 s. */
const MAX_PENDING_STEPS = 24;

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
  /** Briefly dim the palm to a dull red: the diegetic "no". */
  flash(): void;
  /**
   * Hide the hand outright, for as long as something else owns the screen.
   *
   * The radial menu opens *on* the ground the hand is working, and the palm and
   * footprint ring are the two brightest things the renderer draws — cream and
   * pale gold, scaled with the camera, so at close range they fill the middle of
   * the frame precisely where the labels go. Dimming them was not enough: the
   * menu has already snapshotted its target cell, so the hand has nothing left
   * to say until the menu closes.
   */
  setSuppressed(on: boolean): void;
}

export function createHand(
  sim: Sim,
  camera: OrbitCamera,
  canvas: HTMLCanvasElement,
  player: number,
  /** Called for casts that cost mana (the magnet), so the feedback tracker sees them. */
  onCast?: (verb: number) => void,
): Hand {
  const group = new THREE.Group();

  // The hand itself.
  //
  // It used to be a sphere, and a sphere is a perfectly good matter gauge and
  // not a hand: the game is called `dio` + `mano` and its whole interface is
  // supposed to be one. So: a palm with four fingers and a thumb, built out of
  // boxes and merged into **two** meshes rather than eleven, which is what lets
  // it grip for one extra draw call instead of ten.
  //
  // The split is the knuckle line. Everything proximal to it — palm, thumb
  // base, the first segment of each finger — never moves relative to the wrist,
  // so it is one static mesh. Everything distal is a second mesh whose origin
  // *is* the knuckle line, so rotating that one group about its local X closes
  // every fingertip at once. A hand curling is very nearly a single hinge.
  const HAND = {
    /** Palm: wider than it is long, and thin. Seen from above, that reads. */
    palm: [0.9, 0.22, 0.8] as const,
    /** Fingers, as [lateral offset, proximal length, distal length, splay]. */
    fingers: [
      [-0.33, 0.3, 0.26, -0.2],
      [-0.11, 0.34, 0.3, -0.06],
      [0.11, 0.33, 0.29, 0.06],
      [0.31, 0.28, 0.23, 0.2],
    ] as const,
    thickness: 0.15,
  };
  /** Where the knuckles are, in local units: the palm's leading edge. */
  const KNUCKLE_Z = -HAND.palm[2] / 2;

  const proximalParts: THREE.BufferGeometry[] = [];
  const distalParts: THREE.BufferGeometry[] = [];

  proximalParts.push(
    withTransform(new THREE.BoxGeometry(HAND.palm[0], HAND.palm[1], HAND.palm[2]), (g) => {
      // A cupped palm: the heel sits a little lower than the knuckles, which is
      // most of what stops a box reading as a box.
      g.rotateX(-0.12);
    }),
  );
  for (const [offset, proximal, distal, splay] of HAND.fingers) {
    // The proximal segment runs forward from the knuckle line, splayed.
    proximalParts.push(
      withTransform(new THREE.BoxGeometry(HAND.thickness, HAND.thickness * 0.85, proximal), (g) => {
        g.translate(0, 0, -proximal / 2);
        g.rotateY(splay);
        g.translate(offset, 0.01, KNUCKLE_Z);
      }),
    );
    // The distal segment is authored *relative to the knuckle line*, because
    // that is where its group's origin will be.
    distalParts.push(
      withTransform(
        new THREE.BoxGeometry(HAND.thickness * 0.86, HAND.thickness * 0.72, distal),
        (g) => {
          g.translate(0, 0, -distal / 2);
          g.rotateY(splay);
          g.translate(offset, 0.01, -proximal);
        },
      ),
    );
  }
  // The thumb, off the side and angled forward — the one part that makes a hand
  // read as a hand rather than as a mitten.
  proximalParts.push(
    withTransform(new THREE.BoxGeometry(HAND.thickness * 1.15, HAND.thickness, 0.34), (g) => {
      g.translate(0, 0, -0.17);
      g.rotateY(0.95);
      g.translate(-HAND.palm[0] / 2 + 0.04, 0.0, KNUCKLE_Z + 0.3);
    }),
  );
  distalParts.push(
    withTransform(new THREE.BoxGeometry(HAND.thickness, HAND.thickness * 0.8, 0.26), (g) => {
      g.translate(0, 0, -0.13);
      g.rotateY(0.95);
      g.translate(-HAND.palm[0] / 2 + 0.04, 0.0, KNUCKLE_Z + 0.3 - 0.34);
      // Back into knuckle-relative space, like the fingers.
      g.translate(0, 0, -KNUCKLE_Z);
    }),
  );

  // `depthWrite: false` is load-bearing, and was before the hand had fingers.
  // The hand is a translucent shell with the fill strictly inside it; three
  // sorts two transparent meshes at the same position by creation order, so the
  // shell drew first, wrote its front-face depth, and the fill failed the depth
  // test entirely. The one diegetic readout §4.2 asks for — how much matter am
  // I holding — was being z-rejected by its own container.
  // Lit, not flat.
  //
  // The sphere this replaced was a `MeshBasicMaterial`, and unlit was right for
  // a sphere: a sphere has one silhouette and no interior form to describe. A
  // hand is nothing *but* interior form, and five flat-shaded boxes at one
  // uniform colour composite into a single pale trapezoid — the first build of
  // this read as a plate, not as a hand, and no amount of resizing fixed it.
  //
  // Lambert against the scene's own sun carves the palm from the fingers.
  // `emissive` keeps the floor up so the hand never goes dark against dark
  // ground, which is what unlit was protecting; the mana glow rides on the
  // emissive rather than on the opacity now.
  const skin = new THREE.MeshLambertMaterial({
    color: 0xffe6c2,
    emissive: new THREE.Color(0xfff0d8),
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const palm = new THREE.Mesh(mergeGeometries(proximalParts), skin);
  const knuckles = new THREE.Group();
  const distal = new THREE.Mesh(mergeGeometries(distalParts), skin);
  knuckles.position.set(0, 0, KNUCKLE_Z);
  knuckles.add(distal);
  palm.add(knuckles);

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
  // Collected pickup charges, shown as gold motes orbiting the palm. Without
  // these the free-single-use mechanic (§5.3) is entirely invisible: the sim
  // grants the charge and nothing anywhere tells the player they hold one.
  const motes: THREE.Mesh[] = [];
  const moteMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd75e,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 3; i++) {
    const mote = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), moteMaterial);
    mote.visible = false;
    motes.push(mote);
    group.add(mote);
  }

  group.add(palm, fill, ring);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  let current: Target | null = null;

  // Mana at which the palm starts its "the big one is affordable" pulse: the
  // armageddon price from the live manifest, not a mirrored 2500.
  const pulseThreshold = Math.max(sim.e.dio_power_cost(POWER.ARMAGEDDON), 1);

  let dragging = false;
  let dragOriginY = 0;
  /** Accumulated steps not yet emitted. Positive raises, negative lowers. */
  let pendingSteps = 0;
  let modifier = 0;
  /** Where the press started and how far it ever strayed — the click test. */
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let movedSq = 0;
  /** Where queued steps keep landing after the button is released. */
  let drainTarget: Target | null = null;
  /** Modifier for the post-release drain (live `modifier` resets on release). */
  let drainModifier = 0;
  /** `performance.now()` until which the palm shows the refusal flash. */
  let flashUntil = 0;
  /** Set while the radial menu is open; see `setSuppressed`. */
  let suppressed = false;

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
      const dx = ev.clientX - downX;
      const dyTotal = ev.clientY - downY;
      movedSq = Math.max(movedSq, dx * dx + dyTotal * dyTotal);
      modifier = readModifier(ev);
      // Vertical drag distance decides how much and which way. Upward raises,
      // which is the only mapping anybody guesses correctly.
      const dy = dragOriginY - ev.clientY;
      const steps = Math.trunc(dy / DRAG_PIXELS_PER_STEP);
      if (steps !== 0) {
        pendingSteps = Math.max(
          -MAX_PENDING_STEPS,
          Math.min(MAX_PENDING_STEPS, pendingSteps + steps),
        );
        dragOriginY -= steps * DRAG_PIXELS_PER_STEP;
      }
    }
    updateTarget();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    dragOriginY = ev.clientY;
    downX = ev.clientX;
    downY = ev.clientY;
    downT = performance.now();
    movedSq = 0;
    // A fresh press abandons whatever a previous flick left queued: the player
    // has visibly moved on.
    pendingSteps = 0;
    drainTarget = null;
    // Thrown vs. poured, increased/extreme (§5.3) as drag modifiers, so the
    // constant verb stays a single uninterrupted motion.
    modifier = readModifier(ev);
    canvas.setPointerCapture(ev.pointerId);
  });

  const endDrag = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    // A click — a press that never strayed and released promptly — places the
    // papal magnet, the only command in the game (§5.1). Anything that moved
    // is a sculpt, however its pixel count divided into steps.
    const isClick = movedSq < CLICK_SLOP_SQ && performance.now() - downT < CLICK_MAX_MS;
    if (isClick && current) {
      sim.push(player, VERB.MAGNET, current.face, current.x, current.y, 0);
      onCast?.(VERB.MAGNET);
      pendingSteps = 0;
    } else if (pendingSteps !== 0 && current) {
      // A fast flick accumulates more steps than the drag had ticks; they
      // drain one per tick where the drag ended instead of being discarded.
      drainTarget = current;
      drainModifier = modifier;
    }
    modifier = 0;
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
  /** Scratch for the hand's basis, hoisted off the frame loop. */
  const reach = new THREE.Vector3();
  const handX = new THREE.Vector3();
  const handZ = new THREE.Vector3();
  const handBasis = new THREE.Matrix4();
  /** How closed the fingers are, 0 open to 1 fist. Eased in `sync`. */
  let grip = 0;
  /** `RingGeometry` lies in the XY plane, so its normal is +Z. Hoisted. */
  const ringNormal = new THREE.Vector3(0, 0, 1);
  /** Scratch for the mote orbit, hoisted off the frame loop. */
  const moteOffset = new THREE.Vector3();

  return {
    group,
    target: () => current,

    beforeTick(): void {
      if (pendingSteps === 0) return;
      // While dragging the steps land under the live pointer; after release
      // they keep draining where the drag ended.
      const at = dragging ? current : drainTarget;
      if (!at) return;
      // One terrace step per tick at most: the simulation applies exactly one
      // command per verb per tick, and queueing twenty at once would make a
      // fast flick dig a canyon in a single tick.
      const step = pendingSteps > 0 ? 1 : -1;
      pendingSteps -= step;
      if (pendingSteps === 0 && !dragging) drainTarget = null;
      sim.push(
        player,
        step > 0 ? VERB.RAISE : VERB.LOWER,
        at.face,
        at.x,
        at.y,
        dragging ? modifier : drainModifier,
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
      // the screen with no pointer of any kind. The radial menu is the one
      // exception, and it restores the system cursor while it is open.
      group.visible = current !== null && !suppressed;
      if (!current || suppressed) return;

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

      const cellScale = (Math.PI * 0.5 * BASE_RADIUS) / sim.N;
      // Wider than the sphere it replaced. A sphere of radius 1.5 cells reads
      // at that size; a palm 0.9 units across at the same scale is barely a
      // cell wide, and a hand you cannot see is not an interface.
      palm.scale.setScalar(cellScale * 2.2);

      // Which way the hand points.
      //
      // A sphere needed no answer to this; a hand does, and "along the surface
      // normal" is only two thirds of one. The fingers reach *away from the
      // viewer*, so the hand is always seen from the back and never from the
      // fingertips — which is the one angle at which a hand reads as a hand
      // rather than as a cluster of boxes.
      //
      // Built as an explicit basis rather than a `setFromUnitVectors` plus a
      // corrective spin: local +Y is the surface normal, local -Z is the view
      // direction flattened into the tangent plane, and local X completes a
      // right-handed set. Degenerate only where the view ray is exactly the
      // normal — looking straight down the hand's own axis — and there the
      // fallback keeps the previous heading rather than snapping.
      reach.copy(position).sub(camera.camera.position);
      reach.addScaledVector(dir, -reach.dot(dir)).normalize();
      if (reach.lengthSq() > 0.25) {
        handZ.copy(reach).negate();
        handX.crossVectors(dir, handZ).normalize();
        handBasis.makeBasis(handX, dir, handZ);
        palm.quaternion.setFromRotationMatrix(handBasis);
      }

      // How full the hand is, straight from the simulation. This is the matter
      // budget of pillar 4, shown as a volume rather than as a number — and now
      // it is held *in the palm*, which is where a hand holds things.
      const carried = sim.e.dio_hand_amount(player) / sim.e.dio_hand_capacity();
      const held = Math.cbrt(Math.max(carried, 0.001));
      fill.position.copy(position).addScaledVector(dir, cellScale * 0.1);
      fill.scale.setScalar(cellScale * 0.62 * held);

      // The grip. Closed while the hand is working and in proportion to what it
      // holds, open when it is not — the same information the fill already
      // carries, in the shape of the thing carrying it, which is what §4.2 means
      // by diegetic. Eased rather than set, so a drag does not snap the fingers.
      // Never quite flat, even at rest: a hand with straight fingers is a
      // paddle, and the resting curl is what gives the fingertips a silhouette
      // of their own from directly above.
      const wanted = dragging ? 1.0 : 0.16 + carried * 0.6;
      grip += (wanted - grip) * (0.18 + alpha * 0.12);
      knuckles.rotation.x = -grip * 1.15;
      const material = sim.e.dio_hand_material(player);
      const mat = fill.material as THREE.MeshBasicMaterial;
      mat.color.setHex(material === 1 ? 0x4fa8d8 : material === 2 ? 0xff6a2a : 0xc9a06a);

      // Mana as a glow on the palm: more mana, brighter hand. Diegetic, and it
      // reads peripherally without ever being a number (§8). The sqrt curve is
      // anchored to the cost tiers — the old linear /800 saturated at 8% of
      // the mana range, so "can afford an earthquake" and "can afford
      // armageddon" looked identical. Above the armageddon price the palm
      // pulses gently: the big one is affordable, still without a number.
      const now = performance.now();
      const mana = sim.e.dio_mana(player);
      const glow = Math.min(Math.sqrt(mana / pulseThreshold), 1);
      const pulse = mana >= pulseThreshold ? Math.sin(now / 240) * 0.06 : 0;
      const palmMat = palm.material as THREE.MeshLambertMaterial;
      if (now < flashUntil) {
        // The refusal: a dull red dip, unmistakably "no" without a toast.
        palmMat.color.setHex(0x8f2c1e);
        palmMat.emissive.setHex(0xb03a2a);
        palmMat.opacity = 0.72;
      } else {
        palmMat.color.setHex(0xffe6c2);
        // The mana glow rides the emissive floor rather than the opacity: a
        // hand made of thin boxes needs its *shape* at every mana level, and
        // fading the shape out to show a low balance costs more than it says.
        palmMat.emissive.setRGB(
          0.3 + glow * 0.55 + pulse,
          0.28 + glow * 0.5 + pulse,
          0.24 + glow * 0.42 + pulse,
        );
        palmMat.opacity = 0.62 + glow * 0.2;
      }

      // Collected pickup charges orbit the palm.
      let charges = 0;
      for (let p = 0; p < 8; p++) charges += sim.e.dio_free_uses(player, p);
      for (let i = 0; i < motes.length; i++) {
        const mote = motes[i];
        if (!mote) continue;
        mote.visible = i < charges;
        if (!mote.visible) continue;
        const phase = now / 800 + (i * Math.PI * 2) / 3;
        mote.scale.setScalar(cellScale * 0.25);
        moteOffset
          .set(Math.cos(phase), Math.sin(phase * 0.7), Math.sin(phase))
          .normalize()
          .multiplyScalar(cellScale * 2.2);
        mote.position
          .copy(position)
          .addScaledVector(dir, Math.sin(phase * 2.7) * cellScale * 0.4)
          .add(moteOffset);
      }

      // Footprint ring, lying flat on the surface. The radius mirrors
      // `brush_radius` in world.rs exactly: thrown widens the base to 2, and
      // extreme (+3) wins over increased (+1) rather than stacking.
      ring.position.copy(dir).multiplyScalar(surface + 0.002);
      ring.quaternion.setFromUnitVectors(ringNormal, dir);
      const radius =
        (modifier & MOD.THROWN ? 2 : 1) +
        (modifier & MOD.EXTREME ? 3 : modifier & MOD.INCREASED ? 1 : 0);
      ring.scale.setScalar(cellScale * (radius + 0.5) * 2);
    },

    flash(): void {
      flashUntil = performance.now() + 180;
    },

    setSuppressed(on: boolean): void {
      suppressed = on;
      if (on) group.visible = false;
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
