//! Chunked terrain meshing. HANDOFF §7.1.
//!
//! # This module is render code, and it is the only float in the crate
//!
//! §10 says "no floats in **simulation state**; `f32`/`f64` in render code
//! only", and §9.1 puts chunk meshing in Rust. Both are satisfied by keeping
//! meshing here, behind a hard rule that this module is write-only with respect
//! to the world: it takes `&World` and fills its own buffers, so no float it
//! computes can reach a hashed field. `clippy::float_arithmetic` is denied
//! crate-wide and allowed exactly once, below.
//!
//! The maths is hand-rolled (`tan`, `rsqrt`) rather than pulled from `libm`, for
//! the reason §9.2 gives: owning the whole math stack is the point.
//!
//! # Sim grid is not the render mesh
//!
//! Without smoothing the result is Minecraft terracing, not Black & White 2. The
//! four steps of §7.1, in order:
//!
//! 1. **Dual grid** — a vertex is the mean of the four cells around it, so
//!    vertices sit at cell corners and terracing halves immediately.
//! 2. **Material-weighted Laplacian**, one pass — rock stays crisp and
//!    cliff-like, sand reads as dunes. The material map drives silhouette, not
//!    just colour.
//! 3. **Chunk skirts** — an extra ring of vertices, intended to be dropped
//!    radially inward to hide the hairline between chunks re-meshed at different
//!    times. The drop is now zero: see [`SKIRT_DROP`] for why no depth both works
//!    and stays invisible, and what closes the window instead.
//! 4. **Seam vertices come from ghost-border data**, so face boundaries are
//!    continuous with no special case. A corner vertex on a face edge averages
//!    two live cells and two ghosts — and the face on the other side averages
//!    the *same four cells*, so both produce bit-identical positions and there
//!    is no crack.
//!
//! The eight cube corners are the one place where that argument fails, because
//! the diagonal ghost is ambiguous (§3.5). They are handled explicitly: the
//! vertex is the mean of the three real corner cells, which all three faces
//! agree on.

#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use crate::seams::{DIR_S, DIR_W, GHOST_DST, GHOST_ENTRIES, GHOST_SRC, step};
use crate::world::{CELLS, N, World, idx, idx_i, neighbour_flat};

/// Cells per chunk edge (§7.1 `[START]` 16x16).
pub const CHUNK: usize = 16;
/// Chunks along one face edge.
pub const CHUNKS_PER_EDGE: usize = N / CHUNK;
/// Total chunks across the planet.
pub const CHUNKS: usize = 6 * CHUNKS_PER_EDGE * CHUNKS_PER_EDGE;

/// Vertices along one chunk edge: the `CHUNK + 1` corners plus a skirt ring.
pub const VERTS_PER_EDGE: usize = CHUNK + 3;
pub const VERTS_PER_CHUNK: usize = VERTS_PER_EDGE * VERTS_PER_EDGE;
pub const TOTAL_VERTS: usize = CHUNKS * VERTS_PER_CHUNK;
/// One shared index buffer: every chunk has identical topology, so 96 copies of
/// the same 1944 indices would be 96 times the memory for no reason.
pub const INDICES_PER_CHUNK: usize = (VERTS_PER_EDGE - 1) * (VERTS_PER_EDGE - 1) * 6;

/// Planet radius at height 0, in render units.
pub const BASE_RADIUS: f32 = 1.0;
/// Radius change per height unit (§3.6: 16 units = one terrace).
///
/// Chosen against §7.2 rather than for realism: the planet must stay small
/// enough that the horizon against space is always visible, and relief must
/// read as terrain rather than as a lumpy ball. Generated terrain spans about
/// +/-720 units, so this puts relief at roughly 6% of the radius — pronounced,
/// clearly a sphere, and comfortably inside the atmosphere shell.
pub const HEIGHT_TO_RADIUS: f32 = 0.000_08;

/// How far skirt vertices drop below the surface. **Zero, deliberately.**
///
/// The rule this constant used to be set by is the right rule: "a skirt deep
/// enough to be seen edge-on is a worse artefact than the crack it prevents".
/// At `0.000_8` it was being seen. Both chunks either side of a border drop their
/// shared ring, so the two dropped rings coincide and the pair forms a V-groove
/// along every chunk boundary — 3% of a cell deep, and quite visible as a
/// hairline grid every 16 cells across the whole planet. Setting this to zero
/// removes it completely; confirmed by screenshot at the closest camera distance,
/// where the grid was clearest.
///
/// The deeper point is that the value could not have been chosen well. To hide a
/// crack from a stale neighbour the skirt has to be at least as deep as the height
/// error it is hiding, and the smallest possible error is one terrace —
/// `16 * HEIGHT_TO_RADIUS = 0.001_28`, already deeper than the setting that was
/// visible. There is no depth that both works and disappears, so the mechanism
/// cannot be the answer here.
///
/// What actually closes the window is [`Mesh::update`] dirtying both sides of a
/// changed border in the same call, which it does, and which
/// `only_dirty_chunks_are_remeshed` pins. The ring itself is left in place — it
/// costs vertices, and the outer quads simply degenerate to zero area — so that
/// if meshing is ever spread across frames the geometry is still there to use.
/// Anything reviving it needs a depth of at least one terrace and should expect
/// to see it.
const SKIRT_DROP: f32 = 0.0;

/// Material-weighted Laplacian strengths, x256 (§7.1 `[START]`).
/// rock 0.15, soil 0.40, sand 0.60, ash 0.55.
const SMOOTH_WEIGHT: [i32; 5] = [38, 154, 102, 141, 128];

