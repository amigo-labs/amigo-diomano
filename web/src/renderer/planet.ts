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
import { CLOUD_NOISE_GLSL } from "./atmosphere";
import type { View } from "./view";

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
   * Re-upload every vertex buffer in full. Needed after an in-place world
   * reset: `dio_init` re-meshes everything, but `Mesh::update` clears the
   * dirty flags at the top of the next call — before `sync` reads them — and
   * the content hashes then match, so nothing ever re-uploads and the screen
   * keeps showing the dead world.
   */
  refreshAll(): void;
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
  attribute vec4 attrib2;  // lava, fertility, sediment, spare

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vAttrib;
  varying vec4 vAttrib2;
  varying float vAltitude;

  uniform float uSeaRadius;

  void main() {
    // World space, not normalMatrix. Three builds normalMatrix from the
    // *modelView* matrix, so it yields a view-space normal — and every consumer
    // below is world-space: the sun vector, up = normalize(vWorld), the slope
    // blend and the sky bounce. Mixing the two made the terminator and the
    // steep-reads-as-rock band swing around as the camera orbited.
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vAttrib = attrib;
    vAttrib2 = attrib2;
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
  varying vec4 vAttrib2;
  varying float vAltitude;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform vec3 uGodA;
  uniform vec3 uGodB;
  uniform float uCloudTime;
  uniform float uCloudFade;
  uniform float uTier;

  ${CLOUD_NOISE_GLSL}

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

    // Fertility enriches and darkens soil; sediment pales it toward silt. Both
    // are simulation state that reached the renderer for the first time here —
    // §7.4 asks for all five fields and only three were being written, so ground
    // that the simulation treats as rich or as silted up looked identical to bare
    // material. Subtle on purpose: these are properties of the ground, and the
    // reading the player needs from them is "this valley is different", not a
    // colour key.
    albedo = mix(albedo, albedo * vec3(0.80, 0.94, 0.68), vAttrib2.g * 0.55);
    albedo = mix(albedo, vec3(0.72, 0.66, 0.52), vAttrib2.b * 0.40);

    // Vegetation is simulation state, not a shader flourish — this is the same
    // field that damps water transfer in §4.3.
    float veg = vAttrib.g;
    albedo = mix(albedo, vec3(0.18, 0.34, 0.16), veg * 0.85);

    // Steep ground sheds soil and vegetation and shows the rock beneath.
    albedo = mix(albedo, vec3(0.38, 0.36, 0.38), smoothstep(0.35, 0.75, slope));

    // Snow on high flat ground.
    //
    // The band has to sit inside the altitude the terrain can actually reach.
    // world.rs generates with amp = 720, and 720 * HEIGHT_TO_RADIUS = 0.0576
    // radii, so the old 0.055..0.085 band only ever reached about a tenth of its
    // range at the global maximum: a tier-1 feature that was dead in practice.
    // Starting at 0.032 puts the snowline around 400 height units, which
    // hand-raised peaks and generated mountains both clear.
    float snow = smoothstep(0.032, 0.050, vAltitude) * (1.0 - smoothstep(0.2, 0.5, slope));
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
    // Cloud shadows, from the same noise the cloud shell draws (§7.3 tier 2),
    // fading out with the shell as the camera comes in (view.ts, cloudFade) —
    // a shadow whose cloud has dissolved would crawl over the ground alone.
    if (uTier > 1.5) {
      lambert *= 1.0 - dioClouds(up, uCloudTime) * 0.45 * uCloudFade;
    }
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

    // Lava, and it is emissive rather than lit: it *is* the light source, so it
    // is written over the shaded result instead of being multiplied by the sun.
    // That is also why it survives the night side and the cloud shadows, which is
    // the whole point of a volcano at night.
    //
    // Until now the renderer could not see lava at all — the field was mapped
    // into JavaScript and read by nothing — so §5.3's volcano produced no hot
    // lava anywhere, only ash-coloured ground once it had already cooled. The
    // ramp runs dark crust to yellow-white core by depth, and the peak lands
    // above the bloom threshold on purpose, so a flow glows into the air around
    // it.
    float lava = vAttrib2.r;
    if (lava > 0.002) {
      float heat = smoothstep(0.03, 0.60, lava);
      vec3 molten = mix(vec3(0.30, 0.035, 0.012), vec3(1.75, 0.80, 0.20), heat);
      lit = mix(lit, molten, smoothstep(0.008, 0.09, lava));
    }

    gl_FragColor = vec4(lit, 1.0);
  }
