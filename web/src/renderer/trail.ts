/**
 * The gesture light trail. HANDOFF §8.
 *
 * > All are drawn with the hand; a clockwise spiral arms gesture mode first,
 * > **confirmed by a light trail**.
 *
 * That confirmation did not exist. `gestures.armed` was exported with the
 * comment "the caller draws the trail" and no caller read it, so arming a
 * gesture produced no visible change whatsoever — the player had to guess
 * whether a spiral had registered, and the only way to find out was whether the
 * verb fired several seconds later. With right-drag also orbiting the planet at
 * the time, an armed gesture and a camera drag looked exactly alike.
 *
 * # Why it is drawn in 3D
 *
 * §8 forbids a HUD and `index.html` deliberately has no DOM overlay, so the
 * trail is geometry like everything else: the sampled pointer path, unprojected
 * onto a plane a short way in front of the camera. It follows the camera rather
 * than the planet, because the stroke is a screen-space path — that is what the
 * recogniser matches — and pinning it to the terrain would make it disagree with
 * the thing it is confirming.
 *
 * One draw call, one buffer, allocated once.
 */

import * as THREE from "three";

/** Sampled points the trail can show. The recogniser resamples to 32. */
const MAX_POINTS = 96;
/** How far in front of the camera the trail sits, in world units. */
const TRAIL_DEPTH = 0.25;

export interface Trail {
  readonly object: THREE.Object3D;
  /**
   * @param stroke Pointer path in client pixels, oldest first.
   * @param armed Whether gesture mode is armed; the trail only shows when it is.
   */
  sync(
    camera: THREE.PerspectiveCamera,
    stroke: readonly { readonly x: number; readonly y: number }[],
    armed: boolean,
  ): void;
}

export function createTrail(): Trail {
  const positions = new Float32Array(MAX_POINTS * 3);
  // Alpha ramps along the stroke so the trail reads as a direction rather than
  // as a static shape: the head is bright, the tail has faded out.
  const alphas = new Float32Array(MAX_POINTS);

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  const alpha = new THREE.BufferAttribute(alphas, 1);
  position.setUsage(THREE.DynamicDrawUsage);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  geometry.setAttribute("alpha", alpha);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // In front of the planet whatever the depth says: it is an interface
    // element, and a trail that disappears behind a mountain is not a
    // confirmation.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.72) * vAlpha, vAlpha);
      }
    `,
  });

  const line = new THREE.Line(geometry, material);
  line.renderOrder = 4;
  line.frustumCulled = false;
  line.visible = false;

  const ndc = new THREE.Vector3();

  return {
    object: line,
    sync(camera, stroke, armed): void {
      // Two points is the minimum that draws anything, and an unarmed stroke is
      // a camera drag rather than a gesture.
      if (!armed || stroke.length < 2) {
        line.visible = false;
        geometry.setDrawRange(0, 0);
        return;
      }

      // Keep the most recent points if the stroke has outgrown the buffer.
      const first = Math.max(0, stroke.length - MAX_POINTS);
      const count = stroke.length - first;
      for (let i = 0; i < count; i++) {
        const p = stroke[first + i]!;
        ndc.set((p.x / innerWidth) * 2 - 1, -(p.y / innerHeight) * 2 + 1, 0.5);
        // Unproject to a ray, then walk a fixed distance along it, so the trail
        // keeps a constant apparent thickness and never intersects the terrain.
        ndc.unproject(camera);
        ndc.sub(camera.position).normalize().multiplyScalar(TRAIL_DEPTH).add(camera.position);
        positions[i * 3] = ndc.x;
        positions[i * 3 + 1] = ndc.y;
        positions[i * 3 + 2] = ndc.z;
        // Oldest point faintest. Squared, so the tail goes quickly and the
        // recent motion is what stands out.
        const along = count === 1 ? 1 : i / (count - 1);
        alphas[i] = along * along * 0.9;
      }

      geometry.setDrawRange(0, count);
      position.needsUpdate = true;
      alpha.needsUpdate = true;
      line.visible = true;
    },
  };
}
