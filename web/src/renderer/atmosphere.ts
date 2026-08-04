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
  sync(tick: number, tidePhase: number, ticksToImpact: number): void;
}

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
  shell.renderOrder = 2;
  group.add(shell);

  // The sun is the atmosphere's business, so the lights that stand in for it
  // live here and follow the same vector the shaders read. Two lights that
  // disagree about where the sun is would be very hard to see and impossible to
  // reason about.
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
  const fill = new THREE.AmbientLight(0x2c3d58, 1.2);
  group.add(sun, fill);

  // Space behind the planet. A pure black background makes the limb read as a
  // cut-out; a faint starfield gives the curvature something to be silhouetted
  // against. Procedural, like everything else (§7.5).
  group.add(makeStarfield());

  return {
    group,
    sunDirection,
    material,
    sync(tick: number, tidePhase: number, ticksToImpact: number): void {
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
