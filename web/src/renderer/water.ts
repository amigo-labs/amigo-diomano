/**
 * Water rendering. HANDOFF §7.3 tiers 1 and 2.
 *
 * Tier 1: Beer–Lambert depth absorption — shallow teal to deep blue,
 * exponential, not a linear ramp, because the linear version reads as paint.
 * Tier 2: two normal fields scrolling at different speeds and directions, and
 * sun glitter as a high-exponent specular.
 *
 * # Waves that are actually there
 *
 * The tier-2 ripple perturbs the *normal* only: the sea was lit as though it
 * had waves and had none, so it was flat against the limb and flat under the
 * hand, and a tide could only be read as a number changing. The vertex shader
 * now displaces the surface along its own radial by a sum of three travelling
 * waves, and derives the shading normal from the same expression rather than
 * from the radial. The ripple noise stays, as chop *on* the swell.
 *
 * Displacement is radial only — no Gerstner horizontal pinch. The sideways term
 * is what gives a Gerstner wave its sharp crest, and it also shears the mesh;
 * this mesh is chunked and shares vertices with nothing, so a shear would open
 * visible cracks at every chunk boundary for a crest shape that is invisible at
 * this scale anyway.
 *
 * The amplitude is faded to zero as the water shallows. The water mesh has no
 * skirt (`mesh.rs`, and §7.3 says why), so a sea that still heaved at the
 * waterline would lift clean off the beach and show the gap.
 *
 * Like the terrain, the geometry comes from Rust: the same dual grid, the same
 * chunking, the same zero-copy views. The water surface is a real mesh rather
 * than a sphere at sea level, because the tide has to visibly flood *inland*
 * (§5.5) and a shell at sea level cannot do that.
 */

import * as THREE from "three";
import type { Sim } from "../main";
import { SKY_GLSL } from "./atmosphere";
import { BASE_RADIUS } from "./planet";
import { SURF_GLSL } from "./surf";
import type { View } from "./view";

export interface Water {
  readonly mesh: THREE.Group;
  readonly material: THREE.ShaderMaterial;
  sync(): void;
  /** Full re-upload after an in-place world reset. See `Planet.refreshAll`. */
  refreshAll(): void;
}

/**
 * The travelling swell: direction, wavenumber, amplitude in radii, speed.
 *
 * Three waves in *world* directions rather than in a tangent frame built from
 * the radial. Any such frame has to pick a reference axis and flips at that
 * axis's poles, and a flipped frame is a phase discontinuity — a hard seam
 * across the ocean. A world-space plane wave projected onto the sphere is
 * continuous everywhere; the cost is that the field flattens near the poles of
 * each direction, which three non-parallel directions turn into a calm patch
 * rather than a dead hemisphere.
 *
 * Wavenumbers are radians per world unit. A cell is ~0.0245 radii wide, so
 * k = 70 is a wavelength of about 3.7 cells.
 */
const SWELL_GLSL = /* glsl */ `
  const vec3 DIO_SWELL_DIR_A = vec3(0.80, 0.34, 0.49);
  const vec3 DIO_SWELL_DIR_B = vec3(-0.42, 0.68, 0.60);
  const vec3 DIO_SWELL_DIR_C = vec3(0.31, -0.55, 0.77);
  const vec3 DIO_SWELL_K = vec3(58.0, 91.0, 137.0);
  const vec3 DIO_SWELL_AMP = vec3(0.00300, 0.00180, 0.00100);
  const vec3 DIO_SWELL_SPEED = vec3(0.85, 1.24, 1.71);
`;

