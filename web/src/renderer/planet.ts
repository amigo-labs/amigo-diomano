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
import { CLOUD_NOISE_GLSL, SKY_GLSL } from "./atmosphere";
import { SURF_GLSL } from "./surf";
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
  attribute vec4 attrib3;  // rock, sand, soil, ash weights (swamp = 1 - sum)

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vAttrib;
  varying vec4 vAttrib2;
  varying vec4 vAttrib3;
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
    vAttrib3 = attrib3;
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
  varying vec4 vAttrib3;
  varying float vAltitude;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;
  uniform vec3 uGodA;
  uniform vec3 uGodB;
  uniform float uCloudTime;
  uniform float uCloudFade;
  uniform float uTier;
  uniform float uWarning;
  uniform float uTime;
  uniform float uSurge;

  // CC0 surface textures (docs/ASSETS.md). uTexMix is 0 until every map has
  // arrived, so the purely procedural shading below is the fallback, not a
  // black flash — the front door covers the load in practice.
  uniform sampler2D uTexRock;
  uniform sampler2D uTexGrass;
  uniform sampler2D uTexSand;
  uniform sampler2D uTexDirt;
  uniform sampler2D uTexSnow;
  uniform float uTexMix;

  ${CLOUD_NOISE_GLSL}
  ${SKY_GLSL}
  ${SURF_GLSL}

  // Triplanar sample: the quadsphere has no UV atlas (slope/height texturing
  // exists precisely to avoid one), so textures are projected along the three
  // world axes and blended by the geometric normal. The sharp weight power
  // keeps the blend zones narrow enough that the projections never read as
  // ghosting.
  vec3 dioTriplanar(sampler2D t, vec3 p, vec3 nrm, float scale) {
    vec3 w = abs(nrm);
    w = w * w;
    w = w * w;
    w /= (w.x + w.y + w.z);
    return texture2D(t, p.yz * scale).rgb * w.x
         + texture2D(t, p.xz * scale).rgb * w.y
         + texture2D(t, p.xy * scale).rgb * w.z;
  }

  /*
    A surface map, as *structure* rather than as brightness.

    This is the fix for the black ring that had been sitting around every spawn
    pedestal since the textures landed, and it was never a NaN: the five maps
    have wildly different mean brightness — measured over the shipped files,
    rock is 0.092 where sand is 0.551, grass 0.556, dirt 0.409 and snow 0.924 —
    and the shader multiplied the authored palette by the raw sample times a
    single constant tuned for the bright ones. Rock therefore came out at about
    a fifth of the colour §7.3 specifies, and where a fragment was *pure* rock
    with nothing to blend against, a fifth of a dark palette entry rounded to
    black. Every rock surface on the planet was affected; the pedestal shelf was
    just the only place with no other material to hide it.

    So each map is divided by its own mean first, which leaves a field centred
    on 1.0, and then pulled back toward 1.0 so it modulates the palette instead
    of competing with it. The clamp bounds what a very dark map's brightest
    speck can do once it has been scaled up by ten.
  */
  const float DIO_TEX_CONTRAST = 0.62;

  /**
    A surface map at two scales: the material, and its grain.

    A 512-pixel map projected over a whole planet has one texel to a couple of
    metres of ground, so up close it is a smooth wash and the only structure
    left is the procedural noise. Sampling the *same* map again seven times
    finer and folding it in as the camera approaches costs one extra fetch on
    the close half of the zoom range and nothing at all on the far half, where
    the branch is not taken — no new asset, no payload, no second set of means
    to keep in step.

    Both layers are normalised before they meet, so the fine one modulates the
    coarse one around 1.0 rather than multiplying two absolute brightnesses
    together and squaring the contrast.
  */
  const float DIO_DETAIL_SCALE = 7.0;
  vec3 dioSurfaceMap(sampler2D t, vec3 p, vec3 nrm, float scale, float invMean, float detail) {
    vec3 coarse = clamp(dioTriplanar(t, p, nrm, scale) * invMean, 0.22, 2.4);
    if (detail > 0.004) {
      vec3 fine = clamp(dioTriplanar(t, p, nrm, scale * DIO_DETAIL_SCALE) * invMean, 0.35, 1.9);
      coarse *= mix(vec3(1.0), fine, detail * 0.7);
    }
    return mix(vec3(1.0), coarse, DIO_TEX_CONTRAST);
  }

  // The five materials of world.rs: rock, sand, soil, ash, swamp.
  // Saturated earth. Pale greys sit at the same value as the sea after ACES.
  const vec3 MAT_ROCK = vec3(0.42, 0.36, 0.28);
  const vec3 MAT_SAND = vec3(0.68, 0.54, 0.30);
  const vec3 MAT_SOIL = vec3(0.32, 0.44, 0.14);
  const vec3 MAT_ASH = vec3(0.22, 0.20, 0.18);
  const vec3 MAT_SWAMP = vec3(0.16, 0.30, 0.14);

  // How far a weight is pushed around before the boundary is decided, and how
  // hard the decision then is. 0.42 / 3.0: enough spread that the winner in an
  // overlap is genuinely the noise's choice, sharp enough that the transition
  // is a fringe of a cell rather than a fade across one.
  const float SPLAT_SPREAD = 0.42;
  const float SPLAT_SHARP = 3.0;

  /*
    The material mixture at this fragment, as five weights.

    attrib3 carries how much of the four cells behind each vertex is rock, sand,
    soil and ash; swamp is the remainder. Interpolated across a quad those are a
    real mixture, which is why they can be blended at all — the code this
    replaced interpolated a material *id* and thresholded it, so every rock/soil
    boundary on the planet grew a one-cell sand stripe with two hard,
    cell-aligned edges. See docs/specs/rendering.md.

    A plain weighted sum is correct and still wrong to look at: it fades linearly
    over exactly one cell, which reads as an airbrushed grid instead of as
    ground. So each weight is offset by its own band of the same 3D noise
    everything else here uses and then raised to a power. The boundary becomes an
    interlocking edge that follows the noise field rather than the cell grid,
    which is the whole point — the grid was the complaint.
  */
  void dioMaterialSplat(vec4 raw, vec3 up, out vec4 w4, out float swamp) {
    float sw = max(1.0 - (raw.x + raw.y + raw.z + raw.w), 0.0);
    // One offset per material, so no two boundaries break up in the same place.
    // 46 is a little over a cell at N = 64: fine enough to read as material,
    // coarse enough that a texel still covers less than a noise cell.
    float nr = dioNoise(up * 46.0);
    float ns = dioNoise(up * 46.0 + vec3(31.7, 11.3, 57.1));
    float no = dioNoise(up * 46.0 + vec3(-19.4, 63.2, 27.9));
    float na = dioNoise(up * 46.0 + vec3(48.6, -37.1, 9.5));
    float nw = dioNoise(up * 46.0 + vec3(7.2, 24.8, -51.3));
    float r = pow(max(raw.x + (nr - 0.5) * SPLAT_SPREAD, 0.0), SPLAT_SHARP);
    float s = pow(max(raw.y + (ns - 0.5) * SPLAT_SPREAD, 0.0), SPLAT_SHARP);
    float o = pow(max(raw.z + (no - 0.5) * SPLAT_SPREAD, 0.0), SPLAT_SHARP);
    float a = pow(max(raw.w + (na - 0.5) * SPLAT_SPREAD, 0.0), SPLAT_SHARP);
    float m = pow(max(sw + (nw - 0.5) * SPLAT_SPREAD, 0.0), SPLAT_SHARP);
    float total = r + s + o + a + m;
    // Every weight pushed below zero at once leaves nothing to blend. Fall back
    // to the unsharpened mixture: a fragment with no material would come out
    // black, and black holes in the ground are a worse artefact than a soft edge.
    if (total < 1e-5) {
      w4 = raw;
      swamp = sw;
      return;
    }
    w4 = vec4(r, s, o, a) / total;
    swamp = m / total;
  }

  void main() {
    vec3 up = normalize(vWorld);
    vec3 n = normalize(vNormal);
    // Slope- and height-based texturing (§7.3): steep reads as rock, flat as
    // grass, high as snow. Avoids UV-mapping a quadsphere entirely.
    float slope = 1.0 - clamp(dot(n, up), 0.0, 1.0);

    // How close the eye is, 0 at orbit and 1 under the hand. Computed here
    // rather than beside the noise octaves that used to be its only reader:
    // the surface maps want it too, and sampling a texture needs to know how
    // close the camera is *before* the sample, not after.
    float eyeDist = distance(uCameraPosition, vWorld);
    float detail = 1.0 - smoothstep(0.45, 1.30, eyeDist);

    vec4 matW;
    float matSwamp;
    dioMaterialSplat(vAttrib3, up, matW, matSwamp);
    vec3 albedo = MAT_ROCK * matW.x + MAT_SAND * matW.y + MAT_SOIL * matW.z
                + MAT_ASH * matW.w + MAT_SWAMP * matSwamp;

    // Texture structure, keyed by the same material id and applied as a
    // modulation of the palette rather than a replacement for it — the colour
    // script (saturated earth, §7.3's ACES note) stays authored, the textures
    // supply what noise octaves cannot: photographic micro-structure. Sampled
    // against the geometric normal, before the bump perturbs it.
    // Neutral until the maps arrive: dioSurfaceMap returns a modulation around
    // 1.0, so "no texture yet" is exactly 1.0 and the authored palette stands
    // on its own. These used to be mid greys because the samples were absolute
    // brightness rather than a modulation.
    vec3 tRock = vec3(1.0);
    vec3 tSand = vec3(1.0);
    vec3 tGrass = vec3(1.0);
    vec3 tSnow = vec3(1.0);
    if (uTexMix > 0.001) {
      // The reciprocal of each map's own mean colour, measured over the files
      // in web/public/tex and recorded in docs/ASSETS.md. See dioSurfaceMap.
      tRock = dioSurfaceMap(uTexRock, vWorld, n, 16.0, 10.90, detail);
      tSand = dioSurfaceMap(uTexSand, vWorld, n, 26.0, 1.81, detail);
      tGrass = dioSurfaceMap(uTexGrass, vWorld, n, 22.0, 1.80, detail);
      tSnow = dioSurfaceMap(uTexSnow, vWorld, n, 18.0, 1.08, detail);
      vec3 tDirt = dioSurfaceMap(uTexDirt, vWorld, n, 20.0, 2.44, detail);
      // The same weights as the palette, so structure and colour never disagree
      // about which material a fragment is. Soil, ash and swamp all take the
      // dirt map, as they did when this was a step chain on the material id.
      vec3 t = tRock * matW.x + tSand * matW.y + tDirt * (matW.z + matW.w + matSwamp);
      albedo *= mix(vec3(1.0), t, uTexMix);
    }

    // Multi-octave ground grain, and a bump from the same field so the
    // Laplacian-smooth mesh still lights as hills rather than as a fill.
    float n1 = dioNoise(up * 14.0);
    float n2 = dioNoise(up * 36.0);
    float n3 = dioNoise(up * 90.0);
    float grain = n1 * 0.50 + n2 * 0.32 + n3 * 0.18;

    // The finest octave above is ~3 cells wide, so up close the ground was a
    // smooth fill — most of what read as plastic. Two micro octaves fade in
    // with proximity (and only cost anything when the branch is taken); the
    // fade keeps them from shimmering at orbit distance, where a texel would
    // cover many noise cells.
    float mid = dioNoise(up * 230.0);
    float mc = 0.5;
    float micro = 0.5;
    if (detail > 0.001) {
      mc = dioNoise(up * 620.0);
      micro = mc * 0.6 + dioNoise(up * 1500.0) * 0.4;
    }

    albedo *= 0.82 + grain * 0.34 + (mid - 0.5) * 0.16;
    albedo *= 1.0 + (micro - 0.5) * 0.34 * detail;
    // Large-scale warm/cool drift, so no two regions of a continent are quite
    // the same colour — uniform albedo over a smooth mesh is the other half of
    // the plastic look.
    float province = dioNoise(up * 4.5);
    albedo *= mix(vec3(0.95, 0.98, 1.04), vec3(1.06, 1.01, 0.95), province);
    // Reference axis picked per branch so the tangent frame never degenerates:
    // built from a fixed world-Y reference it collapsed at the poles into a
    // visible whorl. The switch happens at ~82 degrees latitude, where both
    // frames are still well-conditioned. Not derivatives (dFdx frames vary the
    // bump strength with zoom).
    vec3 axis = abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(up, axis));
    vec3 bitangent = cross(up, tangent);
    float gx = dioNoise(normalize(up + tangent * 0.010) * 14.0);
    float gy = dioNoise(normalize(up + bitangent * 0.010) * 14.0);
    // 3.5 is a bump height of 0.035 over the 0.010 sample step — the bare 5.5
    // before was an unnormalised finite difference, strong enough to invent
    // relief the geometry does not have. And the bump stays out of slope:
    // it re-lights the grain, it does not repaint the rock, grass and snow
    // masks below, which key on the geometric slope alone.
    vec3 bumped = n + tangent * (n1 - gx) * 3.5 + bitangent * (n1 - gy) * 3.5;
    // Micro relief where the micro albedo already is: ground up close lights
    // as granular material, not as a painted smooth surface.
    if (detail > 0.001) {
      float mx = dioNoise(normalize(up + tangent * 0.0018) * 620.0);
      float my = dioNoise(normalize(up + bitangent * 0.0018) * 620.0);
      bumped += (tangent * (mc - mx) + bitangent * (mc - my)) * 1.8 * detail;
    }
    n = normalize(bumped);

    // Fertility is potential; vegetation is what grew. Generation writes the
    // first and leaves the second at 0, so meadow has to come from fertility
    // or land is bare until trees appear.
    float fert = vAttrib2.g;
    float veg = vAttrib.g;
    float above = 1.0 - smoothstep(-0.001, 0.002, -vAltitude);
    // Sand at the waterline, not darkened grass — otherwise every island is
    // a green sticker in a blue fill. Migrates with sea level (§7.3).
    float beach = above * (1.0 - smoothstep(0.0004, 0.0075, vAltitude));
    float grassMask = fert * above * (1.0 - beach) * (1.0 - smoothstep(0.16, 0.58, slope));
    vec3 meadow = vec3(0.28, 0.52, 0.14);
    vec3 dryGrass = vec3(0.42, 0.46, 0.16);
    vec3 canopy = vec3(0.11, 0.36, 0.09);
    // Meadow comes in patches, not as a uniform tint keyed on fertility alone:
    // real grassland is mottled where the ground holds water, and the mottling
    // is what stops a green area reading as a decal.
    float meadowPatch = smoothstep(0.30, 0.70, dioNoise(up * 52.0) * 0.65 + fert * 0.35);
    // Grass keeps its authored hue and takes only the texture's *luminance*
    // as structure: green photo times green palette oversaturates. The gain is
    // gone with the rest of them — dioSurfaceMap already centres the map on
    // 1.0, so a second brightening here would double-count it.
    float gLum = dot(tGrass, vec3(0.299, 0.587, 0.114));
    vec3 grassCol = mix(dryGrass, meadow, meadowPatch) * mix(1.0, gLum, uTexMix);
    albedo = mix(albedo, grassCol, grassMask * 0.90);
    albedo = mix(albedo, canopy, veg * above * (1.0 - beach) * 0.95);
    albedo = mix(albedo, vec3(0.48, 0.40, 0.24), vAttrib2.b * 0.30);
    // Steep ground reads as bedded rock: the strata sample moves with altitude
    // so the banding follows the contour lines, broken up laterally by the
    // same noise everything else uses. One flat rock colour was a third of
    // the plastic look on every cliff.
    float strata = dioNoise(up * 30.0 + vAltitude * vec3(120.0, 300.0, 190.0));
    float rockBand = smoothstep(0.28, 0.68, slope);
    vec3 cliff = mix(vec3(0.30, 0.25, 0.20), vec3(0.47, 0.41, 0.33), strata);
    cliff *= mix(vec3(1.0), tRock * 2.1, uTexMix);
    albedo = mix(albedo, cliff, rockBand);

    // Snowline inside the altitude the terrain can reach (amp 720 → 0.0576 R).
    // Snow is not one white: hollows go cold blue-grey, exposed crust goes
    // bright, and the micro grain gives it sparkle-scale structure up close.
    float snow = smoothstep(0.032, 0.050, vAltitude) * (1.0 - smoothstep(0.2, 0.5, slope));
    vec3 snowCol =
      mix(vec3(0.62, 0.70, 0.84), vec3(0.93, 0.95, 0.98), clamp(0.25 + grain * 0.7 + (micro - 0.5) * 0.5 * detail, 0.0, 1.0));
    snowCol *= mix(1.0, dot(tSnow, vec3(0.299, 0.587, 0.114)), uTexMix);
    albedo = mix(albedo, snowCol, snow);

    vec3 beachSand = vec3(0.78, 0.64, 0.38);
    vec3 wetSand = vec3(0.52, 0.40, 0.24);
    vec3 beachCol = mix(beachSand, wetSand, 1.0 - smoothstep(0.0, 0.003, vAltitude));
    beachCol *= mix(1.0, dot(tSand, vec3(0.299, 0.587, 0.114)), uTexMix);
    albedo = mix(albedo, beachCol, beach);

    // The landward half of the surf. dioSurf is the *same* function the water
    // shader evaluates on the seaward side, over the same signed coordinate —
    // height units below the current sea level — so a set that breaks offshore
    // is the one that runs up this sand. Two private phases would have put a
    // white line on a beach that was already wet, which reads as a lighting bug
    // rather than as the copy-paste it would be. See surf.ts.
    //
    // vAltitude is in radii; HEIGHT_TO_RADIUS is 8e-5, so 12500 converts back.
    float swash = dioSurf(-vAltitude * 12500.0, uTime, uSurge, dioNoise(up * 240.0) * 2.0 - 1.0);
    swash *= beach;
    // Wet sand first — the water arrives before the foam does — then the foam
    // edge on top of it.
    albedo = mix(albedo, wetSand * 0.86, swash * 0.65);
    albedo = mix(albedo, vec3(0.90, 0.94, 0.96), smoothstep(0.45, 0.95, swash) * 0.75);

    // Standing water darkens the ground it sits on. Not a cyan wash.
    albedo *= 1.0 - clamp(vAttrib.a * 4.0, 0.0, 1.0) * 0.35;

    // Territory tint, not a bleach — a heavy mood mix is the same colour as haze.
    float influence = vAttrib.b * 2.0 - 1.0;
    vec3 mood = mix(uGodB, uGodA, clamp(influence * 0.5 + 0.5, 0.0, 1.0));
    albedo = mix(albedo, albedo * mood, min(abs(influence) * 0.55, 0.16));

    // Ocean floor: dark, so the sea is a body rather than a window — but only
    // where there is actually water over this ground.
    //
    // The altitude mask is the gate. Depth is the dual-grid *mean* of four
    // cells, so where dry ground meets deep water — the rim of a spawn pedestal,
    // or any steep coast — a corner three hundred units above the waterline
    // still reports a depth around fifty, and both the absorption and the
    // abyssal colour were being applied to it: dry rock painted as sea bed.
    //
    // Slope was tried as the gate first and does not work: the Laplacian spreads
    // a 312-unit step over two cells, which is a 26-degree face, nowhere near
    // the threshold that separates cliff from ground. Altitude is the honest
    // test anyway — whether this ground is under water is a question about its
    // height, not about its steepness.
    //
    // This is *not* the cause of the black ring around a spawn pedestal, which
    // was the reason it was investigated. That ring is a separate and older
    // defect: the terrain geometry is present there (confirmed in wireframe) and
    // the fragment output is exactly (0, 0, 0) for inputs that are dry, flat,
    // pure rock 300 units above sea level — the same pixels, exactly black, on
    // main. Something here produces a NaN or a hard zero for that case and this
    // gate does not touch it. Left as a known defect rather than a guess.
    float depth = vAttrib.a * 255.0 * 8.0;
    float submerged = 1.0 - above;
    albedo *= mix(1.0, exp(-depth * 0.0045), submerged);
    albedo = mix(albedo, vec3(0.04, 0.06, 0.05), smoothstep(12.0, 90.0, depth) * submerged);

    float lambert = max(dot(n, uSunDirection), 0.0);
    // Cloud shadows, from the same noise the cloud shell draws (§7.3 tier 2),
    // fading out with the shell as the camera comes in (view.ts, cloudFade) —
    // a shadow whose cloud has dissolved would crawl over the ground alone.
    if (uTier > 1.5) {
      lambert *= 1.0 - dioClouds(up, uCloudTime) * 0.28 * uCloudFade;
    }
    vec3 viewDir = normalize(uCameraPosition - vWorld);
    // Soft camera-anchored fill so the night side stays readable (§7.2). Small:
    // it is there to keep the dark side legible, not to light the scene — and
    // kept below where it was, because a view-anchored term over matte ground
    // is precisely the sheen of plastic. The sky bounce picks up the slack.
    float fill = max(dot(n, viewDir), 0.0) * 0.13;
    float sky = clamp(dot(n, up) * 0.5 + 0.5, 0.0, 1.0) * 0.17;

    vec3 lit = albedo * (lambert * vec3(1.16, 1.08, 0.86) + fill + sky * vec3(0.34, 0.46, 0.32));

    // Specular only where the material earns it — snow crust and the wet band
    // at the waterline. Land is otherwise matte; a uniform highlight on soil
    // and grass is the other precise signature of plastic, which is why there
    // is deliberately none.
    float wet = beach * (1.0 - smoothstep(0.0, 0.003, vAltitude));
    // The gloss follows the water up the beach rather than sitting at a fixed
    // altitude: a wet band that never moves is the tell that it is painted on.
    float glossMask = snow * 0.30 + max(wet, swash) * 0.35;
    if (glossMask > 0.001) {
      vec3 h = normalize(uSunDirection + viewDir);
      float spec = pow(max(dot(n, h), 0.0), 56.0) * lambert;
      lit += spec * glossMask * vec3(1.10, 1.06, 0.98);
    }

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

    // The air between here and the eye (atmosphere.ts, SKY_GLSL). This is what
    // replaced the rim light that used to sit above: both exist to separate the
    // limb from space, but a rim term keyed on the surface normal brightens
    // every steep slope in the frame — including the pit the player is digging
    // right under the camera — whereas the haze brightens only ground the view
    // ray reaches through a lot of air, which is the limb and nothing else.
    //
    // Applied last, over the lava too: a distant flow seen through the whole
    // horizon column *is* dimmer and bluer than one at the player's feet, and
    // that is most of what tells the eye which one is far away.
    vec4 air = dioAerial(vWorld, uCameraPosition, uSunDirection, uWarning);
    // Limb-gated, and the gate is the whole invariant: overhead a full Chapman
    // mix is sky-coloured, so the working ground would disappear into the same
    // blue as the horizon. With the 32-degree tilt the ground under the cursor
    // sits at dot(up, viewDir) >= 0.70 even at the closest approach, so an
    // upper edge of 0.62 keeps the working area at exactly zero haze by
    // construction — which is what frees the gain at the limb to be a real
    // drown-into-air gradient (~0.6 at the tangent) instead of the 0.18 cap
    // that left the ground running crisp to the edge and the planet reading
    // as a disc.
    float limb = 1.0 - smoothstep(0.12, 0.62, max(dot(up, viewDir), 0.0));
    lit = mix(lit, air.rgb, air.a * limb * 0.75);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

