/**
 * Off-screen pips: something happened over there. HANDOFF §8.
 *
 * # The question this answers
 *
 * `effects.ts` draws what happened where it happened, which is no help when
 * "where" is the far side of the planet or past the edge of the frame. The
 * opponent's earthquake, a settlement of yours drowning, a fight on the
 * border — all of it used to be audible at best. A pip is a short-lived glow
 * at the planet's limb, or at the edge of the view, on the line toward the
 * event, in the colour of the side it concerns. It fades in about two and a
 * half seconds and says nothing else: a direction to look, not a readout.
 *
 * # Drawn in the scene, not in the DOM
 *
 * The first attempt was a DOM layer over the canvas, and it was withdrawn
 * because it could not be shown to paint reliably (the header of `hud.ts` has
 * the history). These are instances in the same WebGL scene as everything
 * else: each frame a pip's screen position is worked out from the camera's
 * projection, and the quad is placed a short way in front of the camera at
 * exactly the point that projects there, sized so it covers a constant number
 * of pixels. No depth test, drawn last — it is an overlay that happens to live
 * in the scene graph, so it goes through the same bloom and output passes as
 * the world and cannot be lost between two compositors.
 *
 * # Cheap
 *
 * One instanced quad, sixteen slots, a few dozen flops per live pip per frame.
 * A new event near a live pip of the same colour refreshes it rather than
 * adding another, so a battle is one pulsing pip and not a spray of them.
 */

import * as THREE from "three";
import type { Sim, VerbEventView } from "../main";
import { VERB } from "../verbs";
import type { WorldEvent } from "../worldEvents";
import { type Rgb, SETTLEMENT_TEAM, teamColour } from "./palette";
import { cellDirectionInto } from "./planet";
import { BASE_RADIUS, HEIGHT_TO_RADIUS } from "./scale";

/** Simultaneous pips. Beyond this the oldest is replaced. */
const MAX_PIPS = 16;
/** Seconds a pip lives. */
const LIFE = 2.5;
/** Diameter on screen, in CSS pixels, once the opening pulse has settled. */
const SIZE_PX = 36;
/**
 * Camera-space depth the quads are placed at, as a multiple of the near plane.
 * Any depth past the near plane draws the same picture, since the depth test is
 * off — but the near plane is not fixed: `camera.ts` pushes it out as the camera
 * pulls back, up to 1.5 at the far end, and a quad at a fixed 0.05 was clipped
 * away at every distance but the closest.
 */
const DEPTH_OF_NEAR = 1.5;
/** How far in from the frame's edge a clamped pip sits, in CSS pixels. */
const MARGIN_PX = 26;
/** Two events closer than this (cosine of the angle between them) share a pip. */
const MERGE_COS = Math.cos(0.12);

/** A fight on unclaimed ground: neither side's colour, a hot white. */
const NEUTRAL: Rgb = [1.0, 0.82, 0.62];

interface Pip {
  dir: THREE.Vector3;
  radius: number;
  /** The palette entry it was drawn from, compared by identity to merge. */
  key: Rgb;
  age: number;
  /** False once it has aged out; the slot is free. */
  live: boolean;
}

export interface Indicators {
  readonly group: THREE.Group;
  /**
   * Note this frame's events and place every live pip for `camera`.
   *
   * @param verbs Applied verbs — only the opponent's powers make a pip.
   * @param world Population events — falls and fights make one.
   */
  sync(
    camera: THREE.PerspectiveCamera,
    verbs: readonly VerbEventView[],
    world: readonly WorldEvent[],
    dtMs: number,
  ): void;
  /** How many pips are drawn this frame, for the tools. */
  readonly drawn: number;
  /** Raise a pip for `owner`'s side at a cell, as an event there would. For the tools. */
  ping(face: number, x: number, y: number, owner: number): void;
  /** Drop every pip. A restart calls this. */
  reset(): void;
}

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

