/**
 * Orbit camera on a spherical shell. HANDOFF §7.2.
 *
 * Panning rotates the planet. There are no map edges and no camera constraints
 * to fight — the only limits are how close you may get and how far you may
 * pull back, and the far limit exists for a specific reason:
 *
 * > Keep the planet small enough that the horizon against space is always
 * > visible. The curvature is the visual identity.
 *
 * So the camera is never allowed far enough out for the planet to shrink to a
 * dot, nor close enough for the limb to leave the frame. A planet large enough
 * to look flat wastes the entire architecture.
 */

import * as THREE from "three";
import { BASE_RADIUS } from "./renderer/planet";

/** Closest approach, as a multiple of the planet radius. */
const MIN_DISTANCE = BASE_RADIUS * 1.35;
/** Furthest retreat. Beyond this the horizon stops reading as curvature. */
const MAX_DISTANCE = BASE_RADIUS * 4.2;
const DEFAULT_DISTANCE = BASE_RADIUS * 2.3;

/** Radians of orbit per pixel dragged. */
const DRAG_SENSITIVITY = 0.005;
/** Exponential smoothing per millisecond; higher is snappier. */
const SMOOTHING = 0.014;

export interface OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Current orientation, for the hand's ray. */
  readonly quaternion: THREE.Quaternion;
  resize(aspect: number): void;
  update(dtMs: number): void;
  /** True while the pointer is dragging the planet rather than the terrain. */
  readonly panning: boolean;
}

export function createCamera(canvas: HTMLCanvasElement): OrbitCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);

  // Spherical coordinates: yaw around the world Y axis, pitch from the equator.
  let yaw = 0.6;
  let pitch = 0.35;
  let distance = DEFAULT_DISTANCE;

  // Targets, smoothed towards. Direct assignment would make a fast drag feel
  // like a jump cut on a curved surface.
  let targetYaw = yaw;
  let targetPitch = pitch;
  let targetDistance = distance;

  let panning = false;
  let lastX = 0;
  let lastY = 0;

  const PITCH_LIMIT = Math.PI * 0.49;

  const onPointerDown = (ev: PointerEvent): void => {
    // Right button or middle button pans; left is the hand (§8: direct drag is
    // raise/lower, and it must stay frictionless).
    if (ev.button !== 2 && ev.button !== 1) return;
    panning = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: PointerEvent): void => {
    if (!panning) return;
    targetYaw -= (ev.clientX - lastX) * DRAG_SENSITIVITY;
    targetPitch = clamp(
      targetPitch + (ev.clientY - lastY) * DRAG_SENSITIVITY,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    lastX = ev.clientX;
    lastY = ev.clientY;
  };

  const onPointerUp = (ev: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };

  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    targetDistance = clamp(
      targetDistance * Math.exp(ev.deltaY * 0.0012),
      MIN_DISTANCE,
      MAX_DISTANCE,
    );
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  // Right-drag is a camera control, so the browser menu is in the way.
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  const quaternion = new THREE.Quaternion();

  return {
    camera,
    quaternion,
    resize(aspect: number): void {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    update(dtMs: number): void {
      const k = 1 - Math.exp(-SMOOTHING * dtMs);
      yaw += (targetYaw - yaw) * k;
      pitch += (targetPitch - pitch) * k;
      distance += (targetDistance - distance) * k;

      const cp = Math.cos(pitch);
      camera.position.set(
        Math.sin(yaw) * cp * distance,
        Math.sin(pitch) * distance,
        Math.cos(yaw) * cp * distance,
      );
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      quaternion.copy(camera.quaternion);
    },
    get panning(): boolean {
      return panning;
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
