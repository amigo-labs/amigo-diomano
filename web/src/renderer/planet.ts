/**
 * Terrain rendering. HANDOFF §7.1, §7.3 tier 1, §7.4.
 *
 * The vertex data is built in Rust and lives in wasm linear memory. This module
 * wraps it — `BufferAttribute` views straight onto `memory.buffer`, no copy, no
 * conversion — and sets `needsUpdate` on the chunks Rust says it rebuilt.
 * TypeScript never computes a vertex position.
 *
 * # Colour comes from simulation data, not from art
 *
 * §7.4: the simulation already carries `material`, `vegetation` and `influence`,
 * so they are written as vertex attributes and the shader blends from them. A
 * valley that was flooded stays darker and greener; where lava ran, rock
 * remains. The two gods' colour moods blend by `influence`, which makes the
 * boundary between the zones the most visually interesting region of the planet
 * — and that is exactly where the war happens.
 *
 * That is also what makes §8's "no HUD" survivable: the planet is the
 * scoreboard, so standings have to be readable from the render alone.
 */

import * as THREE from "three";
import type { Sim } from "../main";

/** Planet radius at height 0. Mirrors `mesh::BASE_RADIUS`. */
export const BASE_RADIUS = 1.0;
/** Radius change per height unit. Mirrors `mesh::HEIGHT_TO_RADIUS`. */
export const HEIGHT_TO_RADIUS = 0.00008;

/** Face bases, mirroring `mesh.rs` — needed to invert the projection for picking. */
const FACE_NORMAL: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const FACE_RIGHT: readonly (readonly [number, number, number])[] = [
  [0, 0, -1],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
];
const FACE_UP: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
  [0, 1, 0],
];

export interface Planet {
  readonly group: THREE.Group;
  readonly material: THREE.ShaderMaterial;
  sync(seaLevel: number): void;
  /**
   * Which cell a direction from the planet centre points at.
   *
   * Inverts the tangent-adjusted cube projection of §3.2, so a click lands on
   * the cell the player is actually looking at rather than one drifting towards
   * the face corners.
   */
  pick(dir: THREE.Vector3): { face: number; x: number; y: number };
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec4 attrib;   // material / 255, vegetation, influence + 128, depth

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vAttrib;
  varying float vAltitude;

  uniform float uSeaRadius;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vAttrib = attrib;
    // Metres above the current waterline, roughly. The wet-sand band and the
    // snowline both key off this, so both migrate as sea level moves.
    vAltitude = length(position) - uSeaRadius;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vAttrib;
  varying float vAltitude;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform vec3 uGodA;
  uniform vec3 uGodB;
  uniform float uTime;

  // Material ids from world.rs: 0 rock, 1 sand, 2 soil, 3 ash, 4 swamp.
  vec3 materialColour(float id) {
    float m = id * 255.0;
    vec3 rock  = vec3(0.42, 0.41, 0.44);
    vec3 sand  = vec3(0.83, 0.72, 0.48);
    vec3 soil  = vec3(0.34, 0.40, 0.24);
    vec3 ash   = vec3(0.24, 0.22, 0.23);
    vec3 swamp = vec3(0.26, 0.31, 0.25);
    vec3 c = rock;
    c = mix(c, sand,  step(0.5, m) * (1.0 - step(1.5, m)));
    c = mix(c, soil,  step(1.5, m) * (1.0 - step(2.5, m)));
    c = mix(c, ash,   step(2.5, m) * (1.0 - step(3.5, m)));
    c = mix(c, swamp, step(3.5, m));
    return c;
  }