// A bright core, a soft halo, a thin ring, and a small chevron on +x — the
// instance is rotated so +x points away from the middle of the screen, toward
// the event. Additive: `vColor` already carries the fade.
const FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float core = smoothstep(0.34, 0.12, r);
    float halo = exp(-r * r * 6.0) * 0.55;
    float ring = smoothstep(0.07, 0.0, abs(r - 0.58)) * 0.6;
    float tip = smoothstep(0.0, 0.05, (0.98 - p.x) * 1.15 - abs(p.y)) * smoothstep(0.64, 0.7, p.x);
    float k = core * 2.0 + halo + ring + tip * 1.1;
    gl_FragColor = vec4(vColor * k, 1.0);
  }
`;

export function createIndicators(sim: Sim, localPlayer: number): Indicators {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, MAX_PIPS);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIPS * 3), 3);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  // After the particles (2) and everything else that blends: an overlay.
  mesh.renderOrder = 20;
  group.add(mesh);

  const pips: Pip[] = [];
  for (let i = 0; i < MAX_PIPS; i++) {
    pips.push({
      dir: new THREE.Vector3(),
      radius: BASE_RADIUS,
      key: NEUTRAL,
      age: 0,
      live: false,
    });
  }
  let drawn = 0;

  const scratch = new THREE.Vector3();
  const point = new THREE.Vector3();
  const local = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const spin = new THREE.Quaternion();
  const facingCamera = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);

  const surfaceAt = (face: number, x: number, y: number): number => {
    const c = sim.idx(face, x, y);
    return BASE_RADIUS + ((sim.height[c] ?? 0) + Math.max(sim.water[c] ?? 0, 0)) * HEIGHT_TO_RADIUS;
  };

  const note = (face: number, x: number, y: number, rgb: Rgb): void => {
    cellDirectionInto(scratch, face, x + 0.5, y + 0.5, sim.N);
    // Same place, same colour: the pip already there pulses again instead.
    let slot: Pip | undefined;
    for (const p of pips) {
      if (p.live && p.key === rgb && p.dir.dot(scratch) > MERGE_COS) {
        slot = p;
        break;
      }
    }
    if (!slot) {
      // A free slot, or else the oldest.
      for (const p of pips) {
        if (!p.live) {
          slot = p;
          break;
        }
        if (!slot || p.age > slot.age) slot = p;
      }
    }
    if (!slot) return;
    slot.dir.copy(scratch);
    slot.radius = surfaceAt(face, x, y);
    slot.key = rgb;
    slot.age = 0;
    slot.live = true;
  };

  return {
    group,
    get drawn() {
      return drawn;
    },

    ping(face, x, y, owner): void {
      note(face, x, y, teamColour(SETTLEMENT_TEAM, owner));
    },

    sync(camera, verbs, world, dtMs): void {
      for (const ev of verbs) {
        // The other god's powers only. Your own you just cast; sculpting and
        // the magnet are constant and would make the pips wallpaper.
        if (ev.player === localPlayer) continue;
        if (
          ev.verb === VERB.NOP ||
          ev.verb === VERB.RAISE ||
          ev.verb === VERB.LOWER ||
          ev.verb === VERB.MAGNET ||
          ev.verb === VERB.SET_HAND
        ) {
          continue;
        }
        note(ev.face, ev.x, ev.y, teamColour(SETTLEMENT_TEAM, ev.player));
      }
      for (const ev of world) {
        if (ev.kind === "fell") {
          note(ev.face, ev.x, ev.y, teamColour(SETTLEMENT_TEAM, ev.owner));
        } else if (ev.kind === "clash" && ev.located) {
          // Coloured by whose ground the fight is on: amber means someone is
          // at the amber god's door.
          const held = sim.influence[sim.idx(ev.face, ev.x, ev.y)] ?? 0;
          note(
            ev.face,
            ev.x,
            ev.y,
            held > 0
              ? teamColour(SETTLEMENT_TEAM, 0)
              : held < 0
                ? teamColour(SETTLEMENT_TEAM, 1)
                : NEUTRAL,
          );
        }
      }

      const dt = Math.min(dtMs, 100) / 1000;
      camera.updateMatrixWorld();
      camera.getWorldQuaternion(facingCamera);
      const aspect = camera.aspect;
      const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
      const depth = camera.near * DEPTH_OF_NEAR;
      const heightPx = Math.max(1, innerHeight);
      const widthPx = Math.max(1, innerWidth);
      const edgeX = 1 - (2 * MARGIN_PX) / widthPx;
      const edgeY = 1 - (2 * MARGIN_PX) / heightPx;
      const eye = camera.position;
      const eyeDistance = eye.length();
      // The planet's centre on screen and its apparent radius, in NDC y units.
      // The camera tilts toward the horizon as it comes in, so the centre is not
      // the middle of the frame.
      point.set(0, 0, 0).project(camera);
      const centreX = point.x;
      const centreY = point.y;
      const limb =
        (Math.tan(Math.asin(Math.min(0.999, BASE_RADIUS / Math.max(eyeDistance, 1e-6)))) /
          tanHalf) *
        1.03;

      drawn = 0;
      for (const p of pips) {
        if (!p.live) continue;
        p.age += dt;
        if (p.age >= LIFE) {
          p.live = false;
          continue;
        }

        // Where on screen, if anywhere, the event itself is.
        point.copy(p.dir).multiplyScalar(p.radius);
        // Horizon: a point on a sphere is in sight of `eye` while it is on the
        // eye's side of the tangent plane through it.
        const facing = p.dir.dot(eye) > p.radius;
        local.copy(point).applyMatrix4(camera.matrixWorldInverse);
        let x: number;
        let y: number;
        /** Whether the pip goes all the way out to the frame's edge. */
        let toEdge = false;
        if (facing && local.z < 0) {
          point.project(camera);
          // In sight and inside the frame: the effect itself is the indicator.
          if (Math.abs(point.x) < 1 && Math.abs(point.y) < 1) continue;
          x = point.x;
          y = point.y;
        } else if (facing) {
          // In sight of the eye but behind it — close in, looking away. To the
          // frame's edge on the side it lies.
          x = local.x / aspect;
          y = local.y;
          if (Math.abs(x) + Math.abs(y) < 1e-6) y = -1;
          toEdge = true;
        } else {
          // Behind the planet: on the limb, on the side the event lies, which is
          // the event's direction seen in the screen plane.
          local.copy(p.dir).transformDirection(camera.matrixWorldInverse);
          const len = Math.hypot(local.x, local.y);
          const ux = len > 1e-6 ? local.x / len : 0;
          const uy = len > 1e-6 ? local.y / len : 1;
          x = centreX + (ux * limb) / aspect;
          y = centreY + uy * limb;
        }
        // Into the frame, along the line from its middle, so the pip still
        // points the right way when the limb itself is off screen.
        const reach = Math.max(Math.abs(x) / edgeX, Math.abs(y) / edgeY);
        const over = toEdge ? reach : Math.max(reach, 1);
        x /= over;
        y /= over;

        // Opening pulse, then a fade over the last second.
        const t = p.age / LIFE;
        const pulse = 1 + 0.6 * Math.max(0, 1 - p.age / 0.35);
        const fade =
          Math.min(1, (LIFE - p.age) / 1.0) * (0.75 + 0.25 * Math.cos(p.age * 9) * (1 - t));
        const gain = fade * pulse;

        // The camera-space point at `depth` that projects to (x, y), and the
        // world size of one pixel there.
        local.set(x * depth * tanHalf * aspect, y * depth * tanHalf, -depth);
        dummy.position.copy(local).applyMatrix4(camera.matrixWorld);
        spin.setFromAxisAngle(zAxis, Math.atan2(y, x * aspect));
        dummy.quaternion.copy(facingCamera).multiply(spin);
        dummy.scale.setScalar(((2 * depth * tanHalf) / heightPx) * SIZE_PX * pulse);
        dummy.updateMatrix();
        mesh.setMatrixAt(drawn, dummy.matrix);
        mesh.instanceColor?.setXYZ(drawn, p.key[0] * gain, p.key[1] * gain, p.key[2] * gain);
        drawn += 1;
      }
      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },

    reset(): void {
      for (const p of pips) p.live = false;
      drawn = 0;
      mesh.count = 0;
    },
  };
}
