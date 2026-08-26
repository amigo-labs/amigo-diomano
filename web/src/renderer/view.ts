/**
 * The render-side values every shader shares. HANDOFF §7.2, §7.3.
 *
 * # Why this file exists
 *
 * Three values used to be declared once per material: the camera position, the
 * sun direction and the cloud clock. Every one of them drifted, and each drift
 * silently disabled a shipped feature:
 *
 * - `uCameraPosition` was declared in three shaders and written by none, so it
 *   stayed at the origin. `viewDir` was therefore the inward radial everywhere:
 *   the terrain's rim term evaluated to 1.0 over the *whole* planet instead of
 *   at the limb (a flat blue wash), the water's Fresnel likewise (a flat sky
 *   wash over the Beer-Lambert gradient the shader exists for), and the
 *   atmosphere shell's rim came out exactly 0 — so the effect §7.3 calls
 *   "highest impact per line in the whole list" drew nothing at all, and with it
 *   the entire no-HUD tide telegraph, which only ever multiplies that rim.
 * - Two sun vectors: `atmosphere.ts` rotated its own on the §7.2 day cycle while
 *   `planet.ts` and `water.ts` each constructed a private copy that never moved.
 *   The terrain's terminator stood still while the clouds and the lights turned.
 * - `uCloudTime` was declared on the terrain material and never written, so the
 *   ground shadows sampled a frozen noise field while the shell scrolled —
 *   precisely the "shadows that do not line up with the clouds casting them"
 *   failure `CLOUD_NOISE_GLSL` was shared to prevent. Sharing the noise stopped
 *   the *pattern* from drifting; nothing had shared the clock.
 *
 * Three uniform objects are shared by reference, so holding them once makes the
 * drift unrepresentable rather than merely unlikely — the same argument that
 * already justifies exporting `CLOUD_NOISE_GLSL` instead of copying it. A new
 * material gets these by asking for them; it cannot get its own by accident.
 */

import * as THREE from "three";

export interface View {
  /** Camera world position. Every view-dependent term reads this. */
  readonly cameraPosition: { value: THREE.Vector3 };
  /** Sun direction, on the §7.2 day cycle. The one authority. */
  readonly sunDirection: { value: THREE.Vector3 };
  /** Cloud scroll phase, shared by the shell and the ground shadows. */
  readonly cloudTime: { value: number };
  /**
   * Real elapsed seconds, for water ripples.
   *
   * Wall clock rather than `tick / 30`, which is what this used to be: the
   * simulation runs at a fixed 30 Hz, so a tick-derived phase advanced the
   * ripple normals in 33 ms steps and the sea visibly stuttered on anything
   * faster than a 30 Hz display. The distinction is safe precisely because this
   * value drives ripples only and never reaches simulation state (§10) — which
   * is what `water.ts` claimed ("render time, not simulation time") while
   * actually being handed simulation time.
   *
   * `cloudTime` stays on simulation time deliberately: clouds should move at a
   * rate a player can relate to the tide clock, and the terrain samples the same
   * clock for ground shadows.
   */
  readonly time: { value: number };
  /** Distance from the planet centre, for distance-keyed shading. */
  readonly cameraDistance: { value: number };
  /**
   * Cloud visibility keyed to the camera distance: 1 pulled back, 0 close in.
   *
   * The cloud shell sits at 1.065 radii and the camera's floor is 1.35, so the
   * eye can never physically pass under the clouds — but sculpting is done at
   * the close end, and a cloud bank parked over the working area hides exactly
   * the terrain the player is trying to read. Fading the cover out on approach
   * *is* descending below the weather, done in the only axis available. Shared
   * here because the terrain's ground shadows must fade in step with the shell,
   * or shadows of vanished clouds crawl over the ground on their own.
   */
  readonly cloudFade: { value: number };
  /**
   * The tide telegraph, 0 calm to 1 imminent. Written by `atmosphere.sync`.
   *
   * It lives here rather than in `atmosphere.ts` because the warning is a
   * property of the air, and since the air is now evaluated by every ground
   * shader as well as by the limb shell (`SKY_GLSL`), a private copy would
   * redden the rim while leaving the haze over the ground calmly blue — the
   * exact class of split-brain drift this file exists to make unrepresentable.
   */
  readonly warning: { value: number };
  /**
   * The sea's own answer to the tide, 0 calm to 1 at the peak of a wave.
   *
   * `warning` is the *air* — the sky reddens, the sun dims — and it is already
   * hot through the whole telegraph, when the sea is drawn back and unnaturally
   * flat. This is the water: it tracks the actual signed tide offset, so the
   * swell builds as the wave lands and settles as it recedes. Written by
   * `atmosphere.sync` beside `warning`, for the same reason `warning` lives here
   * rather than in one material.
   */
  readonly surge: { value: number };
  sync(camera: THREE.Camera, tick: number, dtMs: number): void;
}

/** One full turn of the sun every four minutes of play (§7.2). */
const DAY_TICKS = 30 * 240;

export function createView(): View {
  const cameraPosition = { value: new THREE.Vector3(0, 0, 3) };
  const sunDirection = { value: new THREE.Vector3(0.6, 0.5, 0.6).normalize() };
  const cloudTime = { value: 0 };
  const time = { value: 0 };
  const cameraDistance = { value: 3 };
  const cloudFade = { value: 1 };
  const warning = { value: 0 };
  const surge = { value: 0 };

  return {
    cameraPosition,
    sunDirection,
    cloudTime,
    time,
    cameraDistance,
    cloudFade,
    warning,
    surge,
    sync(camera: THREE.Camera, tick: number, dtMs: number): void {
      // `matrixWorld` rather than `position`, so this stays correct if the
      // camera is ever parented to something.
      cameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
      cameraDistance.value = cameraPosition.value.length();
      // Full cover from 2.15 radii out, thinned to a quarter by 1.55 — the
      // close half of the zoom range works under a nearly clear sky, but the
      // clouds never dissolve entirely: the shell at 1.065 R is the one layer
      // that parallaxes against the ground while orbiting, the most direct
      // it-is-a-sphere cue the renderer has, and at a floor of 0.25 x 0.16
      // alpha (~4% cover) it cannot hide terrain. BASE_RADIUS is 1, so the
      // distance already is in radii. Smoothstep, computed once here rather
      // than per-fragment in two shaders; the ground shadows share the value.
      const t = Math.min(Math.max((cameraDistance.value - 1.55) / (2.15 - 1.55), 0), 1);
      cloudFade.value = 0.25 + 0.75 * (t * t * (3 - 2 * t));
      const angle = (tick / DAY_TICKS) * Math.PI * 2;
      sunDirection.value.set(Math.cos(angle), 0.42, Math.sin(angle)).normalize();
      // Simulation time, so clouds move at a rate a player can relate to the
      // tide clock. The flow is one-way: nothing here reaches simulation state.
      cloudTime.value = tick / 30;
      // Accumulated rather than read from a clock, so a paused or backgrounded
      // tab resumes the ripple phase where it left off instead of jumping.
      time.value += dtMs / 1000;
    },
  };
}
