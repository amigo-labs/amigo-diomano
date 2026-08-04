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
import { BASE_RADIUS, HEIGHT_TO_RADIUS } from "./planet";

export interface Water {
  readonly mesh: THREE.Group;
  readonly material: THREE.ShaderMaterial;
  sync(seaLevel: number, tick: number): void;
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
    vNormal = normalize(normalMatrix * normal);
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
      n = normalize(n + (tangent * (a - 0.5) + bitangent * (b - 0.5)) * 0.35);
    }

    // Beer-Lambert absorption: transmittance falls exponentially with depth,
    // and each channel falls at its own rate. That is the whole reason shallow
    // water is teal and deep water is blue.
    float depth = vDepth * 255.0 * 8.0;         // back to height units
    vec3 extinction = vec3(0.030, 0.011, 0.006);
    vec3 transmit = exp(-extinction * depth * 0.35);
    vec3 shallow = vec3(0.26, 0.76, 0.72);
    vec3 deep = vec3(0.01, 0.06, 0.22);
    vec3 body = mix(deep, shallow, transmit);

    // The two gods tint their own seas, faintly (§7.4).
    body = mix(body, body * mix(uGodB, uGodA, clamp(vInfluence * 0.5 + 0.5, 0.0, 1.0)),
               min(abs(vInfluence) * 1.2, 0.4));

    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
    vec3 sky = vec3(0.36, 0.52, 0.78);
    vec3 colour = mix(body, sky, fresnel * 0.7);

    if (uTier > 1.5) {
      // Sun glitter: high-exponent specular on the ocean.
      vec3 h = normalize(uSunDirection + viewDir);
      float spec = pow(max(dot(n, h), 0.0), 220.0);
      colour += spec * vec3(1.2, 1.1, 0.9);
    }

    // Foam where the water is moving fast enough to erode (§4.4). Driven by the
    // simulation's own erosion marker, so foam appears exactly where terrain is
    // being cut — the visual and the mechanic cannot disagree.
    colour = mix(colour, vec3(0.92, 0.96, 0.98), clamp(vFoam * 2.2, 0.0, 0.7));

    float alpha = clamp(0.42 + depth * 0.010, 0.42, 0.96);
    gl_FragColor = vec4(colour, alpha);
  }
`;

export function createWater(sim: Sim): Water {
  const group = new THREE.Group();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0.6, 0.5, 0.6).normalize() },
      uCameraPosition: { value: new THREE.Vector3() },
      uTime: { value: 0 },
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

  let wetSignature = "";
  const rebuildIndices = (): void => {
    let signature = "";
    for (let chunk = 0; chunk < sim.chunks; chunk++) {
      signature += sim.meshWaterPresent[chunk] ? "1" : "0";
    }
    if (signature === wetSignature) return;
    wetSignature = signature;

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
    sync(seaLevel: number, tick: number): void {
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
      // Render time, not simulation time: this drives ripples only, and a
      // ripple phase must never be able to reach simulation state (§10).
      material.uniforms.uTime!.value = tick / 30;
      void seaLevel;
      void HEIGHT_TO_RADIUS;
    },
  };
}
