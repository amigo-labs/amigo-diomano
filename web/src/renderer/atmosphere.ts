/**
 * Atmosphere, sun and the tide telegraph. HANDOFF §7.2, §7.3 tier 1, §5.5.
 *
 * §7.3 calls the atmosphere "~20 lines of shader, one draw call, highest impact
 * per line in the whole list", and that is accurate: a slightly larger sphere
 * with a Fresnel rim, drawn back-face, is most of what makes a small planet read
 * as a planet rather than as a lumpy ball.
 *
 * # The tide telegraph lives here
 *
 * §5.5 requires the wave to be legible before it lands and §8 forbids a HUD, so
 * the warning is atmospheric: during the telegraph phase the rim reddens and
 * thickens, and the sun dims. Combined with the sea visibly drawing back off
 * every shore (`tide.rs`), a player can tell a wave is coming without a single
 * UI element — which is the acceptance criterion, stated as a criterion.
 */

import * as THREE from "three";
import { BASE_RADIUS } from "./planet";

/** Tide phases, mirroring `world.rs`. */
const TIDE_TELEGRAPH = 1;
const TIDE_IMPACT = 2;

export interface Atmosphere {
  readonly group: THREE.Group;
  readonly sunDirection: THREE.Vector3;
  readonly material: THREE.ShaderMaterial;
  /** Cloud scroll phase, so the terrain shader can cast the same shadows. */
  readonly cloudTime: { value: number };
  sync(tick: number, tidePhase: number, ticksToImpact: number): void;
}

/**
 * 3D value noise, shared verbatim between the cloud shell and the terrain
 * shader's ground shadows (§7.3 tier 2: "sample the same noise in the terrain
 * shader for ground shadows").
 *
 * Exported as a string rather than duplicated, because two copies would drift
 * and the symptom would be cloud shadows that do not line up with the clouds —
 * subtle enough to look like a lighting bug rather than a copy-paste one.
 */
export const CLOUD_NOISE_GLSL = /* glsl */ `
  float dioHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float dioNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(dioHash(i + vec3(0,0,0)), dioHash(i + vec3(1,0,0)), f.x),
          mix(dioHash(i + vec3(0,1,0)), dioHash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(dioHash(i + vec3(0,0,1)), dioHash(i + vec3(1,0,1)), f.x),
          mix(dioHash(i + vec3(0,1,1)), dioHash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  /// Cloud cover at a point on the unit sphere, in 0..1.
  float dioClouds(vec3 dir, float t) {
    vec3 p = dir * 4.0 + vec3(t * 0.06, 0.0, t * 0.021);
    float v = dioNoise(p) * 0.55 + dioNoise(p * 2.3) * 0.28 + dioNoise(p * 5.1) * 0.17;
    // Thresholded high on purpose. Clouds are atmosphere, not weather: at much
    // more than a third cover they stop framing the planet and start hiding the
    // thing the player is trying to read, and §8 has already spent the entire
    // information budget on the world itself.
    return smoothstep(0.55, 0.86, v);
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vWorld;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform vec3 uCalmTint;
  uniform vec3 uWarningTint;
  uniform float uWarning;   // 0 calm .. 1 imminent

  void main() {
    vec3 viewDir = normalize(uCameraPosition - vWorld);
    // Drawn back-face, so the geometric normal points inward.
    vec3 n = normalize(-vNormal);
    float rim = pow(1.0 - abs(dot(n, viewDir)), 2.6);
    // Thicker and hotter as a wave approaches; that thickening *is* the warning.
    rim *= mix(1.0, 1.9, uWarning);

    float sunFacing = clamp(dot(normalize(vWorld), uSunDirection) * 0.5 + 0.5, 0.0, 1.0);
    vec3 tint = mix(uCalmTint, uWarningTint, uWarning);
    vec3 colour = tint * rim * mix(0.35, 1.6, sunFacing);
    gl_FragColor = vec4(colour, clamp(rim * mix(0.9, 1.5, uWarning), 0.0, 1.0));
  }
`;