export function createPlanet(sim: Sim, view: View): Planet {
  const group = new THREE.Group();

  // CC0 surface textures (docs/ASSETS.md), loaded behind the title card. The
  // shader multiplies them over the authored palette only once uTexMix flips
  // to 1, so a slow connection sees the procedural shading, never black — a
  // half-loaded set would tile some materials and not others, which is why
  // the flip waits for all five.
  const texMix = { value: 0 };
  const loader = new THREE.TextureLoader();
  let texPending = 5;
  const loadTex = (file: string): THREE.Texture => {
    const t = loader.load(
      `tex/${file}`,
      () => {
        texPending -= 1;
        if (texPending === 0) texMix.value = 1;
      },
      undefined,
      () => {
        // Staying at uTexMix = 0 is the correct outcome — an unloaded texture
        // samples black, so flipping with one map missing would paint that
        // material black — but it must not be a *silent* outcome, or a 404
        // here is undebuggable in the field.
        console.warn(`planet: texture tex/${file} failed to load; staying on procedural shading`);
      },
    );
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      // Shared by reference with every other material — see `view.ts` for why
      // these three are not allowed to be private copies.
      uSunDirection: view.sunDirection,
      uCameraPosition: view.cameraPosition,
      uCloudTime: view.cloudTime,
      uTime: view.time,
      uSurge: view.surge,
      uCloudFade: view.cloudFade,
      uWarning: view.warning,
      uSeaRadius: { value: BASE_RADIUS },
      uGodA: { value: new THREE.Color(1.06, 0.93, 0.82) },
      uGodB: { value: new THREE.Color(0.82, 0.9, 1.1) },
      uTier: { value: 2 },
      uTexRock: { value: loadTex("rock.webp") },
      uTexGrass: { value: loadTex("grass.webp") },
      uTexSand: { value: loadTex("sand.webp") },
      uTexDirt: { value: loadTex("dirt.webp") },
      uTexSnow: { value: loadTex("snow.webp") },
      uTexMix: texMix,
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
  const attrib3 = new THREE.BufferAttribute(sim.meshAttribs3, 4, true);
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  attrib.setUsage(THREE.DynamicDrawUsage);
  attrib2.setUsage(THREE.DynamicDrawUsage);
  attrib3.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute("position", position);
  geometry.setAttribute("normal", normal);
  geometry.setAttribute("attrib", attrib);
  geometry.setAttribute("attrib2", attrib2);
  geometry.setAttribute("attrib3", attrib3);
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
      attrib3.clearUpdateRanges();
      let dirty = 0;
      for (let chunk = 0; chunk < sim.chunks; chunk++) {
        if (sim.meshDirty[chunk] === 0) continue;
        dirty += 1;
        const start = chunk * sim.vertsPerChunk;
        position.addUpdateRange(start * 3, sim.vertsPerChunk * 3);
        normal.addUpdateRange(start * 3, sim.vertsPerChunk * 3);
        attrib.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
        attrib2.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
        attrib3.addUpdateRange(start * 4, sim.vertsPerChunk * 4);
      }
      if (dirty > 0) {
        position.needsUpdate = true;
        normal.needsUpdate = true;
        attrib.needsUpdate = true;
        attrib2.needsUpdate = true;
        attrib3.needsUpdate = true;
      }
      material.uniforms.uSeaRadius!.value = BASE_RADIUS + seaLevel * HEIGHT_TO_RADIUS;
    },

    refreshAll(): void {
      for (const a of [position, normal, attrib, attrib2, attrib3]) {
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