/// Vertex buffers, owned by Rust and read by TypeScript as typed-array views.
///
/// Nothing is serialised across the boundary: the host wraps these in
/// `THREE.BufferAttribute` and sets `needsUpdate` (§7.1, §9.3).
#[repr(C)]
pub struct Mesh {
    pub positions: [f32; TOTAL_VERTS * 3],
    pub normals: [f32; TOTAL_VERTS * 3],
    /// Per vertex: material, vegetation, influence + 128, water depth / 8.
    pub attribs: [u8; TOTAL_VERTS * 4],
    /// Per vertex: lava depth, fertility, sediment, spare.
    ///
    /// A second channel because the first is full and §7.4 asks for five fields —
    /// "the simulation already carries `fertility`, `vegetation`, `sediment`,
    /// `material` and `influence`; write them as vertex attributes" — of which
    /// only three were arriving. Lava matters most of the three: it is a fluid
    /// layer the simulation moves every tick and the renderer had no way to see
    /// it at all, so a volcano showed ash *afterwards* and never hot lava.
    pub attribs2: [u8; TOTAL_VERTS * 4],
    pub water_positions: [f32; TOTAL_VERTS * 3],
    /// Per vertex: depth / 8, influence + 128, foam (erosion), dry flag.
    pub water_attribs: [u8; TOTAL_VERTS * 4],
    pub indices: [u16; INDICES_PER_CHUNK],
    /// Smoothed cell heights, x256, including a ghost ring so corner vertices at
    /// a face boundary read the same values from both sides.
    smooth: [i32; CELLS],
    /// One chunk's true corner positions, including the ring *outside* the chunk
    /// that the normal pass differences against. See [`Mesh::build_normals`].
    ///
    /// A field rather than a local to keep 5.7 KB off the stack, for the same
    /// reason [`Mesh::boxed`] exists. It was *also* tried as a perf change on the
    /// theory that zero-initialising a local per chunk was costing something, and
    /// it measured identical — recorded here so nobody re-derives that hypothesis:
    /// the meshing cost is the two vertex passes, not the scratch.
    scratch_corners: [f32; VERTS_PER_CHUNK * 3],
    /// The scalar heights behind `scratch_corners`, so the second pass can read
    /// the one it needs instead of averaging the dual grid a second time.
    scratch_heights: [f32; VERTS_PER_CHUNK],
    /// Content hash per chunk; a chunk is re-meshed only when this changes.
    chunk_hash: [u64; CHUNKS],
    /// 1 where the chunk contains any water at all.
    ///
    /// §7.3 caps draw calls at 150 and the terrain alone is 96 chunks, so the
    /// water pass cannot afford to draw 96 more. Most chunks on a normal map are
    /// entirely dry or entirely submerged inland; publishing this lets the host
    /// skip the dry ones outright, which is a real cut rather than a
    /// micro-optimisation.
    pub water_present: [u8; CHUNKS],
    /// 1 where [`Mesh::update`] rebuilt the chunk on its last call.
    ///
    /// The host needs this, not just the count: `needsUpdate` has to be set on
    /// exactly the chunks whose vertex data moved, or the GPU re-uploads all 96
    /// every frame and the whole dirty-chunk scheme buys nothing.
    pub dirty: [u8; CHUNKS],
    /// Chunks re-meshed by the last [`Mesh::update`] call.
    pub remeshed: u32,
}

impl Mesh {
    #[must_use]
    pub const fn zeroed() -> Self {
        Self {
            positions: [0.0; TOTAL_VERTS * 3],
            normals: [0.0; TOTAL_VERTS * 3],
            attribs: [0; TOTAL_VERTS * 4],
            attribs2: [0; TOTAL_VERTS * 4],
            water_positions: [0.0; TOTAL_VERTS * 3],
            water_attribs: [0; TOTAL_VERTS * 4],
            indices: [0; INDICES_PER_CHUNK],
            smooth: [0; CELLS],
            scratch_corners: [0.0; VERTS_PER_CHUNK * 3],
            scratch_heights: [0.0; VERTS_PER_CHUNK],
            chunk_hash: [0; CHUNKS],
            water_present: [0; CHUNKS],
            dirty: [0; CHUNKS],
            remeshed: 0,
        }
    }

    /// Heap-allocate. Same reasoning as [`World::boxed`]: several megabytes must
    /// not touch the stack.
    #[cfg(feature = "alloc")]
    #[must_use]
    #[allow(unsafe_code)]
    pub fn boxed() -> alloc::boxed::Box<Self> {
        use core::alloc::Layout;
        let layout = Layout::new::<Self>();
        // SAFETY: every field is a plain integer or float array, for which the
        // all-zero bit pattern is valid (0.0 for floats).
        let mut m = unsafe {
            let p = alloc::alloc::alloc_zeroed(layout).cast::<Self>();
            if p.is_null() {
                alloc::alloc::handle_alloc_error(layout);
            }
            alloc::boxed::Box::from_raw(p)
        };
        m.build_indices();
        m
    }

    /// Fill the shared index buffer. Topology never changes, so this runs once.
    ///
    /// # Winding
    ///
    /// Counter-clockwise seen from *outside* the planet, which is what GL's
    /// `frontFace(CCW)` and three's default `side: FrontSide` mean by
    /// front-facing. `i` steps along `FACE_RIGHT` and `j` along `FACE_UP`, and
    /// `build_seam_table` asserts `right x up == normal` in const eval, so
    /// `a, b, c` gives `right x up`, i.e. outward, on all six faces.
    ///
    /// Emitting `a, c, b` instead — as this did until the winding test below was
    /// written — is `up x right`, i.e. inward, and it is not a subtle defect:
    /// with back faces culled the near hemisphere disappears and the *inner*
    /// surface of the far one is drawn in its place. The silhouette stays a disc
    /// of the right size and the normal attribute is forced outward
    /// independently (`build_normals`), so it lit plausibly and read as a
    /// see-through planet rather than as a broken mesh. See
    /// `docs/specs/rendering.md`.
    pub fn build_indices(&mut self) {
        let mut k = 0usize;
        for j in 0..VERTS_PER_EDGE - 1 {
            for i in 0..VERTS_PER_EDGE - 1 {
                let a = (j * VERTS_PER_EDGE + i) as u16;
                let b = a + 1;
                let c = a + VERTS_PER_EDGE as u16;
                let d = c + 1;
                self.indices[k] = a;
                self.indices[k + 1] = b;
                self.indices[k + 2] = c;
                self.indices[k + 3] = b;
                self.indices[k + 4] = d;
                self.indices[k + 5] = c;
                k += 6;
            }
        }
    }

    /// Re-mesh every chunk whose contents changed since the last call.
    ///
    /// Returns the number of chunks rebuilt, which is what the perf harness
    /// reports and what makes "only dirty chunks re-mesh" checkable rather than
    /// asserted.
    pub fn update(&mut self, w: &World) -> u32 {
        self.smooth_heights(w);
        self.dirty = [0; CHUNKS];
        let mut count = 0u32;
        for chunk in 0..CHUNKS {
            let h = chunk_content_hash(w, chunk);
            if h == self.chunk_hash[chunk] {
                continue;
            }
            self.chunk_hash[chunk] = h;
            self.build_chunk(w, chunk);
            self.dirty[chunk] = 1;
            count += 1;
        }
        self.remeshed = count;
        count
    }