  void main() {
    vec3 up = normalize(vWorld);
    vec3 n = normalize(vNormal);
    // Slope- and height-based texturing (§7.3): steep reads as rock, flat as
    // grass, high as snow. Avoids UV-mapping a quadsphere entirely.
    float slope = 1.0 - clamp(dot(n, up), 0.0, 1.0);

    vec3 albedo = materialColour(vAttrib.r);

    // Vegetation is simulation state, not a shader flourish — this is the same
    // field that damps water transfer in §4.3.
    float veg = vAttrib.g;
    albedo = mix(albedo, vec3(0.18, 0.34, 0.16), veg * 0.85);

    // Steep ground sheds soil and vegetation and shows the rock beneath.
    albedo = mix(albedo, vec3(0.38, 0.36, 0.38), smoothstep(0.35, 0.75, slope));

    // Snow on high flat ground.
    float snow = smoothstep(0.055, 0.085, vAltitude) * (1.0 - smoothstep(0.2, 0.5, slope));
    albedo = mix(albedo, vec3(0.94, 0.96, 1.0), snow);

    // Wet-sand band at the waterline: darken by distance to the current water
    // height. Costs nothing, and since water level is the core mechanic this
    // band visibly migrates during play (§7.3).
    float wet = 1.0 - smoothstep(0.0, 0.010, max(vAltitude, 0.0));
    albedo *= mix(1.0, 0.55, wet);

    // Standing water tints the ground it sits on.
    albedo = mix(albedo, albedo * vec3(0.60, 0.80, 0.92), clamp(vAttrib.a * 8.0, 0.0, 1.0));

    // Territory takes on the aesthetic of the god who shaped it (pillar 6).
    float influence = vAttrib.b * 2.0 - 1.0;
    vec3 mood = mix(uGodB, uGodA, clamp(influence * 0.5 + 0.5, 0.0, 1.0));
    albedo = mix(albedo, albedo * mood, min(abs(influence) * 1.6, 0.65));

    // Ocean floor: darken with depth so the sea reads as depth rather than as
    // a blue sheet laid over a beach.
    float depth = vAttrib.a * 255.0 * 8.0;
    albedo *= exp(-depth * 0.0016);

    float lambert = max(dot(n, uSunDirection), 0.0);
    vec3 viewDir = normalize(uCameraPosition - vWorld);
    // Soft camera-anchored fill so the night side stays readable (§7.2). Small:
    // it is there to keep the dark side legible, not to light the scene.
    float fill = max(dot(n, viewDir), 0.0) * 0.10;
    // Sky bounce, so shadowed slopes are blue rather than black.
    float sky = clamp(dot(n, up) * 0.5 + 0.5, 0.0, 1.0) * 0.10;

    vec3 lit = albedo * (lambert * vec3(1.15, 1.05, 0.92) + fill + sky * vec3(0.30, 0.42, 0.68));

    // Rim light, so the limb separates from space at every camera angle.
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
    lit += rim * vec3(0.10, 0.15, 0.26);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

export function createPlanet(sim: Sim): Planet {
  const group = new THREE.Group();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0.6, 0.5, 0.6).normalize() },
      uCameraPosition: { value: new THREE.Vector3() },
      uSeaRadius: { value: BASE_RADIUS },
      uGodA: { value: new THREE.Color(1.06, 0.93, 0.82) },
      uGodB: { value: new THREE.Color(0.82, 0.9, 1.1) },
      uTime: { value: 0 },
    },
  });

  // One shared index buffer: every chunk has identical topology, so uploading
  // 96 copies of the same 1944 indices would be 96 times the GPU memory for no
  // reason at all.
  const sharedIndex = new THREE.BufferAttribute(sim.meshIndices, 1);

  const attributes: {
    position: THREE.BufferAttribute;
    normal: THREE.BufferAttribute;
    attrib: THREE.BufferAttribute;
  }[] = [];

  for (let chunk = 0; chunk < sim.chunks; chunk++) {
    const v0 = chunk * sim.vertsPerChunk;
    const geometry = new THREE.BufferGeometry();

    // `subarray` shares the underlying ArrayBuffer — this is the zero copy.
    const position = new THREE.BufferAttribute(
      sim.meshPositions.subarray(v0 * 3, (v0 + sim.vertsPerChunk) * 3),
      3,
    );
    const normal = new THREE.BufferAttribute(
      sim.meshNormals.subarray(v0 * 3, (v0 + sim.vertsPerChunk) * 3),
      3,
    );
    const attrib = new THREE.BufferAttribute(
      sim.meshAttribs.subarray(v0 * 4, (v0 + sim.vertsPerChunk) * 4),
      4,
      true,
    );
    position.setUsage(THREE.DynamicDrawUsage);
    normal.setUsage(THREE.DynamicDrawUsage);
    attrib.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("position", position);
    geometry.setAttribute("normal", normal);
    geometry.setAttribute("attrib", attrib);
    geometry.setIndex(sharedIndex);
    // The terrain deforms constantly, so a bounding sphere computed from the
    // vertices would be stale within a second. One that always contains the
    // planet costs nothing and never culls a chunk that should be drawn.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BASE_RADIUS * 3);

    attributes.push({ position, normal, attrib });
    group.add(new THREE.Mesh(geometry, material));
  }

  return {
    group,
    material,
    sync(seaLevel: number): void {
      // Only chunks Rust rebuilt are re-uploaded (§7.1 "only dirty chunks
      // re-meshed"). Setting `needsUpdate` on all 96 every frame would make the
      // dirty tracking pointless.
      for (let chunk = 0; chunk < sim.chunks; chunk++) {
        if (sim.meshDirty[chunk] === 0) continue;
        const a = attributes[chunk];
        if (!a) continue;
        a.position.needsUpdate = true;
        a.normal.needsUpdate = true;
        a.attrib.needsUpdate = true;
      }
      material.uniforms.uSeaRadius!.value = BASE_RADIUS + seaLevel * HEIGHT_TO_RADIUS;
    },
    pick(dir: THREE.Vector3): { face: number; x: number; y: number } {
      return pickCell(dir, sim.N);
    },
  };
}