const VERTEX_SHADER = /* glsl */ `
  attribute vec4 attrib;   // depth/8 / 255, influence + 128, foam, signed depth/4 + 128

  uniform float uTime;
  uniform float uSurge;
  uniform float uTier;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vInfluence;
  varying float vSigned;

  ${SWELL_GLSL}

  void main() {
    vec3 up = normalize(position);
    vInfluence = attrib.g * 2.0 - 1.0;
    vFoam = attrib.b;
    // Signed height units of water over this vertex: negative where the sea
    // surface runs on under dry land. Interpolated across the quad, its zero is
    // the waterline — see the discard in the fragment shader.
    vSigned = (attrib.a * 255.0 - 128.0) * 4.0;

    // Height units of water over this vertex, for the swell fade.
    float depth = max(vSigned, 0.0);
    // Zero at the waterline, full by four terraces down. Shallow water really
    // does have a smaller swell, and more importantly the sea must stay welded
    // to the shore: there is no skirt under it.
    // Full swell only in genuinely deep water. 260 height units is sixteen
    // terraces: the shelf stays calm, which is both what a shelf does and what
    // keeps the sea welded to a beach it has no skirt to hide behind.
    float shore = smoothstep(0.0, 260.0, depth);
    // Tier 1 keeps a flat sea: the displacement is three sines and a normalise
    // per vertex, and tier 1 exists for hardware that cannot spare it.
    float amp = shore * (0.55 + uSurge * 1.00) * step(1.5, uTier);

    // Sum the three waves and their gradients together. The gradient is what
    // becomes the normal, so it has to come from the same expression as the
    // height or the lighting describes a different sea from the silhouette.
    float h = 0.0;
    vec3 grad = vec3(0.0);
    float phaseA = dot(position, DIO_SWELL_DIR_A) * DIO_SWELL_K.x + uTime * DIO_SWELL_SPEED.x;
    float phaseB = dot(position, DIO_SWELL_DIR_B) * DIO_SWELL_K.y + uTime * DIO_SWELL_SPEED.y;
    float phaseC = dot(position, DIO_SWELL_DIR_C) * DIO_SWELL_K.z + uTime * DIO_SWELL_SPEED.z;
    h += DIO_SWELL_AMP.x * sin(phaseA);
    h += DIO_SWELL_AMP.y * sin(phaseB);
    h += DIO_SWELL_AMP.z * sin(phaseC);
    grad += DIO_SWELL_AMP.x * DIO_SWELL_K.x * cos(phaseA) * DIO_SWELL_DIR_A;
    grad += DIO_SWELL_AMP.y * DIO_SWELL_K.y * cos(phaseB) * DIO_SWELL_DIR_B;
    grad += DIO_SWELL_AMP.z * DIO_SWELL_K.z * cos(phaseC) * DIO_SWELL_DIR_C;
    h *= amp;
    grad *= amp;

    vec3 displaced = position + up * h;
    vWorld = (modelMatrix * vec4(displaced, 1.0)).xyz;
    // World space, for the same reason as planet.ts: normalMatrix is view-space
    // and the sun, the Fresnel view vector and the ripple tangent frame are all
    // world-space. Only the tangential part of the gradient tilts the surface;
    // the radial part is the height change itself and would double-count.
    vec3 tangentGrad = grad - dot(grad, up) * up;
    vNormal = normalize(mat3(modelMatrix) * normalize(up - tangentGrad));
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vInfluence;
  varying float vSigned;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform float uTime;
  uniform float uTier;
  uniform vec3 uGodA;
  uniform vec3 uGodB;
  uniform float uWarning;
  uniform float uSurge;

  ${SKY_GLSL}
  ${SURF_GLSL}

  // Cheap value noise, for the tier-2 ripple normals. Procedural: no textures,
  // no licensing exposure, near-zero repo weight (§7.5).
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  void main() {
    // The sea ends where the ground comes up through it. The signed depth is
    // interpolated across the quad, so this boundary is a curve inside the
    // quad rather than a polyline on the vertex grid — and the depth test does
    // the rest, since the surface is flat and the terrain is not.
    if (vSigned < 0.0) discard;

    vec3 up = normalize(vWorld);
    vec3 viewDir = normalize(uCameraPosition - vWorld);
    vec3 n = normalize(vNormal);

    if (uTier > 1.5) {
      // Two scales: long swell readable from orbit, short chop under the hand.
      vec2 uv = vec2(vWorld.x + vWorld.z, vWorld.y - vWorld.z);
      float a = noise(uv * 9.0 + vec2(uTime * 0.10, uTime * 0.06));
      float b = noise(uv * 42.0 - vec2(uTime * 0.18, uTime * 0.23));
      vec3 tangent = normalize(cross(up, vec3(0.0, 1.0, 0.0) + 0.001));
      vec3 bitangent = cross(up, tangent);
      n = normalize(n + (tangent * (a - 0.5) * 0.22 + bitangent * (b - 0.5) * 0.12));
    }

    // Beer-Lambert: turquoise shelf against a navy open sea. Both ends the
    // same value is a painted fill from orbit; the transition has to be steep.
    float depth = max(vSigned, 0.0);
    vec3 extinction = vec3(0.055, 0.022, 0.012);
    vec3 transmit = exp(-extinction * depth * 0.55);
    vec3 shallow = vec3(0.07, 0.28, 0.30);
    vec3 deep = vec3(0.02, 0.07, 0.16);
    vec3 body = mix(deep, shallow, transmit);
    float day = max(dot(n, uSunDirection), 0.0);
    body *= 0.45 + day * 0.70;

    body = mix(body, body * mix(uGodB, uGodA, clamp(vInfluence * 0.5 + 0.5, 0.0, 1.0)),
               min(abs(vInfluence) * 0.5, 0.14));

    // Grazing water reflects a little sky, not a mirror. Looking across the
    // close-in horizon used to turn the whole working frame into atmosphere.
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 6.0);
    vec3 sky = dioAirColour(reflect(-viewDir, n), up, uSunDirection, uWarning) * 0.40;
    vec3 colour = mix(body, sky, fresnel * 0.12);

    if (uTier > 1.5) {
      vec3 h = normalize(uSunDirection + viewDir);
      float spec = pow(max(dot(n, h), 0.0), 320.0);
      colour += spec * vec3(0.40, 0.38, 0.30);
    }

    // Foam where the water is moving fast enough to erode (§4.4). Driven by the
    // simulation's own erosion marker, so foam appears exactly where terrain is
    // being cut — the visual and the mechanic cannot disagree.
    float foam = clamp(vFoam * 2.2, 0.0, 0.7);

    // Breakers. Erosion foam was the *only* white the sea had, so a coast with
    // nothing being cut on it had no surf at all: the water met the sand at a
    // hard line. dioSurf is shared with the terrain shader, which draws the
    // other half of the same wash on the sand — see surf.ts.
    //
    // The jitter is one noise sample, and it is what stops a breaker from being
    // a perfect iso-line of the depth field, which reads as a contour map.
    vec2 surfUv = vec2(vWorld.x + vWorld.z, vWorld.y - vWorld.z);
    float jitter = noise(surfUv * 22.0) * 2.0 - 1.0;
    float surf = dioSurf(depth, uTime, uSurge, jitter);
    // Foam is white and slightly blue-lifted, and it sits on top of whatever the
    // water was doing rather than replacing it.
    colour = mix(colour, vec3(0.92, 0.96, 0.98), max(foam, surf * 0.62));

    // The same air as the terrain, at the same strength — and only the colour
    // is hazed, not the alpha. The ground showing through a shallow sea has
    // already been hazed by exactly this much in its own shader, so fogging both
    // layers by the same fraction and then blending them is the same result as
    // fogging the blend, without the sea having to know what is under it.
    vec4 air = dioAerial(vWorld, uCameraPosition, uSunDirection, uWarning);
    // Same limb gate as the terrain, weaker: water is already sky-coloured
    // through its Fresnel term, so it needs less help to meet the horizon at
    // the same colour as the land beside it.
    float limb = 1.0 - smoothstep(0.12, 0.62, max(dot(up, viewDir), 0.0));
    colour = mix(colour, air.rgb, air.a * limb * 0.50);

    // Fade out over the last terrace of depth.
    //
    // The waterline itself is pixel-exact now (the signed depth above, and the
    // depth buffer against a flat sea), so this fade is no longer hiding a
    // vertex-grid polyline. It stays because shallow water *is* see-through:
    // the last terrace hands over to the terrain's wet-sand band and to the
    // surf, and a hard-edged sheet of 92% alpha at the beach would read as
    // glass laid on the sand.
    float edge = smoothstep(0.0, 16.0, depth);
    float alpha = clamp(0.92 + depth * 0.004, 0.92, 0.995) * edge;
    // Foam is the exception: a breaker is opaque white whatever the depth under
    // it, and it is what the eye reads the waterline from.
    alpha = max(alpha, surf * 0.85);
    gl_FragColor = vec4(colour, alpha);
  }
`;