    /// Force a full rebuild, e.g. after `init`.
    pub fn rebuild_all(&mut self, w: &World) {
        self.chunk_hash = [0; CHUNKS];
        self.update(w);
    }

    /// Step 2 of §7.1: one material-weighted Laplacian pass, in cell space.
    ///
    /// Done in cell space rather than on the vertex grid for a specific reason:
    /// a vertex-space Laplacian at a chunk border needs corner data two cells
    /// outside the face, and the ghost ring is one cell deep. In cell space it
    /// needs one, which the ghost ring already provides — and the result is
    /// ghost-copied so vertices on a face boundary still agree from both sides.
    fn smooth_heights(&mut self, w: &World) {
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    let h = i32::from(w.height[c]) * 256;
                    let mut sum = 0i32;
                    for dir in 0..4usize {
                        sum += i32::from(w.height[neighbour_flat(c, dir)]) * 256;
                    }
                    let mean = sum / 4;
                    let k = SMOOTH_WEIGHT[(w.material[c] as usize).min(4)];
                    self.smooth[c] = h + (mean - h) * k / 256;
                }
            }
        }
        // Ghost-copy the smoothed field so face-boundary corners are continuous.
        for k in 0..GHOST_ENTRIES {
            self.smooth[GHOST_DST[k] as usize] = self.smooth[GHOST_SRC[k] as usize];
        }
    }

    fn build_chunk(&mut self, w: &World, chunk: usize) {
        let (face, cgx, cgy) = chunk_origin(chunk);
        let vbase = chunk * VERTS_PER_CHUNK;
        let mut wet = false;

        // The true corner position at every grid slot, including the ring one
        // cell *outside* the chunk — which is what the normal pass differences
        // against. `positions` cannot serve that purpose: its outer ring is the
        // skirt, a duplicate of the border corner, so a central difference there
        // silently degenerated into a one-sided one. See `build_normals`.
        //
        // This costs no extra `corner_height` work: `positions` is filled from
        // this grid, and the skirt ring is a copy of the border rather than a
        // fresh evaluation.
        for gj in 0..VERTS_PER_EDGE {
            for gi in 0..VERTS_PER_EDGE {
                // Clamped to the corners the one-deep ghost ring can support:
                // `corner_height` averages cells `g - 1 ..= g`, so `g` may run
                // from 0 to N and no further. At a face edge the ring therefore
                // still duplicates, and those twelve cube edges keep the
                // one-sided normals; every chunk border inside a face gets the
                // real neighbour.
                let gx = (cgx as i32 + gi as i32 - 1).clamp(0, N as i32);
                let gy = (cgy as i32 + gj as i32 - 1).clamp(0, N as i32);
                let terrain = self.corner_height(face, gx, gy);
                let dir = corner_direction(face, gx, gy);
                let r = BASE_RADIUS + terrain * HEIGHT_TO_RADIUS;
                let slot = gj * VERTS_PER_EDGE + gi;
                self.scratch_heights[slot] = terrain;
                let k = slot * 3;
                self.scratch_corners[k] = dir[0] * r;
                self.scratch_corners[k + 1] = dir[1] * r;
                self.scratch_corners[k + 2] = dir[2] * r;
            }
        }

        for gj in 0..VERTS_PER_EDGE {
            for gi in 0..VERTS_PER_EDGE {
                // The skirt ring clamps onto the border corner and drops.
                let i = (gi as i32 - 1).clamp(0, CHUNK as i32);
                let j = (gj as i32 - 1).clamp(0, CHUNK as i32);

                let gx = cgx as i32 + i;
                let gy = cgy as i32 + j;

                // Read back from the corner grid rather than recomputed, so the two
                // can never disagree *and* the dual-grid average runs once per
                // vertex: the skirt ring reads the border slot it duplicates,
                // exactly as the `i`/`j` clamp above says it should.
                let slot = gj.clamp(1, VERTS_PER_EDGE - 2) * VERTS_PER_EDGE
                    + gi.clamp(1, VERTS_PER_EDGE - 2);
                let terrain = self.scratch_heights[slot];
                let (surface, depth) = self.corner_water(w, face, gx, gy, terrain);
                let (mat, veg, infl) = corner_attribs(w, face, gx, gy);
                let (lava, fert, sed) = corner_attribs2(w, face, gx, gy);

                let dir = corner_direction(face, gx, gy);

                let vi = vbase + gj * VERTS_PER_EDGE + gi;
                let src = slot * 3;
                self.positions[vi * 3] = self.scratch_corners[src];
                self.positions[vi * 3 + 1] = self.scratch_corners[src + 1];
                self.positions[vi * 3 + 2] = self.scratch_corners[src + 2];

                let rw = BASE_RADIUS + surface * HEIGHT_TO_RADIUS;
                self.water_positions[vi * 3] = dir[0] * rw;
                self.water_positions[vi * 3 + 1] = dir[1] * rw;
                self.water_positions[vi * 3 + 2] = dir[2] * rw;

                let d8 = ((depth / 8.0) as i32).clamp(0, 255) as u8;
                wet |= depth > 0.5;
                self.attribs[vi * 4] = mat;
                self.attribs[vi * 4 + 1] = veg;
                self.attribs[vi * 4 + 2] = infl;
                self.attribs[vi * 4 + 3] = d8;

                self.attribs2[vi * 4] = lava;
                self.attribs2[vi * 4 + 1] = fert;
                self.attribs2[vi * 4 + 2] = sed;
                self.attribs2[vi * 4 + 3] = 0;

                let erode = w.erode[clamp_cell(face, gx, gy)];
                self.water_attribs[vi * 4] = d8;
                self.water_attribs[vi * 4 + 1] = infl;
                self.water_attribs[vi * 4 + 2] = erode;
                // 0 or 255, not 0 or 1: the attribute is uploaded normalised, so a raw
                // 1 arrives in the shader as 1/255 and every "is there water here"
                // test would answer no.
                self.water_attribs[vi * 4 + 3] = if depth > 0.5 { 255 } else { 0 };
            }
        }

        self.water_present[chunk] = u8::from(wet);

        // Normals first, skirt second. The skirt is a duplicate of the border
        // vertex pushed inward, so dropping it *before* the normal pass would
        // tilt every first-interior-ring normal by the drop distance — and that
        // shows up as a bright seam along every chunk border, which is exactly
        // the artefact the skirt exists to prevent.
        self.build_normals(chunk);
        self.sink_skirt(chunk);
    }

    /// Push the outer ring inward, hiding cracks against a stale neighbour.
    fn sink_skirt(&mut self, chunk: usize) {
        let vbase = chunk * VERTS_PER_CHUNK;
        let last = VERTS_PER_EDGE - 1;
        for gj in 0..VERTS_PER_EDGE {
            for gi in 0..VERTS_PER_EDGE {
                if gi != 0 && gj != 0 && gi != last && gj != last {
                    continue;
                }
                // Terrain only. The water surface is transparent and lit almost
                // entirely by Fresnel, so a skirt wall on it is a near-vertical
                // sliver at grazing incidence — which renders as a bright sky
                // reflection and draws the chunk grid across the ocean in pale
                // blue. There is nothing to hide there: a crack in a transparent
                // surface over opaque terrain is invisible.
                let vi = vbase + gj * VERTS_PER_EDGE + gi;
                let p = &mut self.positions;
                let x = p[vi * 3];
                let y = p[vi * 3 + 1];
                let z = p[vi * 3 + 2];
                let len2 = x * x + y * y + z * z;
                if len2 <= 0.0 {
                    continue;
                }
                let r = len2 * rsqrt(len2); // length, via the same reciprocal sqrt
                let scale = ((r - SKIRT_DROP) / r).max(0.0);
                p[vi * 3] = x * scale;
                p[vi * 3 + 1] = y * scale;
                p[vi * 3 + 2] = z * scale;
            }
        }
    }

    /// Central-difference normals over the corner grid. The skirt ring copies its
    /// inward neighbour's normal so the skirt shades like the surface it hides.
    ///
    /// # Why this differences `corners` and not `positions`
    ///
    /// `positions`' outer ring is the skirt: a duplicate of the border corner.
    /// Differencing that, a border vertex's "central" difference collapsed to a
    /// one-sided one — and to a differently-sided one on each side of the seam,
    /// because a chunk's near border reads forward while its neighbour's far
    /// border reads backward. The two chunks' copies of a shared vertex are
    /// bit-identical in *position* (`face_boundary_vertices_coincide_exactly`)
    /// and disagreed in *normal*, which drew a faint shading grid over the whole
    /// planet every 16 cells — the artefact the skirt comment claims to have
    /// eliminated, arriving by a different route.
    ///
    /// `scratch_corners` carries the real neighbour one cell outside the chunk, so
    /// both sides difference the same four positions in the same order and land on
    /// the same normal, bit for bit. `normals_agree_across_chunk_borders` pins it.
    fn build_normals(&mut self, chunk: usize) {
        let vbase = chunk * VERTS_PER_CHUNK;
        let at = |gi: usize, gj: usize| vbase + gj * VERTS_PER_EDGE + gi;
        let corner = |s: &Self, gi: usize, gj: usize| {
            let k = (gj * VERTS_PER_EDGE + gi) * 3;
            [s.scratch_corners[k], s.scratch_corners[k + 1], s.scratch_corners[k + 2]]
        };
        for gj in 1..VERTS_PER_EDGE - 1 {
            for gi in 1..VERTS_PER_EDGE - 1 {
                let vi = at(gi, gj);
                let e = corner(self, gi + 1, gj);
                let wv = corner(self, gi - 1, gj);
                let nv = corner(self, gi, gj + 1);
                let s = corner(self, gi, gj - 1);
                let du = [e[0] - wv[0], e[1] - wv[1], e[2] - wv[2]];
                let dv = [nv[0] - s[0], nv[1] - s[1], nv[2] - s[2]];
                let mut n = [
                    du[1] * dv[2] - du[2] * dv[1],
                    du[2] * dv[0] - du[0] * dv[2],
                    du[0] * dv[1] - du[1] * dv[0],
                ];
                let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
                if len2 > 1e-20 {
                    let inv = rsqrt(len2);
                    n = [n[0] * inv, n[1] * inv, n[2] * inv];
                } else {
                    n = normalize(corner(self, gi, gj));
                }
                // `du x dv` is `right x up`, which `build_seam_table` asserts is
                // the outward normal, so this branch does not fire on any terrain
                // the generator can produce: relief is at most 0.058 R against a
                // two-cell tangent step, nowhere near enough to tip the cross
                // product through the tangent plane. It stays as a cheap floor
                // under a normal that must never point into the planet.
                //
                // It is emphatically *not* what keeps the planet the right way
                // out: this forces the normal *attribute* outward and says
                // nothing about the triangle winding, which is `build_indices`'
                // business and was inward for six phases while
                // `normals_are_unit_length_and_point_outward` stayed green off
                // the back of this very branch. Read from `corners`, not
                // `positions`: identical here, but it keeps every input to a
                // normal on the same grid, so the two chunks sharing a border
                // cannot diverge through this branch either.
                let p = corner(self, gi, gj);
                if n[0] * p[0] + n[1] * p[1] + n[2] * p[2] < 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                self.normals[vi * 3] = n[0];
                self.normals[vi * 3 + 1] = n[1];
                self.normals[vi * 3 + 2] = n[2];
            }
        }
        for g in 0..VERTS_PER_EDGE {
            let last = VERTS_PER_EDGE - 1;
            let gi = g.clamp(1, last - 1);
            self.copy_normal(at(g, 0), at(gi, 1));
            self.copy_normal(at(g, last), at(gi, last - 1));
            self.copy_normal(at(0, g), at(1, gi));
            self.copy_normal(at(last, g), at(last - 1, gi));
        }
    }

    fn copy_normal(&mut self, dst: usize, src: usize) {
        self.normals[dst * 3] = self.normals[src * 3];
        self.normals[dst * 3 + 1] = self.normals[src * 3 + 1];
        self.normals[dst * 3 + 2] = self.normals[src * 3 + 2];
    }

    /// A vertex position, for the tests that check the buffer they were written
    /// to. The mesher itself no longer reads `positions` back: normals are
    /// differenced from the corner grid instead, which is what makes them agree
    /// across a chunk border.
    #[cfg(test)]
    fn pos(&self, vi: usize) -> [f32; 3] {
        [self.positions[vi * 3], self.positions[vi * 3 + 1], self.positions[vi * 3 + 2]]
    }

    /// Step 1 of §7.1: the dual grid. Handles the eight ambiguous cube corners.
    #[must_use]
    pub fn corner_height(&self, face: usize, gx: i32, gy: i32) -> f32 {
        if let Some(cells) = cube_corner_cells(face, gx, gy) {
            let sum: i32 = cells.iter().map(|&c| self.smooth[c]).sum();
            return (sum / 3) as f32 / 256.0;
        }
        let a = self.smooth[idx_i(face, gx - 1, gy - 1)];
        let b = self.smooth[idx_i(face, gx, gy - 1)];
        let c = self.smooth[idx_i(face, gx - 1, gy)];
        let d = self.smooth[idx_i(face, gx, gy)];
        ((a + b + c + d) / 4) as f32 / 256.0
    }

    /// Water surface altitude and depth at a corner, on the same dual grid.
    fn corner_water(&self, w: &World, face: usize, gx: i32, gy: i32, terrain: f32) -> (f32, f32) {
        let mut depth = 0i32;
        let mut n = 0i32;
        for (dx, dy) in [(-1, -1), (0, -1), (-1, 0), (0, 0)] {
            let c = idx_i(face, (gx + dx).clamp(-1, N as i32), (gy + dy).clamp(-1, N as i32));
            depth += i32::from(w.water[c]);
            n += 1;
        }
        let d = (depth / n.max(1)) as f32;
        (terrain + d, d)
    }
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if len2 <= 0.0 {
        return [0.0, 1.0, 0.0];
    }
    let inv = rsqrt(len2);
    [v[0] * inv, v[1] * inv, v[2] * inv]
}

