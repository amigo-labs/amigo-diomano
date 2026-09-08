/**
 * The planet's scale: how a simulation height becomes a world radius.
 *
 * # Why two numbers get their own module
 *
 * They are the most widely shared values in the client — the camera, the hand,
 * the sea, the sky, the plants and the effects all need them — and they used to
 * live in `planet.ts`, which is also where the terrain shader is assembled.
 * That made a module that everything depends on depend on `atmosphere.ts` in
 * turn, for the GLSL it splices into that shader, and `atmosphere.ts` needed
 * `BASE_RADIUS` to size the sky shell. A cycle.
 *
 * A cycle between ES modules compiles, lints and usually runs: it just lets the
 * bundler choose which module evaluates first. Rollup chose `atmosphere.ts` for
 * weeks, so `planet.ts`'s `${CLOUD_NOISE_GLSL}` — read at module scope — found
 * its string. Then a commit about ground textures changed the graph, the choice
 * flipped, and the shipped client died on load with `Cannot access 'ba' before
 * initialization`. `tools/verify-cycles.mjs` is the guard that keeps that from
 * being rediscovered.
 *
 * So this module imports nothing, which is the entire point: it can be pulled
 * in from anywhere without teaching that module about the terrain, and it is
 * the answer to "where does a constant go" for anything else the whole
 * renderer agrees on. `surf.ts` exists for the same reason, one layer up — a
 * shared *field* rather than a shared number.
 */

/** Planet radius at height 0. Mirrors `mesh::BASE_RADIUS`. */
export const BASE_RADIUS = 1.0;
/** Radius change per height unit. Mirrors `mesh::HEIGHT_TO_RADIUS`. */
export const HEIGHT_TO_RADIUS = 0.00008;
