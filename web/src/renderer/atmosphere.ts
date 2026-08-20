/**
 * Atmosphere, sun and the tide telegraph. HANDOFF §7.2, §7.3 tier 1, §5.5.
 *
 * §7.3 calls the atmosphere "~20 lines of shader, one draw call, highest impact
 * per line in the whole list", and that is accurate: a slightly larger sphere
 * with a Fresnel rim, drawn back-face, is most of what makes a small planet read
 * as a planet rather than as a lumpy ball.
 *
 * # One model of the air, evaluated everywhere
 *
 * A rim shell alone draws a ring around the planet and nothing else, and a ring
 * is not a sky. What makes the horizon in a *Populous: The Beginning* screenshot
 * read as sky is that the ground goes with it: the terrain fades into the same
 * colour the band above the limb is made of, so the two meet without a seam and
 * the eye reads air rather than a decorated edge.
 *
 * So the model lives in `SKY_GLSL` and every surface evaluates it — terrain,
 * sea, trees, settlements, walkers, clouds, the limb shell and the stars behind
 * it. It is one assumption: an exponential shell of air, one `DIO_SCALE_HEIGHT`
 * thick, around a unit sphere. Ask that shell how much air a view ray crosses
 * and both halves of the effect fall out of the same number:
 *
 * - **Almost nothing where the camera is looking.** A ray to the ground beneath
 *   the eye crosses about one vertical air column; the working area comes out a
 *   few percent hazed and stays readable, which §8 requires — the information
 *   budget is spent on the world, not on weather.
 * - **A sky at the horizon.** A ray that grazes the surface crosses two orders
 *   of magnitude more of the same column, so ground near the limb drowns in air
 *   while the band just above it glows with the light that ground lost. The
 *   crossover sits exactly at the visible horizon *by construction*, at every
 *   camera distance from 1.35 to 4.2 radii, with no per-distance falloff to
 *   tune and nothing to re-tune when the camera range changes.
 *
 * The steepness of that curve is exaggerated (`DIO_GRAZE`) and the limb glow is
 * spread wider than the density profile (`DIO_SKY_HEIGHT`); both are documented
 * where they are defined, and both are deliberate departures from a model that
 * is otherwise doing the arithmetic honestly.
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
import type { View } from "./view";

/** Tide phases, mirroring `world.rs`. */
const TIDE_TELEGRAPH = 1;
const TIDE_IMPACT = 2;

export interface Atmosphere {
  readonly group: THREE.Group;
  /** The shared sun vector, for anything that needs to read it directly. */
  readonly sunDirection: THREE.Vector3;
  readonly material: THREE.ShaderMaterial;
  sync(tidePhase: number, ticksToImpact: number): void;
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
    // Broken banks, not a veil. Cover much above a third hides the surface
    // the player has to read (§8), and white over a dark sea is milk.
    return smoothstep(0.74, 0.93, v);
  }