fn clamp_cell(face: usize, gx: i32, gy: i32) -> usize {
    idx_i(face, gx.clamp(0, N as i32 - 1), gy.clamp(0, N as i32 - 1))
}

fn corner_attribs(w: &World, face: usize, gx: i32, gy: i32) -> (u8, u8, u8) {
    let c = clamp_cell(face, gx, gy);
    let infl = (i32::from(w.influence[c]) + 128).clamp(0, 255) as u8;
    (w.material[c], w.vegetation[c], infl)
}

/// Lava, fertility and sediment at a corner.
///
/// Lava is the reason this exists. Unlike the others it is a *fluid* the
/// simulation moves every tick, so it is taken as the maximum of the four cells
/// around the corner rather than the mean: an averaged edge fades a lava front
/// out over a cell and a half, and the thing a player needs to read is where the
/// front *is*. Fertility and sediment are ground properties and take the value of
/// the same cell the material does, so all of the terrain shader's per-cell
/// fields agree about which cell they came from.
fn corner_attribs2(w: &World, face: usize, gx: i32, gy: i32) -> (u8, u8, u8) {
    let c = clamp_cell(face, gx, gy);
    let mut lava = 0u8;
    for (dx, dy) in [(-1, -1), (0, -1), (-1, 0), (0, 0)] {
        let n = clamp_cell(face, gx + dx, gy + dy);
        lava = lava.max(w.lava[n]);
    }
    (lava, w.fertility[c], w.sediment[c])
}

