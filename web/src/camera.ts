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
 * # The horizon rule cannot be met by a nadir-locked camera
 *
 * That instruction and `MIN_DISTANCE` are in direct conflict as long as the
 * camera looks at the planet's centre. The planet's angular radius from
 * distance `d` is `asin(R / d)`, and the limb is inside a 45° frame only while
 * that is under the 22.5° half-angle — i.e. from `d >= 2.61 R`. At the 1.35 R
 * floor the angular radius is 47.8°: the planet covers the entire frame and
 * there is no horizon anywhere in it. Even at the 2.3 R default the globe is
 * cut off top and bottom. Raising the floor to 2.6 R would satisfy the letter of
 * the rule and destroy close work, and widening the FOV enough to see the limb
 * from 1.35 R needs about 96°, which is a fisheye.
 *
 * So the camera tilts instead. It looks at the planet's centre when pulled back
 * and swings progressively toward the horizon as it comes in, which is what a
 * low orbit actually looks like: the curved edge sits in the upper part of the
 * frame while the ground under the cursor stays in the lower part. The curvature
 * is on screen at every distance — the thing §7.2 is protecting — without giving
 * up the close distance the sculpting verb needs.
 */

import * as THREE from "three";
import { BASE_RADIUS } from "./renderer/planet";

/** Closest approach, as a multiple of the planet radius. */
const MIN_DISTANCE = BASE_RADIUS * 1.35;
/** Furthest retreat. Beyond this the horizon stops reading as curvature. */
const MAX_DISTANCE = BASE_RADIUS * 4.2;
const DEFAULT_DISTANCE = BASE_RADIUS * 2.3;

/**
 * Radians of orbit per pixel dragged, at `DEFAULT_DISTANCE`.
 *
 * Scaled by distance in `onPointerMove`: a fixed radians-per-pixel rate moves
 * far more surface per pixel up close, because the same angle covers more of the
 * screen the nearer you are. Constant rate meant the planet tore past at the
 * close end and crawled at the far end.
 */
const DRAG_SENSITIVITY = 0.005;
/** Exponential smoothing per millisecond; higher is snappier. */
const SMOOTHING = 0.014;
/** Zoom smoothing. Slower than rotation: a snapped zoom reads as a cut. */
const ZOOM_SMOOTHING = 0.009;
/**
 * How far off nadir the camera looks, in radians, at `MIN_DISTANCE`.
 *
 * The limb sits `asin(R / d)` from the nadir direction — 47.8° at 1.35 R — so
 * tilting ~32° puts it just inside the top of a 45° frame with the working area
 * still below the centre line. 0.5585 rad *is* those 32 degrees: it used to be
 * 0.42 (24°), which left the horizon lower in frame than this comment — and the
 * `DIO_GRAZE` tuning in atmosphere.ts, which assumes the same 32° — claimed.
 */
const MAX_TILT = 0.5585;

export interface OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  resize(aspect: number): void;
  update(dtMs: number): void;
  /**
   * Displace the eye by a small random offset, for earthquake and armageddon.
   *
   * Applied to the eye and not to the target, so the horizon stays level and the
   * planet does not appear to swing: a rolling camera reads as a broken control,
   * a jittering one reads as the ground moving. Amplitude is in radii and the
   * caller decays it — the effects system owns how long a shake lasts, the camera
   * only knows how to be shaken.
   */
  shake(amplitude: number): void;
  /** True while the pointer is dragging the planet rather than the terrain. */
  readonly panning: boolean;
  /**
   * Point the orbit at a world-space direction (unit vector from the planet's
   * centre). With `immediate` the view snaps there; otherwise it eases via the
   * normal smoothing.
   */
  aimAt(dir: THREE.Vector3, immediate: boolean): void;
  /**
   * A one-time eased pan to a direction over `durationMs` — the match-start
   * tour from the opponent's spawn to the player's. Cancelled by any pointer
   * or wheel input: the player's intent always wins over a cinematic.
   */
  intro(dir: THREE.Vector3, durationMs: number): void;
  /** Slow automatic yaw, in radians per second. Used behind the title and the end card; 0 stops it. */
  drift(radPerSec: number): void;
}

/**
 * @param gestureArmed Set by the gesture recogniser. `verbs.md` gives right-drag
 *   to the camera only "(no spiral)"; once a spiral has armed gesture mode the
 *   stroke belongs to the recogniser and the camera must let go of it, or the
 *   planet turns under a gesture that is being matched in screen space.
 */