export function createAtmosphere(): Atmosphere {
  const group = new THREE.Group();
  const sunDirection = new THREE.Vector3(0.6, 0.5, 0.6).normalize();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDirection: { value: sunDirection },
      uCameraPosition: { value: new THREE.Vector3() },
      uCalmTint: { value: new THREE.Color(0.35, 0.62, 1.0) },
      uWarningTint: { value: new THREE.Color(1.0, 0.42, 0.28) },
      uWarning: { value: 0 },
    },
  });

  const shell = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS * 1.09, 64, 48), material);
  // Drawn last of everything. The rim is additive, so anything drawn after it
  // alpha-blends *over* the glow and darkens it — which is what put a grey ring
  // around the planet when the cloud shell came after.
  shell.renderOrder = 3;
  group.add(shell);

  // The sun is the atmosphere's business, so the lights that stand in for it
  // live here and follow the same vector the shaders read. Two lights that
  // disagree about where the sun is would be very hard to see and impossible to
  // reason about.
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
  const fill = new THREE.AmbientLight(0x2c3d58, 1.2);
  group.add(sun, fill);

  // Cloud shell (§7.3 tier 2). A scrolling noise sphere just above the terrain;
  // the terrain shader samples the same noise so the shadows are the clouds
  // rather than a second, unrelated pattern.
  const cloudTime = { value: 0 };
  const cloudMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSunDirection: { value: sunDirection },
      uTime: cloudTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSunDirection;
      uniform float uTime;
      ${CLOUD_NOISE_GLSL}
      void main() {
        float cover = dioClouds(vDir, uTime);
        if (cover <= 0.001) discard;
        // Fade out towards the sphere's silhouette. Without this the shell's
        // own limb — which curves onto the night side — draws a dark ring
        // around the whole planet, over space, where there is no atmosphere to
        // be seen edge-on in the first place.
        float facing = dot(vDir, normalize(cameraPosition));
        float visible = smoothstep(0.28, 0.62, facing);
        if (visible <= 0.001) discard;
        // Lit from the same direction as everything else, and dimmer on the
        // night side so clouds do not glow over a dark hemisphere.
        float lambert = max(dot(vDir, uSunDirection), 0.0);
        vec3 colour = mix(vec3(0.42, 0.47, 0.58), vec3(1.0, 0.98, 0.95), lambert);
        gl_FragColor = vec4(colour, cover * visible * 0.5);
      }
    `,
  });
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(BASE_RADIUS * 1.03, 96, 64),
    cloudMaterial,
  );
  // Terrain 0, water 1, clouds 2, atmosphere 3.
  clouds.renderOrder = 2;
  group.add(clouds);

  // Space behind the planet. A pure black background makes the limb read as a
  // cut-out; a faint starfield gives the curvature something to be silhouetted
  // against. Procedural, like everything else (§7.5).
  group.add(makeStarfield());

  return {
    group,
    sunDirection,
    material,
    cloudTime,
    sync(tick: number, tidePhase: number, ticksToImpact: number): void {
      // Simulation time, so clouds move at a rate a player can relate to the
      // tide clock. It reaches no simulation state; the flow is one-way.
      cloudTime.value = tick / 30;
      // The sun has its own slow day cycle rather than being fixed in space
      // (§7.2). One full turn every four minutes of play.
      const angle = (tick / (30 * 240)) * Math.PI * 2;
      sunDirection.set(Math.cos(angle), 0.42, Math.sin(angle)).normalize();

      // Warning ramps up over the last ten seconds before impact and stays hot
      // through the surge.
      let warning = 0;
      if (tidePhase === TIDE_TELEGRAPH) {
        warning = 1 - Math.min(ticksToImpact / 300, 1);
      } else if (tidePhase === TIDE_IMPACT) {
        warning = 1;
      }
      material.uniforms.uWarning!.value = warning;
      sun.position.copy(sunDirection).multiplyScalar(10);
      // The sun dims as the sky reddens, which is the other half of the tide's
      // no-UI warning.
      sun.intensity = 2.4 - warning * 0.9;
    },
  };
}

function makeStarfield(): THREE.Points {
  const count = 900;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  // A fixed seed: the sky is part of the world, and a sky that reshuffles on
  // every reload is a distraction rather than a backdrop. This PRNG is render
  // side and deliberately unconnected to the simulation PRNG (§10).
  let s = 0x2f6e2b1;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere, not uniform in (theta, phi) — otherwise the poles
    // acquire visible clusters.
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const d = 40;
    positions[i * 3] = Math.cos(theta) * r * d;
    positions[i * 3 + 1] = u * d;
    positions[i * 3 + 2] = Math.sin(theta) * r * d;
    sizes[i] = 0.05 + rand() * 0.16;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float size;
      varying float vSize;
      void main() {
        vSize = size;
        vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
        gl_PointSize = size * 12.0;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      varying float vSize;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d) * vSize * 4.0;
        gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -1;
  points.frustumCulled = false;
  return points;
}