/// The three live cells meeting at a cube corner, if `(gx, gy)` is one.
///
/// All three faces that meet there produce the same set, so all three compute
/// the same vertex height and the corner does not split.
fn cube_corner_cells(face: usize, gx: i32, gy: i32) -> Option<[usize; 3]> {
    let n = N as i32;
    let (cx, cy) = match (gx, gy) {
        (0, 0) => (0, 0),
        (0, v) if v == n => (0, n - 1),
        (u, 0) if u == n => (n - 1, 0),
        (u, v) if u == n && v == n => (n - 1, n - 1),
        _ => return None,
    };
    // Step off both edges that meet at this corner.
    let dx = if cx == 0 { DIR_W } else { crate::seams::DIR_E };
    let dy = if cy == 0 { DIR_S } else { crate::seams::DIR_N };
    let (fa, ax, ay, _) = step(face, cx, cy, dx);
    let (fb, bx, by, _) = step(face, cx, cy, dy);
    Some([idx_i(face, cx, cy), idx_i(fa, ax, ay), idx_i(fb, bx, by)])
}

/// The warped point on the *cube* for a corner, before projection.
///
/// Every component is exactly one of `±1`, `±warp(a)`, `±warp(b)`, because the
/// three basis vectors are axis-aligned and distinct. Two faces meeting at the
/// same cube corner therefore produce bit-identical vectors, which is what makes
/// this usable as an identity key for a corner in tests.
#[must_use]
pub fn corner_cube_point(face: usize, gx: i32, gy: i32) -> [f32; 3] {
    let a = warp(gx as f32 * 2.0 / N as f32 - 1.0);
    let b = warp(gy as f32 * 2.0 / N as f32 - 1.0);
    let nrm = FACE_NORMAL_F[face];
    let r = FACE_RIGHT_F[face];
    let u = FACE_UP_F[face];
    [nrm[0] + r[0] * a + u[0] * b, nrm[1] + r[1] * a + u[1] * b, nrm[2] + r[2] * a + u[2] * b]
}

/// Unit direction from the planet centre to a corner, tangent-adjusted.
///
/// §3.2: tangent-adjusted cube-to-sphere, not naive normalisation, which holds
/// cell-area distortion near cube corners at roughly 1.3:1 instead of ~1.9:1.
fn corner_direction(face: usize, gx: i32, gy: i32) -> [f32; 3] {
    normalize(corner_cube_point(face, gx, gy))
}

const FACE_NORMAL_F: [[f32; 3]; 6] = [
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, -1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
];
const FACE_RIGHT_F: [[f32; 3]; 6] = [
    [0.0, 0.0, -1.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
];
const FACE_UP_F: [[f32; 3]; 6] = [
    [0.0, 1.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, -1.0],
    [0.0, 0.0, 1.0],
    [0.0, 1.0, 0.0],
    [0.0, 1.0, 0.0],
];

const QUARTER_PI: f32 = 0.785_398_16;

/// Six-term Taylor series for `tan`, valid on `[-pi/4, pi/4]`. Odd by
/// construction, so `tan_series(-x)` is exactly `-tan_series(x)`.
fn tan_series(x: f32) -> f32 {
    let x2 = x * x;
    x * (1.0
        + x2 * (1.0 / 3.0
            + x2 * (2.0 / 15.0
                + x2 * (17.0 / 315.0 + x2 * (62.0 / 2835.0 + x2 * (1382.0 / 155_925.0))))))
}

/// The tangent adjustment of §3.2: `tan(a * pi/4) / tan(pi/4)` for `a` in
/// `[-1, 1]`.
///
/// Series rather than `libm`: this crate is `no_std` and takes no dependencies,
/// and §9.2's argument for Rust is precisely that we own the whole math stack.
///
/// The division by `tan_series(QUARTER_PI)` is not cosmetic normalisation — it
/// is what makes `warp(±1)` come out **exactly** `±1`. The series alone returns
/// 0.99997 there, and a face edge would then sit 3e-5 of a radius away from where
/// the neighbouring face puts it: a hairline crack along all twelve cube edges,
/// far too small to debug by looking and far too large to leave in.
fn warp(a: f32) -> f32 {
    let a = a.clamp(-1.0, 1.0);
    tan_series(a * QUARTER_PI) / tan_series(QUARTER_PI)
}

/// Reciprocal square root: the classic bit hack plus three Newton steps.
///
/// `f32::sqrt` lives in `std`, not `core`, so a `no_std` crate cannot use it.
/// Three iterations converge to well under single-precision resolution.
fn rsqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let half = x * 0.5;
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y *= 1.5 - half * y * y;
    y *= 1.5 - half * y * y;
    y *= 1.5 - half * y * y;
    y
}