`;

/**
 * The air, as every shader sees it. Shared for the same reason
 * `CLOUD_NOISE_GLSL` is: two copies would drift, and the symptom would be a
 * horizon whose ground and whose sky are different colours — a seam exactly
 * where the effect is supposed to be seamless.
 *
 * Provides `dioAirmass`, `dioAirColour`, `dioAerial` and `dioNearHaze`.
 * Callers supply the sun direction and the tide warning; nothing here reads a
 * uniform of its own, so it can be pasted into a `ShaderMaterial` or a patched
 * `MeshLambertMaterial` without agreeing on uniform names beyond those two.
 */
export const SKY_GLSL = /* glsl */ `
  /**
   * Scale height of the air, in planet radii: how fast density falls with
   * altitude, and therefore the whole shape of the effect.
   *
   * Thin — 0.018 radii is 225 height units — and that is the load-bearing
   * choice. The ratio between the horizon column and the vertical one is
   * sqrt(2 / H), so a *thinner* atmosphere is a *sharper* horizon: it is what
   * keeps the haze off the ground under the camera while piling it up at the
   * limb. A thick sky would be visible everywhere and nowhere in particular.
   *
   * It also puts generated peaks (up to 720 units, 3.2 scale heights) well above
   * the murk, so a distant summit stands clear of the valley it rises out of.
   */
  const float DIO_SCALE_HEIGHT = 0.018;
  /**
   * How far the glow above the limb is spread, in radii. Larger than the density
   * profile on purpose, and this is the one place the two part company.
   *
   * The limb shell draws light scattered towards the eye out of air that is not
   * in front of anything — and that light has bounced more than once, so the
   * glow reaches higher and fades softer than the single-scattering profile
   * says. Modelling that properly is a ray march; spreading the falloff is one
   * multiply, and the difference between them is invisible next to what it buys:
   * a soft sky several degrees deep instead of a hairline seam on the edge of
   * the planet. Both still agree *exactly* at h = 0, which is the only place
   * they have to.
   */
  const float DIO_SKY_HEIGHT = 0.038;
  // Optical depth of one vertical air column — the haze looking straight down at
  // the ground beneath the camera. Deliberately almost nothing: half a percent.
  const float DIO_HAZE = 0.0055;
  // Thickened for the tide telegraph (§5.5), along with the reddening below.
  const float DIO_HAZE_WARNING = 0.009;
  /**
   * Contrast between the vertical column and the grazing one. This is the one
   * number here that is a decision rather than a consequence, so it is worth
   * being explicit about what it buys.
   *
   * The honest airmass ratio between straight down and the horizon is sqrt(2/H),
   * about 10.5 here. That is the right answer for a planet and the wrong answer
   * for *this* camera: at the 1.35-radius floor it tilts 32 degrees off nadir
   * (see camera.ts), so the ground under the cursor is already 30 degrees around
   * the curve at an airmass of 4 — not far off the horizon's own. Straight from
   * the physics the working area comes out a fifth hazed, which is aerial
   * perspective, correctly derived, and unusable: §8 spends the entire
   * information budget on reading the world.
   *
   * Squaring the column keeps the *shape* — the same curve, peaking exactly at
   * the visible horizon at every camera distance — and pulls its ends apart, to
   * about 110:1. The working area drops to a few percent and everything the haze
   * took from it lands where the sky is supposed to be. Populous horizons are
   * painted with the same bias, for the same reason.
   */
  const float DIO_GRAZE = 2.4;

  // Rayleigh-ish: the colour of air with the sun off to one side. Saturated
  // rather than pale, and that is a decision about *this* planet: sunlit sand
  // and shallow sea here sit near the top of the exposure range, so a
  // desaturated sky comes out the same value as the ground it is supposed to
  // separate from and the horizon disappears into a white-on-white edge.
  const vec3 DIO_SKY_BLUE = vec3(0.26, 0.48, 1.00);
  // The warm forward-scatter halo you get looking *through* air towards the sun.
  const vec3 DIO_SKY_SUN = vec3(1.00, 0.76, 0.48);
  // Tide telegraph. The whole sky reddens, not just the rim (§5.5, §8).
  const vec3 DIO_SKY_WARNING = vec3(1.00, 0.38, 0.22);

  /**
   * Air column along a ray leaving the surface at cos(zenith angle) = c,
   * relative to the column straight up. The exact integral is Chapman's
   * function; this is the usual rational stand-in for it, and it is right at
   * both ends that matter: ~1 at the zenith, sqrt(2 / H) at the horizon.
   *
   * Using the *radial* rather than the surface normal for the zenith angle is
   * what makes this correct rather than merely plausible: c falls to zero
   * exactly at the camera's visible horizon, where the view ray really does go
   * tangent, at every camera distance. Nothing here has to know how far away the
   * eye is.
   */
  float dioAirmass(float c) {
    c = max(c, 0.0);
    return 2.0 / (c + sqrt(c * c + 2.0 * DIO_SCALE_HEIGHT));
  }

  /// The air a ray crosses, in vertical columns, as the shaders actually use it.
  float dioColumn(float c) {
    return pow(dioAirmass(c), DIO_GRAZE);
  }

  /**
   * The colour of lit air along a view ray. \`rayDir\` points away from the eye,
   * \`up\` is the radial at the air being looked through.
   */
  vec3 dioAirColour(vec3 rayDir, vec3 up, vec3 sunDir, float warning) {
    // Look towards the sun through a lot of air and it goes warm and bright.
    // This is the difference between a horizon and a sunset, and it is why the
    // limb is not the same colour all the way round.
    float forward = max(dot(rayDir, sunDir), 0.0);
    vec3 tint = mix(DIO_SKY_BLUE, DIO_SKY_SUN, pow(forward, 3.0) * 0.80);
    tint = mix(tint, DIO_SKY_WARNING, warning * 0.7);
    // Air is not a light source. On the night side there is nothing to scatter,
    // so the haze there is a dark blue that hides stars rather than a glow that
    // lights a hemisphere the sun has left.
    float day = smoothstep(-0.35, 0.28, dot(up, sunDir));
    return tint * mix(0.05, 1.0, day);
  }

  /**
   * The air between a surface point and the eye: \`rgb\` is the light scattered
   * into the ray, \`a\` is how much of the surface behind it that air hides.
   *
   * Composite with \`mix(surface, air.rgb, air.a)\`. Against black space that is
   * the same as adding \`air.rgb * air.a\`, which is exactly what the limb shell
   * does — so ground and sky meet at the horizon with no seam to hide.
   */
  vec4 dioAerial(vec3 world, vec3 eye, vec3 sunDir, float warning) {
    vec3 up = normalize(world);
    vec3 rayDir = normalize(world - eye);
    // Density where the ray ends. Air thins with altitude, so a peak is clearer
    // than the valley beside it and a flooded basin is the haziest thing in
    // frame.
    float rho = exp(-max(length(world) - 1.0, 0.0) / DIO_SCALE_HEIGHT);
    float tau = mix(DIO_HAZE, DIO_HAZE_WARNING, warning) * rho * dioColumn(dot(up, -rayDir));
    return vec4(dioAirColour(rayDir, up, sunDir, warning), 1.0 - exp(-tau));
  }

  /**
   * Distance gate for patched Lambert materials (trees, settlements, walkers)
   * that cannot cheaply share the terrain's view-zenith limb test. Terrain and
   * water key haze off the view zenith instead: distance alone still left
   * the sunlit disk sky-coloured, because from orbit every surface is far.
   */
  float dioNearHaze(vec3 world, vec3 eye) {
    return smoothstep(0.70, 2.20, length(eye - world));
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    // No normal is interpolated: the glow is a function of the line of sight, not
    // of the shell's surface orientation. See the fragment shader.
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform float uWarning;   // 0 calm .. 1 imminent

  ${SKY_GLSL}

  void main() {
    // # Why this is not a Fresnel rim
    //
    // The shell is drawn BackSide, so what is rasterised is the inner surface of
    // its *far* hemisphere — and the planet occludes all of that except the
    // annulus between the planet's limb and the shell's. The atmosphere is
    // therefore only ever visible outside the planet's silhouette, and a
    // 1 - dot(n, viewDir) falloff is brightest at the shell's own silhouette,
    // i.e. at the edge furthest from the planet. That is upside down: it drew a
    // dim blue tyre around the planet, brightening outward into space.
    //
    // Air density is a function of altitude, so brightness should be too. What
    // this shell draws is the air a ray crosses when it *misses* the planet, and
    // that column is governed entirely by the ray's closest approach to the
    // centre.
    vec3 d = normalize(vWorld - uCameraPosition);
    // Rays that strike the planet never reach this shell — the ground shaders
    // already put the air in front of the surface. Without the test, a BackSide
    // fragment whose closest approach sits inside the sphere (h ≈ 0) paints
    // the disk with the whole tangent column. The feather starts at 0.972
    // rather than hard against the limb: the outer ~3% of the disc gets a thin
    // wedge of shell fog over it, so ground fades *into* the sky band instead
    // of meeting it at a step — while the other 94% of the disc still gets no
    // shell contribution at all, which is the invariant this test exists for.
    float b = length(cross(uCameraPosition, d));
    float offPlanet = smoothstep(0.972, 1.002, b);
    if (offPlanet <= 0.001) discard;
    // Closest approach: the lowest point of the ray, where nearly all of its
    // scattering happens and the only place worth asking about the sun. Clamped
    // to the ray rather than the line — for every fragment this shell actually
    // rasterises the closest approach is in front of the eye, but the same
    // expression in the starfield is not so lucky (see makeStarfield), and two
    // copies of one calculation that disagree about their domain is how that
    // kind of bug gets to live in only one of them.
    float t = max(-dot(uCameraPosition, d), 0.0);
    vec3 graze = uCameraPosition + d * t;
    float h = length(graze) - 1.0;

    // Column density for a ray at altitude h through an exponential shell is
    // rho(h) * sqrt(2 pi H), i.e. the tangent column times exp(-h / H). Written
    // as DIO_HAZE * dioAirmass(0) * exp(-h / H) it agrees *by construction* with
    // what the ground shaders compute at h = 0 — so the band above the limb and
    // the hazed ground below it are the same colour at the same brightness where
    // they meet, and the horizon has no seam in it.
    float tau = mix(DIO_HAZE, DIO_HAZE_WARNING, uWarning) * dioColumn(0.0) * exp(-max(h, 0.0) / DIO_SKY_HEIGHT);
    float cover = 1.0 - exp(-tau);

    // Additive against black space is identical to compositing over it, so this
    // is the same operator the terrain uses, not an approximation of it.
    vec3 colour = dioAirColour(d, normalize(graze), uSunDirection, uWarning);
    gl_FragColor = vec4(colour * cover * offPlanet, 1.0);
  }
`;

export function createAtmosphere(view: View): Atmosphere {
  const group = new THREE.Group();
  const sunDirection = view.sunDirection.value;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      // Shared by reference — see `view.ts`.
      uSunDirection: view.sunDirection,
      uCameraPosition: view.cameraPosition,
      uWarning: view.warning,
    },
  });

  // 1.16 radii, up from 1.075. The shell is not the atmosphere's thickness — it
  // is the *bounds* of it, and anything the falloff has not yet reached when the
  // geometry ends becomes a hard circular cut against space. At 1.075 the glow
  // was still at 8% of its peak when it ran out of sphere, which is what capped
  // the effect at a thin ring; five scale heights out it has decayed to 0.6% and
  // the sky ends by fading rather than by stopping.
  //
  // The ceiling on this number is the camera: `MIN_DISTANCE` is 1.35 radii, and
  // a camera inside a BackSide shell sees the inside of the sky and nothing
  // else. 1.16 keeps a comfortable margin under that.
  const shell = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS * 1.16, 96, 64), material);
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
  // Brighter and less saturated than it was. These two lights reach only the
  // Lambert instanced meshes — trees, settlements, walkers — and at
  // 0x2c3d58 * 1.2 against a dark albedo every face pointing away from the sun
  // came out effectively black, so a forest read as green-and-black shards
  // rather than as lit geometry. The terrain does its own sky bounce and is
  // unaffected either way.
  const fill = new THREE.AmbientLight(0x54648c, 1.9);
  group.add(sun, fill);

  // Cloud shell (§7.3 tier 2). A scrolling noise sphere just above the terrain;
  // the terrain shader samples the same noise so the shadows are the clouds
  // rather than a second, unrelated pattern.
  const cloudMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSunDirection: view.sunDirection,
      uTime: view.cloudTime,
      uCloudFade: view.cloudFade,
      uCameraPosition: view.cameraPosition,
      uWarning: view.warning,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      varying vec3 vWorld;
      void main() {
        vDir = normalize(position);
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      varying vec3 vWorld;
      uniform vec3 uSunDirection;
      uniform float uTime;
      uniform float uCloudFade;
      uniform vec3 uCameraPosition;
      uniform float uWarning;
      ${CLOUD_NOISE_GLSL}
      ${SKY_GLSL}
      void main() {
        // Clouds dissolve as the camera comes in — the close working range is
        // "under the weather" (see view.ts, cloudFade). Shared with the ground
        // shadows so both vanish together.
        float cover = dioClouds(vDir, uTime) * uCloudFade;
        if (cover <= 0.001) discard;
        // The shell is larger than the planet, so a band of it projects *outside*
        // the planet's silhouette, against space — and clouds drawn there are grey
        // blobs floating off the horizon with no ground under them.
        //
        // The exact condition is whether this line of sight passes the planet at
        // all: the impact parameter is the altitude of its closest approach, and
        // above the surface there is nothing for a cloud to be in front of. This
        // replaces a dot(vDir, cameraDir) threshold that had to be retuned for
        // every camera distance and was wrong at the ends of the range either way.
        vec3 d = normalize(vWorld - uCameraPosition);
        float b = length(cross(uCameraPosition, d));
        float visible = 1.0 - smoothstep(0.985, 1.0, b);
        if (visible <= 0.001) discard;
        // Lit from the same direction as everything else, and dimmer on the
        // night side so clouds do not glow over a dark hemisphere.
        float lambert = max(dot(vDir, uSunDirection), 0.0);
        vec3 colour = mix(vec3(0.50, 0.54, 0.60), vec3(0.88, 0.90, 0.92), lambert);
        // Through the same air as the ground beneath them. A cloud bank towards
        // the limb that stayed crisp while the terrain around it drowned in haze
        // would read as a decal on the lens rather than as weather in the world.
        vec4 air = dioAerial(vWorld, uCameraPosition, uSunDirection, uWarning);
        colour = mix(colour, air.rgb, air.a);
        // Sparse: clouds frame the planet, they are not its surface.
        gl_FragColor = vec4(colour, cover * visible * 0.16);
      }
    `,
  });
  // Above the highest ground, not below it: at 1.03 radii the shell sat under
  // every peak taller than 375 height units, so mountains pushed through the
  // cloud layer and the shell's cut edge was visible against them. Shadow
  // alignment is unaffected — the terrain samples the noise by direction, not by
  // radius.
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(BASE_RADIUS * 1.065, 96, 64),
    cloudMaterial,
  );
  // Terrain 0, water 1, clouds 2, atmosphere 3.
  clouds.renderOrder = 2;
  group.add(clouds);

  // Space behind the planet. A pure black background makes the limb read as a
  // cut-out; a faint starfield gives the curvature something to be silhouetted
  // against. Procedural, like everything else (§7.5).
  group.add(makeStarfield(view));

  return {
    group,
    sunDirection,
    material,
    sync(tidePhase: number, ticksToImpact: number): void {
      // The sun's day cycle and the cloud clock live in `view.ts` now, because
      // three other materials need the same values and private copies drifted.

      // Warning ramps up over the last ten seconds before impact and stays hot
      // through the surge.
      let warning = 0;
      if (tidePhase === TIDE_TELEGRAPH) {
        warning = 1 - Math.min(ticksToImpact / 300, 1);
      } else if (tidePhase === TIDE_IMPACT) {
        warning = 1;
      }
      // Written here and read by every ground shader through `view`: the sky
      // reddens and thickens as one thing, because it is one thing.
      view.warning.value = warning;
      sun.position.copy(sunDirection).multiplyScalar(10);
      // The sun dims as the sky reddens, which is the other half of the tide's
      // no-UI warning.
      sun.intensity = 2.4 - warning * 0.9;
    },
  };
}