export function createCamera(
  canvas: HTMLCanvasElement,
  gestureArmed: { value: boolean },
): OrbitCamera {
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
  /** Intro pan state. Interpolates yaw/pitch directly: the 71 ms smoothing
   *  constant would collapse a 4.5 s tour into a 0.3 s snap. */
  let introActive = false;
  let introFromYaw = 0;
  let introFromPitch = 0;
  let introToYaw = 0;
  let introToPitch = 0;
  let introElapsed = 0;
  let introDuration = 1;
  /** Automatic yaw drift, radians per second. */
  let driftRate = 0;
  /** Where the pointer was when the wheel last turned, in NDC. */
  let zoomAnchorX = 0;
  let zoomAnchorY = 0;

  const PITCH_LIMIT = Math.PI * 0.49;

  const onPointerDown = (ev: PointerEvent): void => {
    // Any press ends the intro tour — the player's intent wins.
    introActive = false;
    // Middle or right button pans; left is the hand (§8: direct drag is
    // raise/lower, and it must stay frictionless).
    if (ev.button !== 2 && ev.button !== 1) return;
    // Middle-click is platform autoscroll on some browsers, and that fires on
    // mousedown regardless of what the pointer handler does afterwards.
    ev.preventDefault();
    panning = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: PointerEvent): void => {
    zoomAnchorX = (ev.clientX / innerWidth) * 2 - 1;
    zoomAnchorY = -(ev.clientY / innerHeight) * 2 + 1;
    // The spiral has claimed this stroke. Drop it mid-drag rather than fighting
    // the recogniser for it, and do not resume until the pointer is released.
    if (panning && gestureArmed.value) {
      panning = false;
      return;
    }
    if (!panning) return;
    // Sensitivity tracks distance, so a pixel of drag moves about the same
    // amount of ground at every zoom level.
    const rate = (DRAG_SENSITIVITY * distance) / DEFAULT_DISTANCE;
    targetYaw -= (ev.clientX - lastX) * rate;
    targetPitch = clamp((ev.clientY - lastY) * rate + targetPitch, -PITCH_LIMIT, PITCH_LIMIT);
    lastX = ev.clientX;
    lastY = ev.clientY;
  };

  const onPointerUp = (ev: PointerEvent): void => {
    panning = false;
    // Unconditionally, because a stroke the gesture recogniser took over ends
    // with `panning` already false and the capture still held.
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };

  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    introActive = false;
    const before = targetDistance;
    targetDistance = clamp(
      targetDistance * Math.exp(wheelPixels(ev) * 0.0012),
      MIN_DISTANCE,
      MAX_DISTANCE,
    );
    // Zoom towards the pointer rather than the centre of the screen: on a globe,
    // zooming to the middle means every approach starts with a chase across the
    // surface. The pointer's offset from centre is converted to the orbit angles
    // it subtends and applied in proportion to how much the distance changed.
    const closer = Math.log(before / targetDistance);
    if (closer !== 0) {
      const halfHeight = Math.tan((camera.fov * Math.PI) / 360);
      const halfWidth = halfHeight * camera.aspect;
      const gain = closer * 0.6;
      targetYaw += zoomAnchorX * halfWidth * gain;
      targetPitch = clamp(targetPitch + zoomAnchorY * halfHeight * gain, -PITCH_LIMIT, PITCH_LIMIT);
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  // Right-drag is the gesture control, so the browser menu is in the way.
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  const eye = new THREE.Vector3();
  const target = new THREE.Vector3();
  const east = new THREE.Vector3();
  const northish = new THREE.Vector3();
  let shakeAmplitude = 0;
  let shakePhase = 0;

  return {
    camera,
    shake(amplitude: number): void {
      shakeAmplitude = amplitude;
    },
    resize(aspect: number): void {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    update(dtMs: number): void {
      if (driftRate !== 0 && !panning && !introActive) {
        targetYaw += driftRate * dtMs * 0.001;
      }
      const k = 1 - Math.exp(-SMOOTHING * dtMs);
      if (introActive) {
        // Cubic ease in-out, driven directly: the smoothing constant below
        // would turn a slow tour into a snap.
        introElapsed += dtMs;
        const t = Math.min(introElapsed / introDuration, 1);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        yaw = introFromYaw + (introToYaw - introFromYaw) * eased;
        pitch = introFromPitch + (introToPitch - introFromPitch) * eased;
        targetYaw = yaw;
        targetPitch = pitch;
        if (t >= 1) introActive = false;
      } else {
        yaw += (targetYaw - yaw) * k;
        pitch += (targetPitch - pitch) * k;
      }
      distance += (targetDistance - distance) * (1 - Math.exp(-ZOOM_SMOOTHING * dtMs));

      const cp = Math.cos(pitch);
      eye.set(
        Math.sin(yaw) * cp * distance,
        Math.sin(pitch) * distance,
        Math.cos(yaw) * cp * distance,
      );
      camera.position.copy(eye);

      // Shake, before the basis is built so `lookAt` still aims at the target and
      // the horizon stays level. Two incommensurable frequencies, so it reads as
      // ground movement rather than as a sine wave.
      if (shakeAmplitude > 0) {
        shakePhase += dtMs * 0.001;
        camera.position.x += Math.sin(shakePhase * 41.0) * shakeAmplitude;
        camera.position.y += Math.sin(shakePhase * 57.3 + 1.7) * shakeAmplitude;
        camera.position.z += Math.sin(shakePhase * 33.7 + 3.1) * shakeAmplitude;
      }

      // A frame on the sphere at the sub-camera point. `east` is horizontal and
      // always perpendicular to `eye`; `northish` completes the tangent frame
      // and points "up-screen" along the surface.
      east.set(Math.cos(yaw), 0, -Math.sin(yaw));
      northish.crossVectors(eye, east).normalize();

      // `northish` as the camera's up vector rather than world +Y. With world
      // +Y, the `lookAt` basis goes degenerate as the view direction approaches
      // the pole — which is what the 0.49pi pitch clamp was really guarding
      // against, and it still let the image roll and jitter near the limit.
      // `northish` is perpendicular to `eye` by construction, so the basis is
      // well-conditioned at every pitch and the horizon stays level.
      camera.up.copy(northish);

      // Tilt toward the horizon as the camera comes in. `t` is 0 at
      // `MAX_DISTANCE` and 1 at `MIN_DISTANCE`; the aim point slides off the
      // planet's centre along `northish`, which rotates the view up toward the
      // limb. Squared, so the far half of the range stays a clean overhead orbit
      // and the tilt arrives with the close approach.
      const t = clamp((MAX_DISTANCE - distance) / (MAX_DISTANCE - MIN_DISTANCE), 0, 1);
      const tilt = MAX_TILT * t * t;
      // `tan(tilt) * distance` is the offset that turns the view by `tilt`.
      target.copy(northish).multiplyScalar(Math.tan(tilt) * distance);
      camera.lookAt(target);

      // Widen the frame as the camera tilts. 45 degrees is narrower than the
      // planet's 47.8-degree angular radius at `MIN_DISTANCE`, so at that end no
      // amount of tilt can hold both the ground below and the limb above; a few
      // degrees more, and both fit with margin at every distance.
      const fov = 45 + 11 * t * t;
      // Near plane against the nearest thing that can be in front of the camera
      // — the closest terrain, which is `distance` less the planet's radius plus
      // its relief. Fixed at 0.01 against a far plane of 100, it was throwing
      // away four orders of magnitude of depth precision on a scene that never
      // gets nearer than about 0.29.
      const near = Math.max(0.02, (distance - BASE_RADIUS * 1.07) * 0.5);
      if (near !== camera.near || fov !== camera.fov) {
        camera.near = near;
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();
    },
    get panning(): boolean {
      return panning;
    },

    aimAt(dir: THREE.Vector3, immediate: boolean): void {
      const { yaw: toYaw, pitch: toPitch } = anglesFor(dir, targetYaw);
      targetYaw = toYaw;
      targetPitch = toPitch;
      if (immediate) {
        yaw = toYaw;
        pitch = toPitch;
      }
    },

    intro(dir: THREE.Vector3, durationMs: number): void {
      const { yaw: toYaw, pitch: toPitch } = anglesFor(dir, yaw);
      introFromYaw = yaw;
      introFromPitch = pitch;
      introToYaw = toYaw;
      introToPitch = toPitch;
      introElapsed = 0;
      introDuration = Math.max(durationMs, 1);
      introActive = true;
    },

    drift(radPerSec: number): void {
      driftRate = radPerSec;
    },
  };
}

/**
 * Orbit angles that put the camera over `dir`, with the yaw expressed as the
 * equivalent nearest `referenceYaw` — otherwise a pan can take the long way
 * around the planet.
 */
function anglesFor(dir: THREE.Vector3, referenceYaw: number): { yaw: number; pitch: number } {
  const pitch = Math.asin(clamp(dir.y, -1, 1));
  let yaw = Math.atan2(dir.x, dir.z);
  const twoPi = Math.PI * 2;
  while (yaw - referenceYaw > Math.PI) yaw -= twoPi;
  while (referenceYaw - yaw > Math.PI) yaw += twoPi;
  return { yaw, pitch };
}

/**
 * Wheel delta in pixels, whatever unit the browser reported.
 *
 * `deltaY` is only pixels when `deltaMode` is `DOM_DELTA_PIXEL`. Firefox
 * defaults to `DOM_DELTA_LINE` and reports about 3 per notch, so treating the
 * number as pixels made one notch a 0.4% zoom — the control was effectively
 * dead there while working fine in Chrome.
 */
function wheelPixels(ev: WheelEvent): number {
  if (ev.deltaMode === 1) return ev.deltaY * 16;
  if (ev.deltaMode === 2) return ev.deltaY * 400;
  return ev.deltaY;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