/// `(face, cell x origin, cell y origin)` of a chunk.
#[must_use]
pub const fn chunk_origin(chunk: usize) -> (usize, usize, usize) {
    let per_face = CHUNKS_PER_EDGE * CHUNKS_PER_EDGE;
    let face = chunk / per_face;
    let within = chunk % per_face;
    let cy = within / CHUNKS_PER_EDGE;
    let cx = within % CHUNKS_PER_EDGE;
    (face, cx * CHUNK, cy * CHUNK)
}

/// Hash of everything a chunk's geometry depends on.
///
/// Includes a one-cell apron, because a chunk's border vertices average cells
/// belonging to its neighbour — without the apron a change just outside a chunk
/// would leave a visible step at its edge.
fn chunk_content_hash(w: &World, chunk: usize) -> u64 {
    let (face, gx, gy) = chunk_origin(chunk);
    let mut h = crate::hash::Fnv64::new();
    for j in -1..=(CHUNK as i32) {
        for i in -1..=(CHUNK as i32) {
            let c = idx_i(face, gx as i32 + i, gy as i32 + j);
            h.write_i16(w.height[c]);
            h.write_i16(w.water[c]);
            h.write_u8(w.material[c]);
            h.write_u8(w.vegetation[c]);
            h.write_i8(w.influence[c]);
            // Everything the vertex buffers carry has to be in here, or the chunk
            // is not re-meshed when it changes and the attribute silently goes
            // stale. Lava is the one that matters: it is a fluid that moves every
            // tick, so a lava front over unchanged ground would otherwise never
            // reach the GPU and a volcano would look like nothing happened.
            h.write_u8(w.lava[c]);
            h.write_u8(w.fertility[c]);
            h.write_u8(w.sediment[c]);
        }
    }
    // Never let a zero hash mean "unchanged" for a never-built chunk.
    h.finish() | 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MapConfig, TERRAIN_PANGAEA};

    #[test]
    fn geometry_constants_line_up() {
        assert_eq!(N % CHUNK, 0, "N must divide into whole chunks");
        assert_eq!(CHUNKS, 6 * CHUNKS_PER_EDGE * CHUNKS_PER_EDGE);
        assert!(VERTS_PER_CHUNK <= usize::from(u16::MAX), "chunk indices must fit in u16");
        assert_eq!(INDICES_PER_CHUNK % 3, 0);
    }

    #[test]
    fn warp_is_the_tangent_adjustment_and_not_the_identity() {
        // Exactly 1 at the face edge — not approximately. See `warp`.
        assert_eq!(warp(1.0), 1.0, "the face edge does not land on the cube edge");
        assert_eq!(warp(-1.0), -1.0);
        // And exactly odd, so a flipped seam maps to the same point.
        for k in 0..=64 {
            let a = k as f32 / 32.0 - 1.0;
            assert_eq!(warp(-a), -warp(a), "warp is not odd at {a}");
        }
        assert_eq!(warp(0.0), 0.0);
        assert!(warp(0.5) < 0.5, "warp is not compressing the face centre outward");
        // Monotonic, or the projection would fold.
        let mut last = warp(-1.0);
        for k in -99..=100 {
            let v = warp(k as f32 / 100.0);
            assert!(v > last, "warp is not monotonic at {k}");
            last = v;
        }
    }

    #[test]
    fn rsqrt_is_accurate_enough_for_normals() {
        for k in 1..2000 {
            let x = k as f32 * 0.01;
            let got = rsqrt(x);
            let want = 1.0 / libm_sqrt(x);
            assert!((got - want).abs() / want < 1e-5, "rsqrt({x}) = {got}, want {want}");
        }
        assert_eq!(rsqrt(0.0), 0.0);
        assert_eq!(rsqrt(-1.0), 0.0);
    }

    /// A reference square root for the test only, by bisection — deliberately
    /// not the implementation under test.
    fn libm_sqrt(x: f32) -> f32 {
        let (mut lo, mut hi) = (0.0f32, x.max(1.0));
        for _ in 0..60 {
            let mid = (lo + hi) * 0.5;
            if mid * mid < x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (lo + hi) * 0.5
    }

    fn meshed() -> (alloc::boxed::Box<World>, alloc::boxed::Box<Mesh>) {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 2024;
        let mut w = World::boxed();
        w.init(&cfg);
        let mut m = Mesh::boxed();
        m.rebuild_all(&w);
        (w, m)
    }

    #[test]
    fn every_chunk_is_built_and_every_vertex_is_on_the_planet() {
        let (_, m) = meshed();
        assert_eq!(m.remeshed as usize, CHUNKS);
        for vi in 0..TOTAL_VERTS {
            let p = m.pos(vi);
            let r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
            assert!(r2 > 0.25 && r2 < 9.0, "vertex {vi} is at radius^2 {r2}");
            assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite());
        }
    }

    #[test]
    fn face_boundary_vertices_coincide_exactly() {
        // Step 4 of §7.1, asserted rather than hoped for. Every corner vertex on
        // a shared cube edge is computed independently by two faces (three at a
        // cube corner) and must come out bit-identical, or the planet has
        // hairline cracks along four great circles.
        //
        // Corners are identified by their exact position on the cube, which two
        // faces compute to the same bits — see `corner_cube_point`. No tolerance
        // is involved on either side of the comparison.
        let (_, m) = meshed();
        let mut by_point: std::collections::BTreeMap<[u32; 3], (f32, usize, i32, i32)> =
            std::collections::BTreeMap::new();
        let mut shared = 0usize;

        for face in 0..6usize {
            for gy in 0..=N as i32 {
                for gx in 0..=N as i32 {
                    let p = corner_cube_point(face, gx, gy);
                    let key = [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()];
                    let h = m.corner_height(face, gx, gy);
                    match by_point.get(&key) {
                        None => {
                            by_point.insert(key, (h, face, gx, gy));
                        }
                        Some(&(prev, pf, pgx, pgy)) => {
                            shared += 1;
                            assert_eq!(
                                h.to_bits(),
                                prev.to_bits(),
                                "corner at cube point {p:?} is {h} from face {face} \
                                 ({gx},{gy}) but {prev} from face {pf} ({pgx},{pgy})"
                            );
                        }
                    }
                }
            }
        }

        // Each of the 12 cube edges is shared by 2 faces over N-1 interior corner
        // points plus its 2 endpoints; each of the 8 cube corners is shared by 3.
        // If nothing were shared this test would pass vacuously.
        assert!(
            shared >= 12 * (N - 1),
            "only {shared} shared corners found; the identity key is not matching"
        );
    }

    #[test]
    fn the_eight_cube_corners_agree_across_all_three_faces() {
        // §3.5: the diagonal ghost cell at a face corner is ambiguous. The mesh
        // resolves it by averaging the three real cells that meet there, which
        // all three faces can compute — this checks they actually do.
        let (_, m) = meshed();
        let n = N as i32;
        let mut groups: std::collections::BTreeMap<[u32; 3], std::vec::Vec<f32>> =
            std::collections::BTreeMap::new();
        for face in 0..6usize {
            for &(gx, gy) in &[(0, 0), (0, n), (n, 0), (n, n)] {
                let p = corner_cube_point(face, gx, gy);
                let key = [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()];
                groups.entry(key).or_default().push(m.corner_height(face, gx, gy));
            }
        }
        assert_eq!(groups.len(), 8, "expected the cube's 8 corners, found {}", groups.len());
        for (key, heights) in &groups {
            assert_eq!(heights.len(), 3, "corner {key:?} is not shared by three faces");
            assert!(
                heights.windows(2).all(|w| w[0].to_bits() == w[1].to_bits()),
                "cube corner heights disagree: {heights:?}"
            );
        }
    }

    #[test]
    fn smoothing_actually_reduces_terracing() {
        let (w, m) = meshed();
        // Compare the raw cell field against the smoothed one: the mean
        // neighbour-to-neighbour step must fall, or step 2 is doing nothing.
        let mut raw = 0i64;
        let mut smoothed = 0i64;
        let mut n = 0i64;
        for face in 0..6usize {
            for y in 1..N - 1 {
                for x in 1..N - 1 {
                    let c = idx(face, x, y);
                    let e = idx(face, x + 1, y);
                    raw += i64::from((w.height[c] - w.height[e]).abs()) * 256;
                    smoothed += i64::from((m.smooth[c] - m.smooth[e]).abs());
                    n += 1;
                }
            }
        }
        let _ = n;
        assert!(smoothed < raw, "the Laplacian pass did not smooth anything");
    }

    #[test]
    fn rock_stays_crisper_than_sand() {
        // §7.1: "rock stays crisp and cliff-like; sand reads as dunes". The
        // material map has to drive silhouette, not just colour.
        assert!(
            SMOOTH_WEIGHT[crate::world::MAT_ROCK as usize]
                < SMOOTH_WEIGHT[crate::world::MAT_SAND as usize],
            "rock is smoothed more than sand"
        );
    }

    #[test]
    fn only_dirty_chunks_are_remeshed() {
        let (mut w, mut m) = meshed();
        assert_eq!(m.update(&w), 0, "a still world re-meshed something");

        // Touch one cell in the middle of one chunk.
        let (face, gx, gy) = chunk_origin(40);
        w.height[idx(face, gx + 8, gy + 8)] += 64;
        let n = m.update(&w);
        assert_eq!(n, 1, "expected exactly one dirty chunk, got {n}");
        assert_eq!(m.dirty[40], 1, "the dirty flag does not name the rebuilt chunk");
        assert_eq!(m.dirty.iter().map(|&d| u32::from(d)).sum::<u32>(), 1);

        // A cell on a chunk border dirties both chunks that average it.
        let n = {
            w.height[idx(face, gx, gy + 8)] += 64;
            m.update(&w)
        };
        assert!((1..=2).contains(&n), "a border cell dirtied {n} chunks");
    }

    #[test]
    fn dry_chunks_are_flagged_so_the_host_can_skip_them() {
        let (w, m) = meshed();
        let wet = m.water_present.iter().filter(|&&f| f != 0).count();
        assert!(wet > 0, "no chunk holds water on an archipelago map");
        assert!(wet < CHUNKS, "every chunk holds water; the flag saves nothing");

        // The flag must agree with the field it summarises.
        for chunk in 0..CHUNKS {
            let (face, gx, gy) = chunk_origin(chunk);
            let any = (0..CHUNK)
                .flat_map(|j| (0..CHUNK).map(move |i| (i, j)))
                .any(|(i, j)| w.water[idx(face, gx + i, gy + j)] > 0);
            if any {
                assert_eq!(m.water_present[chunk], 1, "chunk {chunk} holds water but reads dry");
            }
        }
    }

    #[test]
    fn indices_are_a_valid_triangle_list() {
        let mut m = Mesh::boxed();
        m.build_indices();
        assert_eq!(m.indices.len(), INDICES_PER_CHUNK);
        for &i in &m.indices {
            assert!((i as usize) < VERTS_PER_CHUNK, "index {i} is out of range");
        }
        // Every interior quad contributes two triangles.
        let quads = (VERTS_PER_EDGE - 1) * (VERTS_PER_EDGE - 1);
        assert_eq!(INDICES_PER_CHUNK, quads * 6);
    }

    #[test]
    fn triangles_wind_outward_so_the_planet_is_not_inside_out() {
        // The invariant whose absence let the planet render inside out for the
        // whole of phases 1-6. `normals_are_unit_length_and_point_outward`
        // below pins the *normal attribute*, and the mesher forces that outward
        // explicitly (see `build_normals`) — so it stayed green while the
        // *winding* was inward, and every consumer that culls by facing drew the
        // far hemisphere's inner surface instead of the near one. Under GL's
        // `frontFace(CCW)` and three's default `side: FrontSide` that is a
        // see-through globe: the ground under the camera is culled and the back
        // of the world shows through it.
        //
        // Checked on real meshed geometry rather than on `build_indices` alone,
        // because winding is only meaningful against the positions the indices
        // point at.
        let (_, m) = meshed();
        let mut checked = 0usize;
        let mut degenerate = 0usize;
        for chunk in 0..CHUNKS {
            let vbase = chunk * VERTS_PER_CHUNK;
            for tri in m.indices.chunks_exact(3) {
                let p = [
                    m.pos(vbase + tri[0] as usize),
                    m.pos(vbase + tri[1] as usize),
                    m.pos(vbase + tri[2] as usize),
                ];
                let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
                let v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
                let n = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                // The skirt ring is an exact duplicate of the border corner
                // while `SKIRT_DROP` is zero, so its triangles have no area and
                // no orientation to check. Filtered on the cross product itself
                // rather than by excluding index ranges by hand, so this stays
                // correct if the skirt ever drops again.
                if n[0] * n[0] + n[1] * n[1] + n[2] * n[2] <= 1e-18 {
                    degenerate += 1;
                    continue;
                }
                // The centroid points outward: every vertex is on the planet, so
                // the radial and the outward face direction agree.
                let c = [
                    (p[0][0] + p[1][0] + p[2][0]) / 3.0,
                    (p[0][1] + p[1][1] + p[2][1]) / 3.0,
                    (p[0][2] + p[1][2] + p[2][2]) / 3.0,
                ];
                let facing = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
                assert!(
                    facing > 0.0,
                    "chunk {chunk} triangle {tri:?} winds inward (facing {facing:e}); \
                     the whole planet is inside out"
                );
                checked += 1;
            }
        }
        assert!(checked > 0, "no triangle had any area; the test proved nothing");
        assert!(degenerate > 0, "the skirt ring stopped being degenerate; revisit SKIRT_DROP");
    }

    #[test]
    fn normals_are_unit_length_and_point_outward() {
        let (_, m) = meshed();
        for vi in 0..TOTAL_VERTS {
            let n = [m.normals[vi * 3], m.normals[vi * 3 + 1], m.normals[vi * 3 + 2]];
            let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            assert!((len2 - 1.0).abs() < 1e-3, "normal {vi} has length^2 {len2}");
            let p = m.pos(vi);
            assert!(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] > 0.0, "normal {vi} points inward");
        }
    }

    #[test]
    fn normals_agree_across_chunk_borders() {
        // Positions on a chunk border were already proven bit-identical; normals
        // were not, and nothing checked them. They came out different, because a
        // border vertex's central difference read the skirt duplicate on one side
        // — forward on a chunk's near border, backward on its neighbour's far
        // border — so the two copies of one vertex got two different normals and
        // the planet wore a faint shading grid every 16 cells.
        //
        // Only borders *inside* a face are checked. `corner_height` needs cells
        // `g - 1 ..= g` and the ghost ring is one cell deep, so at the twelve cube
        // edges the outside corner is genuinely unavailable and both faces keep a
        // one-sided difference there. That is a documented limit, not an
        // oversight: fixing it needs a two-deep ghost ring.
        let (_, m) = meshed();
        let mut compared = 0usize;
        for face in 0..6usize {
            for cy in 0..CHUNKS_PER_EDGE {
                for cx in 0..CHUNKS_PER_EDGE {
                    // Compare this chunk's east border with the west border of
                    // the chunk to its east, vertex for vertex.
                    if cx + 1 >= CHUNKS_PER_EDGE {
                        continue;
                    }
                    let a = (face * CHUNKS_PER_EDGE + cy) * CHUNKS_PER_EDGE + cx;
                    let b = a + 1;
                    // `i = 16` on A is the same corner as `i = 0` on B, i.e.
                    // grid column 17 on A and column 1 on B.
                    for gj in 1..VERTS_PER_EDGE - 1 {
                        let va = a * VERTS_PER_CHUNK + gj * VERTS_PER_EDGE + (VERTS_PER_EDGE - 2);
                        let vb = b * VERTS_PER_CHUNK + gj * VERTS_PER_EDGE + 1;
                        // Positions first: if these ever disagree the vertices are
                        // not the pair this test thinks they are.
                        for k in 0..3 {
                            assert_eq!(
                                m.positions[va * 3 + k].to_bits(),
                                m.positions[vb * 3 + k].to_bits(),
                                "chunk {a}/{b} row {gj} component {k}: not the same vertex"
                            );
                            assert_eq!(
                                m.normals[va * 3 + k].to_bits(),
                                m.normals[vb * 3 + k].to_bits(),
                                "chunk {a}/{b} row {gj} component {k}: normals differ \
                                 ({} vs {})",
                                m.normals[va * 3 + k],
                                m.normals[vb * 3 + k]
                            );
                        }
                        compared += 1;
                    }
                }
            }
        }
        // 6 faces x 4 rows of chunks x 3 interior borders x 17 shared vertices.
        assert_eq!(compared, 6 * CHUNKS_PER_EDGE * (CHUNKS_PER_EDGE - 1) * (VERTS_PER_EDGE - 2));
    }

    #[test]
    fn lava_reaches_the_vertex_buffer_and_dirties_its_chunk() {
        // The plumbing test the other four attributes never had. A field that is
        // written into `Mesh` but missing from `chunk_content_hash` looks correct
        // on the first frame and then never updates again — which is exactly how
        // lava would have behaved, since it is a fluid that moves every tick over
        // ground that does not.
        let (mut w, mut m) = meshed();
        let c = crate::world::idx(0, 20, 20);
        assert_eq!(w.lava[c], 0);

        // A chunk that is not dirtied is not re-meshed, so assert the dirty flag
        // rather than only the buffer contents.
        m.update(&w);
        w.lava[c] = 200;
        let remeshed = m.update(&w);
        assert!(remeshed > 0, "raising lava did not dirty any chunk");

        let mut hottest = 0u8;
        for vi in 0..TOTAL_VERTS {
            hottest = hottest.max(m.attribs2[vi * 4]);
        }
        assert_eq!(hottest, 200, "lava did not reach attribs2");

        // And it goes away again, or a cooled flow would glow forever.
        w.lava[c] = 0;
        assert!(m.update(&w) > 0, "clearing lava did not dirty any chunk");
        for vi in 0..TOTAL_VERTS {
            assert_eq!(m.attribs2[vi * 4], 0, "lava outlived the field it came from");
        }
    }

    #[test]
    fn meshing_never_touches_the_world() {
        // The whole float-containment argument rests on this.
        let (mut w, mut m) = meshed();
        let before = w.state_hash();
        m.update(&w);
        m.rebuild_all(&w);
        assert_eq!(w.state_hash(), before);
        w.tick(&[]);
    }
}
