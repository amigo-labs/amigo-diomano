/**
 * The waterline, as one field evaluated on both sides of it.
 *
 * # Why this is a module and not two shaders
 *
 * Breakers are drawn by the sea (`water.ts`) and the swash they leave is drawn
 * by the sand (`planet.ts`), and they are the same water. Two private copies of
 * the phase would drift, and the symptom would be a white line arriving on a
 * beach that is already wet — subtle enough to read as a lighting bug rather
 * than as a copy-paste one. That is precisely the argument `CLOUD_NOISE_GLSL`
 * already makes for the cloud shadows, and `view.ts` for the sun.
 *
 * It cannot live in `water.ts`: `water.ts` imports `BASE_RADIUS` from
 * `planet.ts`, so `planet.ts` importing back would be a cycle.
 *
 * # The signed coordinate
 *
 * Everything below is a function of `below` — **height units below the current
 * sea level**. It is positive out at sea (where `water.ts` has a depth) and
 * negative up the beach (where `planet.ts` has an altitude). One continuous
 * coordinate across the waterline is what lets a set run up onto the sand and
 * back out again as a single expression, rather than two effects that have to be
 * tuned into agreement.
 *
 * One height unit is `HEIGHT_TO_RADIUS` (8e-5) radii; a terrace is 16 of them.
 */

export const SURF_GLSL = /* glsl */ `
  /**
   * Depth over which breakers can trip on the bottom. Three terraces.
   *
   * Deliberately shallow. The first cut used ten and the result was a white
   * blanket several cells wide around every island: on a gentle shelf a *depth*
   * band maps to a very wide *horizontal* band, and the coastline disappeared
   * under its own surf. Surf has to be a line at the water's edge, not a
   * bathymetric map painted in foam.
   */
  const float DIO_SURF_ZONE = 48.0;
  /** How far up the sand the wash reaches at its highest. Two thirds of a terrace. */
  const float DIO_SURF_RUNUP = 11.0;

  /**
   * Foam coverage, 0..1, at 'below' height units under the current sea level.
   *
   * 'jitter' is a noise sample the caller supplies (each shader already has a
   * noise field of its own, and this module deliberately depends on neither).
   * It bends the crest lines off the depth contours: without it a breaker is a
   * perfect iso-line of the height field, which reads as a contour map.
   *
   * 'surge' is the tide, 0 calm to 1 at the peak of a wave. It lengthens the
   * reach, speeds the sets up and whitens them — the flood arriving as weather
   * rather than as a rising number.
   */
  float dioSurf(float below, float time, float surge, float jitter) {
    float speed = 1.0 + surge * 1.4;
    // Where the wash currently stands. It breathes, so the wet line on the sand
    // moves up and down instead of sitting at a fixed altitude.
    float tideIn = 0.35 + 0.65 * (0.5 + 0.5 * sin(time * 0.55 + jitter * 2.0));
    float reach = DIO_SURF_RUNUP * tideIn * (0.7 + 0.8 * surge);
    if (below < -reach || below > DIO_SURF_ZONE * (1.0 + surge)) return 0.0;

    // Two sets at incommensurate periods, so the shore gets sets rather than a
    // metronome. Phase rises with depth and with time, which makes a crest of
    // constant phase travel into shallower water — shoreward, as it should. The
    // jitter is worth a fifth of a wavelength, which is enough to break the
    // contour without the line losing its direction.
    float p1 = below * 0.235 + time * 0.62 * speed + jitter * 1.3;
    float p2 = below * 0.147 + time * 0.41 * speed - jitter * 0.9;
    // Crests only. A breaker is a thin white line with dark water behind it,
    // not a sine wave of foam.
    float crest =
      pow(max(sin(p1), 0.0), 10.0) * 0.80 +
      pow(max(sin(p2), 0.0), 16.0) * 0.50;

    // Nothing breaks in deep water: a breaker needs a bottom to trip over.
    float shoal = 1.0 - smoothstep(0.0, DIO_SURF_ZONE * (1.0 + surge), max(below, 0.0));

    // The wash at the waterline is white whether anything is breaking or not,
    // and it is the part that crosses onto the sand. Kept under a terrace out:
    // any wider and the shelf loses the turquoise the Beer-Lambert term exists
    // to produce, and the coast reads milky instead of shallow.
    float seaward = 1.0 - smoothstep(0.0, 10.0, below);
    float landward = 1.0 - smoothstep(0.0, reach, -below);
    float wash = seaward * landward;

    return clamp(crest * shoal * (0.5 + surge * 0.5) + wash * (0.30 + surge * 0.45), 0.0, 1.0);
  }
`;