/**
 * Invert the tangent-adjusted cube-to-sphere projection.
 *
 * The forward map warps a face coordinate by `tan(a * pi/4)`; the inverse is
 * `atan(a) * 4/pi`. Skipping the inverse warp — just using the raw ratio — puts
 * the cursor up to a cell and a half off near face corners, which reads as "the
 * hand is inaccurate" rather than as a projection bug.
 */
export function pickCell(dir: THREE.Vector3, N: number): { face: number; x: number; y: number } {
  const v = dir.clone().normalize();
  const abs = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)] as const;
  let axis = 0;
  if (abs[1]! > abs[axis]!) axis = 1;
  if (abs[2]! > abs[axis]!) axis = 2;
  const positive = (axis === 0 ? v.x : axis === 1 ? v.y : v.z) >= 0;
  const face = axis * 2 + (positive ? 0 : 1);

  const n = FACE_NORMAL[face]!;
  const r = FACE_RIGHT[face]!;
  const u = FACE_UP[face]!;
  const denom = v.x * n[0] + v.y * n[1] + v.z * n[2];
  if (denom <= 1e-6) return { face, x: 0, y: 0 };

  const a = (v.x * r[0] + v.y * r[1] + v.z * r[2]) / denom;
  const b = (v.x * u[0] + v.y * u[1] + v.z * u[2]) / denom;

  const unwarp = (t: number): number => (Math.atan(t) * 4) / Math.PI;
  const cx = Math.floor(((unwarp(a) + 1) * N) / 2);
  const cy = Math.floor(((unwarp(b) + 1) * N) / 2);
  return {
    face,
    x: Math.min(N - 1, Math.max(0, cx)),
    y: Math.min(N - 1, Math.max(0, cy)),
  };
}

/** Forward map: cell centre to a unit direction. The inverse of `pickCell`. */
export function cellDirection(face: number, x: number, y: number, N: number): THREE.Vector3 {
  const warp = (t: number): number => Math.tan((t * Math.PI) / 4);
  const a = warp(((x + 0.5) * 2) / N - 1);
  const b = warp(((y + 0.5) * 2) / N - 1);
  const n = FACE_NORMAL[face] ?? FACE_NORMAL[0]!;
  const r = FACE_RIGHT[face] ?? FACE_RIGHT[0]!;
  const u = FACE_UP[face] ?? FACE_UP[0]!;
  return new THREE.Vector3(
    n[0] + r[0] * a + u[0] * b,
    n[1] + r[1] * a + u[1] * b,
    n[2] + r[2] * a + u[2] * b,
  ).normalize();
}