export function createWater(sim: Sim, view: View): Water {
  const group = new THREE.Group();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    uniforms: {
      // Shared by reference — see `view.ts`.
      uSunDirection: view.sunDirection,
      uCameraPosition: view.cameraPosition,
      uTime: view.time,
      uWarning: view.warning,
      uSurge: view.surge,
      uTier: { value: 2 },
      uGodA: { value: new THREE.Color(1.05, 0.95, 0.85) },
      uGodB: { value: new THREE.Color(0.85, 0.92, 1.1) },
    },
  });

  // One geometry for the whole ocean, same reasoning as `planet.ts`: 96 water
  // chunks would spend two thirds of the §7.3 draw-call budget on a surface
  // that is one material and one shader.
  //
  // The index buffer covers only chunks that actually hold water. Rust
  // publishes that per chunk, and on a land-heavy map it removes most of the
  // ocean's triangles rather than relying on the fragment shader to discard
  // them after rasterising. It is rebuilt only when the wet set changes, which
  // on a normal map is a handful of times per tide cycle.
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(sim.waterPositions, 3);
  const attrib = new THREE.BufferAttribute(sim.waterAttribs, 4, true);
  position.setUsage(THREE.DynamicDrawUsage);
  attrib.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  // The resting surface normal is the outward radial, which is the normalised
  // position; the tier-2 ripple perturbs it in the shader. A separate normal
  // buffer would be another 400 KB for something the shader recomputes anyway.
  geometry.setAttribute("normal", position);
  geometry.setAttribute("attrib", attrib);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BASE_RADIUS * 3);

  const indices = new Uint32Array(sim.chunks * sim.indicesPerChunk);
  const indexAttribute = new THREE.BufferAttribute(indices, 1);
  indexAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setIndex(indexAttribute);

  // The wet set, as it was when the index buffer was last built. Compared
  // element-wise rather than by building a 96-character string every frame:
  // this runs once per frame forever, and the string was pure garbage.
  const wetSignature = new Uint8Array(sim.chunks);
  let haveSignature = false;
  const rebuildIndices = (): void => {
    if (haveSignature) {
      let changed = false;
      for (let chunk = 0; chunk < sim.chunks; chunk++) {
        if (wetSignature[chunk] !== sim.meshWaterPresent[chunk]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    wetSignature.set(sim.meshWaterPresent);
    haveSignature = true;

    let out = 0;
    for (let chunk = 0; chunk < sim.chunks; chunk++) {
      if (sim.meshWaterPresent[chunk] === 0) continue;
      const base = chunk * sim.vertsPerChunk;
      for (let k = 0; k < sim.indicesPerChunk; k++) {
        indices[out] = base + (sim.meshIndices[k] ?? 0);
        out += 1;
      }
    }
    geometry.setDrawRange(0, out);
    indexAttribute.needsUpdate = true;
  };
  rebuildIndices();

  const mesh = new THREE.Mesh(geometry, material);
  // Drawn after the terrain so the transparent surface blends over it, and
  // before the clouds and the atmosphere.
  mesh.renderOrder = 1;
  group.add(mesh);

  return {
    mesh: group,
    material,
    sync(): void {
      rebuildIndices();
      position.clearUpdateRanges();
      attrib.clearUpdateRanges();
      let dirty = 0;
      for (let chunk = 0; chunk < sim.chunks; chunk++) {
        if (sim.meshDirty[chunk] === 0) continue;
        dirty += 1;
        const start = chunk * sim.vertsPerChunk;
        position.addUpdateRange(start * 3, sim.vertsPerChunk * 3);
        attrib.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
      }
      if (dirty > 0) {
        position.needsUpdate = true;
        attrib.needsUpdate = true;
      }
      // `uTime` is the shared render clock in `view.ts`; nothing to set here.
      // It drives ripples only, and a ripple phase must never be able to reach
      // simulation state (§10).
    },

    refreshAll(): void {
      // Drop the wet-set cache too: a reset world may coincidentally match the
      // old signature and skip the index rebuild it needs.
      haveSignature = false;
      rebuildIndices();
      for (const a of [position, attrib]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
    },
  };
}