function makeStarfield(view: View): THREE.Points {
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
    uniforms: {
      uCameraPosition: view.cameraPosition,
      uWarning: view.warning,
    },
    vertexShader: /* glsl */ `
      attribute float size;
      varying float vSize;
      varying float vClear;
      uniform vec3 uCameraPosition;
      uniform float uWarning;
      ${SKY_GLSL}
      void main() {
        vSize = size;
        vec4 world = modelMatrix * vec4(position, 1.0);
        // Stars seen through the limb are seen through the whole tangent column
        // of air, and air that is bright enough to be a sky is opaque enough to
        // hide them. Without this the glow band has stars *in* it, which is the
        // one detail that gives away that the sky is a decal over space rather
        // than something between the eye and it.
        vec3 d = normalize(world.xyz - uCameraPosition);
        // Clamped to the ray, and this one matters: half the sky is in
        // directions pointing *away* from the planet, and for those the closest
        // approach of the infinite line lies behind the eye — down at the
        // planet's own altitude. Unclamped, every star overhead was dimmed by
        // the whole tangent column, which is the one part of the sky that has no
        // air in front of it at all. Where the closest approach is behind the
        // camera the nearest air on the ray is the camera's own altitude, which
        // is what t = 0 gives.
        float t = max(-dot(uCameraPosition, d), 0.0);
        float h = length(uCameraPosition + d * t) - 1.0;
        float tau = mix(DIO_HAZE, DIO_HAZE_WARNING, uWarning)
                  * dioColumn(0.0) * exp(-max(h, 0.0) / DIO_SKY_HEIGHT);
        vClear = exp(-tau);
        gl_PointSize = size * 12.0;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      varying float vSize;
      varying float vClear;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d) * vSize * 4.0 * vClear;
        gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -1;
  points.frustumCulled = false;
  return points;
}