`;

export function createPlanet(sim: Sim, view: View): Planet {
  const group = new THREE.Group();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      // Shared by reference with every other material — see `view.ts` for why
      // these three are not allowed to be private copies.
      uSunDirection: view.sunDirection,
      uCameraPosition: view.cameraPosition,
      uCloudTime: view.cloudTime,
      uCloudFade: view.cloudFade,
      uSeaRadius: { value: BASE_RADIUS },
      uGodA: { value: new THREE.Color(1.06, 0.93, 0.82) },
      uGodB: { value: new THREE.Color(0.82, 0.9, 1.1) },
      uTier: { value: 2 },
    },
  });

  // ---------------------------------------------------------------------
  // One geometry for the whole planet, not one per chunk.
  //
  // §7.3 caps draw calls at 150 and 96 terrain chunks plus 96 water chunks
  // blows that on its own. The chunks do not need to be separate objects: Rust
  // already writes every chunk's vertices into *one contiguous* Float32Array,
  // so a single `BufferAttribute` spans the lot and one index buffer with a
  // per-chunk base offset draws them all in a single call.
  //
  // Dirty-chunk updates survive intact. `addUpdateRange` uploads only the byte
  // range a rebuilt chunk occupies, so a changed chunk still costs one small
  // upload rather than the whole 400 KB buffer.
  // ---------------------------------------------------------------------
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(sim.meshPositions, 3);
  const normal = new THREE.BufferAttribute(sim.meshNormals, 3);
  const attrib = new THREE.BufferAttribute(sim.meshAttribs, 4, true);
  const attrib2 = new THREE.BufferAttribute(sim.meshAttribs2, 4, true);
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  attrib.setUsage(THREE.DynamicDrawUsage);
  attrib2.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute("position", position);
  geometry.setAttribute("normal", normal);
  geometry.setAttribute("attrib", attrib);
  geometry.setAttribute("attrib2", attrib2);
  geometry.setIndex(new THREE.BufferAttribute(buildPlanetIndices(sim), 1));
  // The terrain deforms constantly, so a bounding sphere computed from the
  // vertices would be stale within a second. One that always contains the
  // planet costs nothing and never culls geometry that should be drawn.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BASE_RADIUS * 3);
  group.add(new THREE.Mesh(geometry, material));

  return {
    group,
    material,
    sync(seaLevel: number): void {
      // Only chunks Rust rebuilt are re-uploaded (§7.1 "only dirty chunks
      // re-meshed"). Uploading all 96 every frame would make the dirty tracking
      // pointless, so each rebuilt chunk contributes its own update range.
      position.clearUpdateRanges();
      normal.clearUpdateRanges();
      attrib.clearUpdateRanges();
      attrib2.clearUpdateRanges();
      let dirty = 0;
      for (let chunk = 0; chunk < sim.chunks; chunk++) {
        if (sim.meshDirty[chunk] === 0) continue;
        dirty += 1;
        const start = chunk * sim.vertsPerChunk;
        position.addUpdateRange(start * 3, sim.vertsPerChunk * 3);
        normal.addUpdateRange(start * 3, sim.vertsPerChunk * 3);
        attrib.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
        attrib2.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
      }
      if (dirty > 0) {
        position.needsUpdate = true;
        normal.needsUpdate = true;
        attrib.needsUpdate = true;
        attrib2.needsUpdate = true;
      }
      material.uniforms.uSeaRadius!.value = BASE_RADIUS + seaLevel * HEIGHT_TO_RADIUS;
    },

    refreshAll(): void {
      for (const a of [position, normal, attrib, attrib2]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
    },

    pick(dir: THREE.Vector3): { face: number; x: number; y: number } {
      return pickCell(dir, sim.N);
    },
  };
}

/**
 * The whole planet's index buffer: every chunk's shared topology, rebased.
 *
 * `Uint32Array` because 96 chunks x 361 vertices overflows 16 bits, and the
 * cost of that is 750 KB uploaded exactly once against 95 draw calls saved
 * every frame.
 */
function buildPlanetIndices(sim: Sim): Uint32Array {
  const out = new Uint32Array(sim.chunks * sim.indicesPerChunk);
  for (let chunk = 0; chunk < sim.chunks; chunk++) {
    const base = chunk * sim.vertsPerChunk;
    const at = chunk * sim.indicesPerChunk;
    for (let k = 0; k < sim.indicesPerChunk; k++) {
      out[at + k] = base + (sim.meshIndices[k] ?? 0);
    }
  }
  return out;
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
  return cellDirectionInto(new THREE.Vector3(), face, x + 0.5, y + 0.5, N);
}

/**
 * Forward map at a *continuous* face coordinate, writing into `out`.
 *
 * `fx`/`fy` are in cell units with cell `i` centred at `i + 0.5` — the same
 * convention `walkers.rs` spawns with (`(x << 16) + ONE / 2`), so a walker's
 * Q16.16 position can be passed straight in and drawn where the simulation
 * actually put it rather than snapped to the nearest cell centre.
 *
 * Takes an `out` vector because the callers are per-instance loops running every
 * tick; returning a fresh `Vector3` made this one of the largest sources of
 * garbage in the frame.
 */
export function cellDirectionInto(
  out: THREE.Vector3,
  face: number,
  fx: number,
  fy: number,
  N: number,
): THREE.Vector3 {
  const a = Math.tan((((fx * 2) / N - 1) * Math.PI) / 4);
  const b = Math.tan((((fy * 2) / N - 1) * Math.PI) / 4);
  const n = FACE_NORMAL[face] ?? FACE_NORMAL[0]!;
  const r = FACE_RIGHT[face] ?? FACE_RIGHT[0]!;
  const u = FACE_UP[face] ?? FACE_UP[0]!;
  return out
    .set(n[0] + r[0] * a + u[0] * b, n[1] + r[1] * a + u[1] * b, n[2] + r[2] * a + u[2] * b)
    .normalize();
}
