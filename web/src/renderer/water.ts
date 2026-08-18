/**
 * Water rendering. HANDOFF §7.3 tiers 1 and 2.
 *
 * Tier 1: Beer–Lambert depth absorption — shallow teal to deep blue,
 * exponential, not a linear ramp, because the linear version reads as paint.
 * Tier 2: two normal fields scrolling at different speeds and directions, and
 * sun glitter as a high-exponent specular.
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
import type { View } from "./view";

export interface Water {
  readonly mesh: THREE.Group;
  readonly material: THREE.ShaderMaterial;
  sync(): void;
  /** Full re-upload after an in-place world reset. See `Planet.refreshAll`. */
  refreshAll(): void;
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec4 attrib;   // depth/8 / 255, influence + 128, foam, dry flag

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vDepth;
  varying float vFoam;
  varying float vInfluence;
  varying float vDry;

  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    // World space, for the same reason as planet.ts: normalMatrix is view-space
    // and the sun, the Fresnel view vector and the ripple tangent frame are all
    // world-space. The normal attribute here *is* the position buffer, so this
    // is the outward radial.
    vNormal = normalize(mat3(modelMatrix) * normal);
    vDepth = attrib.r;
    vInfluence = attrib.g * 2.0 - 1.0;
    vFoam = attrib.b;
    vDry = attrib.a;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vDepth;
  varying float vFoam;
  varying float vInfluence;
  varying float vDry;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform float uTime;
  uniform float uTier;
  uniform vec3 uGodA;
  uniform vec3 uGodB;
  uniform float uWarning;

  ${SKY_GLSL}

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
    if (vDry < 0.5) discard;

    vec3 up = normalize(vWorld);
    vec3 viewDir = normalize(uCameraPosition - vWorld);
    vec3 n = normalize(vNormal);

    if (uTier > 1.5) {
      // Two normal fields at different speeds and directions. One alone reads
      // as a moving texture; two reads as water.
      vec2 uv = vec2(vWorld.x + vWorld.z, vWorld.y - vWorld.z) * 40.0;
      float a = noise(uv + vec2(uTime * 0.18, uTime * 0.11));
      float b = noise(uv * 1.9 - vec2(uTime * 0.07, uTime * 0.23));
      vec3 tangent = normalize(cross(up, vec3(0.0, 1.0, 0.0) + 0.001));
      vec3 bitangent = cross(up, tangent);
      n = normalize(n + (tangent * (a - 0.5) + bitangent * (b - 0.5)) * 0.50);
    }

    // Beer-Lambert absorption: transmittance falls exponentially with depth,
    // and each channel falls at its own rate. That is the whole reason shallow
    // water is teal and deep water is blue.
    //
    // Body colours stay dark. The previous shallow teal sat near the top of
    // the exposure range; ACES + bloom turned every sunlit bay into a white
    // sheet, and with alpha 0.42 the planet read as a glass marble.
    float depth = vDepth * 255.0 * 8.0;         // back to height units
    vec3 extinction = vec3(0.045, 0.018, 0.010);
    vec3 transmit = exp(-extinction * depth * 0.45);
    vec3 shallow = vec3(0.04, 0.20, 0.24);
    vec3 deep = vec3(0.01, 0.04, 0.11);
    vec3 body = mix(deep, shallow, transmit);
    // The sea has a terminator. Without it the sunlit hemisphere is a flat
    // painted shell — the same "glass marble" the opacity fix was for.
    float day = max(dot(n, uSunDirection), 0.0);
    body *= 0.38 + day * 0.72;

    // The two gods tint their own seas, faintly (§7.4).
    body = mix(body, body * mix(uGodB, uGodA, clamp(vInfluence * 0.5 + 0.5, 0.0, 1.0)),
               min(abs(vInfluence) * 0.6, 0.18));

    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
    // What the sea reflects is the sky it is actually under, from the one model
    // of it in atmosphere.ts — so the water goes warm where the sun is low on it
    // and red under a tide warning, instead of reflecting a constant blue that
    // contradicts the horizon it sits against.
    // A small mix: a 0.7 sky blend is a mirror, and a mirrored sphere is the
    // "the planet is transparent" read.
    vec3 sky = dioAirColour(reflect(-viewDir, n), up, uSunDirection, uWarning) * 0.55;
    vec3 colour = mix(body, sky, fresnel * 0.28);

    if (uTier > 1.5) {
      // Sun glitter: high-exponent specular on the ocean.
      vec3 h = normalize(uSunDirection + viewDir);
      float spec = pow(max(dot(n, h), 0.0), 280.0);
      colour += spec * vec3(0.55, 0.50, 0.40);
    }

    // Foam where the water is moving fast enough to erode (§4.4). Driven by the
    // simulation's own erosion marker, so foam appears exactly where terrain is
    // being cut — the visual and the mechanic cannot disagree.
    colour = mix(colour, vec3(0.92, 0.96, 0.98), clamp(vFoam * 2.2, 0.0, 0.7));

    // The same air as the terrain, at the same strength — and only the colour
    // is hazed, not the alpha. The ground showing through a shallow sea has
    // already been hazed by exactly this much in its own shader, so fogging both
    // layers by the same fraction and then blending them is the same result as
    // fogging the blend, without the sea having to know what is under it.
    vec4 air = dioAerial(vWorld, uCameraPosition, uSunDirection, uWarning);
    // Half the haze the land takes: water is already sky-coloured, so a full
    // mix turns the sea into the same pale sheet as the horizon.
    colour = mix(colour, air.rgb, air.a * dioNearHaze(vWorld, uCameraPosition) * 0.5);

    // Opaque enough that the far side of the sphere cannot show through.
    // Shallows still let a little seafloor through — that is the coastal read —
    // but the previous 0.42 floor was a window, not a sea.
    float alpha = clamp(0.84 + depth * 0.006, 0.84, 0.98);
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
