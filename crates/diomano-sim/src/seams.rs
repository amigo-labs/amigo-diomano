//! Cubed-sphere topology: the 24 seam rules and the ghost-border tables.
//!
//! HANDOFF §3.3. A cube has 12 edges, each traversable from two sides, so there
//! are 24 seam rules. The spec says they are "computed once at startup and never
//! touched again"; here they are computed at *compile* time, from the six face
//! bases, so the table cannot drift from the geometry it is supposed to describe.
//!
//! Hand-writing 24 rules is the classic way to ship a cubed sphere with three
//! subtly wrong entries that only show up as a rendering artefact six weeks
//! later. Deriving them from `FACE_NORMAL`/`FACE_RIGHT`/`FACE_UP` makes the
//! rotation fall out of the geometry instead of out of a table typed by hand.
//!
//! # Direction rotates across a seam
//!
//! Leaving the east edge of `+x` you enter `-z` still heading east. Leaving the
//! *north* edge of `+x` you enter `+y` heading **west**. There is no assignment
//! of face coordinate systems that avoids this — it is a property of the cube,
//! not of the convention. Every seam crossing therefore returns a direction as
//! well as a cell, and callers that walk (walkers, the loop test) must carry it.

use crate::world::N;

/// Which destination axis the source edge coordinate maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Axis {
    X = 0,
    Y = 1,
}

/// One of the 24 seam rules, indexed `face * 4 + edge` with edge order N, E, S, W.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeamRule {
    /// Destination face.
    pub face: u8,
    /// Which destination axis the source edge coordinate maps to.
    pub axis: Axis,
    /// Is that coordinate reversed.
    pub flip: bool,
    /// Enter at index 0 (`false`) or `N - 1` (`true`) on the other axis.
    pub at_max: bool,
    /// The direction of travel re-expressed in the destination face's frame.
    ///
    /// Not in the HANDOFF §3.3 struct; it is fully determined by the other
    /// fields, and materialising it here keeps the rotation out of the hot loop.
    pub dir: u8,
}

/// North: +y. East: +x. South: -y. West: -x. Fixed order, everywhere (§10).
pub const DIR_N: usize = 0;
pub const DIR_E: usize = 1;
pub const DIR_S: usize = 2;
pub const DIR_W: usize = 3;
/// Per-direction cell deltas, in the fixed N, E, S, W order.
pub const DIR_DX: [i32; 4] = [0, 1, 0, -1];
pub const DIR_DY: [i32; 4] = [1, 0, -1, 0];

/// The reverse direction. Note this is *not* enough to undo a seam crossing;
/// see the module docs and [`step`].
#[inline]
#[must_use]
pub const fn opposite(dir: usize) -> usize {
    (dir + 2) & 3
}

// Face indices: 0 = +x, 1 = -x, 2 = +y, 3 = -y, 4 = +z, 5 = -z (HANDOFF §3.2).
//
// Each face has a right-handed basis with `right x up == normal`, so no face is
// mirrored relative to any other. That property is what makes the derivation
// below total: every seam is a rotation, never a reflection.
const FACE_NORMAL: [[i8; 3]; 6] =
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_RIGHT: [[i8; 3]; 6] =
    [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FACE_UP: [[i8; 3]; 6] = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];

const fn neg(v: [i8; 3]) -> [i8; 3] {
    [-v[0], -v[1], -v[2]]
}

const fn veq(a: [i8; 3], b: [i8; 3]) -> bool {
    a[0] == b[0] && a[1] == b[1] && a[2] == b[2]
}

const fn cross(a: [i8; 3], b: [i8; 3]) -> [i8; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

const fn face_of_normal(n: [i8; 3]) -> usize {
    let mut f = 0;
    while f < 6 {
        if veq(FACE_NORMAL[f], n) {
            return f;
        }
        f += 1;
    }
    panic!("direction is not a face normal — the face bases are inconsistent");
}

const fn derive(f: usize, d: usize) -> SeamRule {
    // The 3D direction we walk in when leaving face `f` through edge `d`.
    let dir3 = if d == DIR_N {
        FACE_UP[f]
    } else if d == DIR_E {
        FACE_RIGHT[f]
    } else if d == DIR_S {
        neg(FACE_UP[f])
    } else {
        neg(FACE_RIGHT[f])
    };

    // The 3D axis along which the *source* edge coordinate increases. Leaving
    // through N or S the edge is a row, so it varies with x, i.e. with `right`.
    let e3 = if d == DIR_N || d == DIR_S { FACE_RIGHT[f] } else { FACE_UP[f] };

    // Rounding the cube edge turns the direction of travel into `-normal(f)`.
    let in3 = neg(FACE_NORMAL[f]);

    let g = face_of_normal(dir3);
    let rg = FACE_RIGHT[g];
    let ug = FACE_UP[g];

    let axis;
    let flip;
    if veq(e3, rg) {
        axis = Axis::X;
        flip = false;
    } else if veq(e3, neg(rg)) {
        axis = Axis::X;
        flip = true;
    } else if veq(e3, ug) {
        axis = Axis::Y;
        flip = false;
    } else if veq(e3, neg(ug)) {
        axis = Axis::Y;
        flip = true;
    } else {
        panic!("edge axis is not in the destination face's tangent plane");
    }

    // Entering along `+axis` puts us at index 0; entering along `-axis` puts us
    // at N-1. The entry axis is necessarily the one the edge coordinate did not
    // take, because `e3`, `in3` and `normal(g)` are mutually perpendicular.
    let at_max;
    let dir;
    if veq(in3, rg) {
        at_max = false;
        dir = DIR_E as u8;
    } else if veq(in3, neg(rg)) {
        at_max = true;
        dir = DIR_W as u8;
    } else if veq(in3, ug) {
        at_max = false;
        dir = DIR_N as u8;
    } else if veq(in3, neg(ug)) {
        at_max = true;
        dir = DIR_S as u8;
    } else {
        panic!("entry direction is not in the destination face's tangent plane");
    }

    SeamRule { face: g as u8, axis, flip, at_max, dir }
}

const fn build_seam_table() -> [SeamRule; 24] {
    // Assert the bases are right-handed while we are still in const eval: a
    // mirrored face would make every rule below silently wrong.
    let mut f = 0;
    while f < 6 {
        if !veq(cross(FACE_RIGHT[f], FACE_UP[f]), FACE_NORMAL[f]) {
            panic!("face basis is not right-handed: right x up must equal normal");
        }
        f += 1;
    }

    let mut out = [SeamRule { face: 0, axis: Axis::X, flip: false, at_max: false, dir: 0 }; 24];
    let mut f = 0;
    while f < 6 {
        let mut d = 0;
        while d < 4 {
            out[f * 4 + d] = derive(f, d);
            d += 1;
        }
        f += 1;
    }
    out
}

/// The 24 seam rules, `SEAM[face * 4 + edge]`, edge order N, E, S, W.
pub const SEAM: [SeamRule; 24] = build_seam_table();

/// Step one cell from `(face, x, y)` in `dir`.
///
/// Returns the destination cell *and* the direction of travel re-expressed in
/// the destination face's frame. Inside a face the direction is unchanged;
/// across a seam it may rotate by a quarter turn.
///
/// `x` and `y` must be live coordinates in `0..N`.
#[inline]
#[must_use]
pub const fn step(face: usize, x: i32, y: i32, dir: usize) -> (usize, i32, i32, usize) {
    let nx = x + DIR_DX[dir];
    let ny = y + DIR_DY[dir];
    if nx >= 0 && nx < N as i32 && ny >= 0 && ny < N as i32 {
        return (face, nx, ny, dir);
    }

    let rule = SEAM[face * 4 + dir];
    // The coordinate that runs *along* the edge we are leaving through.
    let t = if dir == DIR_N || dir == DIR_S { x } else { y };
    let mapped = if rule.flip { N as i32 - 1 - t } else { t };
    let entry = if rule.at_max { N as i32 - 1 } else { 0 };
    let (dx, dy) = match rule.axis {
        Axis::X => (mapped, entry),
        Axis::Y => (entry, mapped),
    };
    (rule.face as usize, dx, dy, rule.dir as usize)
}

// ---------------------------------------------------------------------------
// Ghost borders (HANDOFF §3.4)
// ---------------------------------------------------------------------------

/// Ghost entries per tick: 6 faces x 4 edges x N cells. This is the "24 copy
/// operations per tick" of §3.4, flattened into one gather so the hot loop has
/// no branches at all.
pub const GHOST_ENTRIES: usize = 6 * 4 * N;

const fn flat(face: usize, x: i32, y: i32) -> u32 {
    crate::world::idx_i(face, x, y) as u32
}

const fn build_ghost_tables() -> ([u32; GHOST_ENTRIES], [u32; GHOST_ENTRIES]) {
    let mut dst = [0u32; GHOST_ENTRIES];
    let mut src = [0u32; GHOST_ENTRIES];
    let mut f = 0;
    while f < 6 {
        let mut d = 0;
        while d < 4 {
            let mut t = 0;
            while t < N {
                // The live cell on this face that sits against edge `d` at
                // position `t` along it, and the ghost slot just outside it.
                let (lx, ly) = match d {
                    DIR_N => (t as i32, N as i32 - 1),
                    DIR_E => (N as i32 - 1, t as i32),
                    DIR_S => (t as i32, 0),
                    _ => (0, t as i32),
                };
                let gx = lx + DIR_DX[d];
                let gy = ly + DIR_DY[d];
                let (sf, sx, sy, _) = step(f, lx, ly, d);
                let k = (f * 4 + d) * N + t;
                dst[k] = flat(f, gx, gy);
                src[k] = flat(sf, sx, sy);
                t += 1;
            }
            d += 1;
        }
        f += 1;
    }
    (dst, src)
}

const GHOST_TABLES: ([u32; GHOST_ENTRIES], [u32; GHOST_ENTRIES]) = build_ghost_tables();
/// Flat index of each ghost slot.
pub const GHOST_DST: [u32; GHOST_ENTRIES] = GHOST_TABLES.0;
/// Flat index of the live cell each ghost slot mirrors.
pub const GHOST_SRC: [u32; GHOST_ENTRIES] = GHOST_TABLES.1;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{N, idx};
    use std::collections::BTreeSet;
    use std::vec::Vec;

    /// HANDOFF §3.3: "walk a closed loop across four faces and assert it returns
    /// to the origin cell, for all 24 entry points."
    ///
    /// A straight walk along grid lines follows a great circle of the cube: four
    /// faces, `N` cells each, so `4 * N` steps must return to the start — same
    /// cell *and* same heading. Every offset along every edge is exercised, not
    /// just one representative, because a flipped `flip` bit is invisible at the
    /// midpoint of an edge and obvious at its ends.
    #[test]
    fn closed_loop_all_24_entry_points() {
        for face in 0..6usize {
            for dir in 0..4usize {
                for offset in 0..N as i32 {
                    // Start on the edge that `dir` leaves through, so the very
                    // first step is the seam crossing under test.
                    let (sx, sy) = match dir {
                        DIR_N => (offset, N as i32 - 1),
                        DIR_E => (N as i32 - 1, offset),
                        DIR_S => (offset, 0),
                        _ => (0, offset),
                    };

                    let mut visited_faces = BTreeSet::new();
                    let (mut f, mut x, mut y, mut d) = (face, sx, sy, dir);
                    for stepno in 0..4 * N {
                        visited_faces.insert(f);
                        let next = step(f, x, y, d);
                        f = next.0;
                        x = next.1;
                        y = next.2;
                        d = next.3;
                        assert!(
                            (0..N as i32).contains(&x) && (0..N as i32).contains(&y),
                            "left the grid at step {stepno} from entry ({face},{dir},{offset})"
                        );
                    }

                    assert_eq!(
                        (f, x, y, d),
                        (face, sx, sy, dir),
                        "loop from face {face} dir {dir} offset {offset} did not close"
                    );
                    assert_eq!(
                        visited_faces.len(),
                        4,
                        "loop from face {face} dir {dir} offset {offset} crossed \
                         {visited_faces:?}, expected exactly four faces"
                    );
                }
            }
        }
    }

    /// Stepping out and stepping back returns you to where you started.
    ///
    /// The undo direction is `opposite(d')` — the reverse of the heading *in the
    /// destination frame* — not `opposite(d)`. Those coincide inside a face and
    /// at half of the seams, and differ at the other half. Using `opposite(d)`
    /// here would make this test fail on a correct implementation; see the
    /// module docs.
    #[test]
    fn neighbour_is_involutive() {
        let mut rotating_seams = 0usize;
        for face in 0..6usize {
            for y in 0..N as i32 {
                for x in 0..N as i32 {
                    for dir in 0..4usize {
                        let (nf, nx, ny, nd) = step(face, x, y, dir);
                        let back = step(nf, nx, ny, opposite(nd));
                        assert_eq!(
                            (back.0, back.1, back.2),
                            (face, x, y),
                            "step/unstep from ({face},{x},{y}) dir {dir} landed at {back:?}"
                        );
                        assert_eq!(
                            back.3,
                            opposite(dir),
                            "heading did not invert from ({face},{x},{y}) dir {dir}"
                        );
                        if nd != dir {
                            rotating_seams += 1;
                        }
                    }
                }
            }
        }
        // Half the seams rotate the heading. If this ever hits zero the table
        // has been "fixed" into something that is not a cube.
        assert!(rotating_seams > 0, "no seam rotates the heading — table is wrong");
    }

    #[test]
    fn seam_table_is_24_rules_over_the_12_cube_edges() {
        // Face indices are laid out so that `f ^ 1` is the opposite face.
        for f in 0..6usize {
            for d in 0..4usize {
                let r = SEAM[f * 4 + d];
                assert_ne!(r.face as usize, f, "face {f} edge {d} maps to itself");
                assert_ne!(r.face as usize, f ^ 1, "face {f} edge {d} reaches its antipode");
            }
        }

        // Each unordered face pair is a cube edge and must appear exactly twice,
        // once from each side: 12 edges, 24 rules.
        let mut edges = BTreeSet::new();
        let mut count = 0usize;
        for f in 0..6usize {
            for d in 0..4usize {
                let g = SEAM[f * 4 + d].face as usize;
                edges.insert((f.min(g), f.max(g)));
                count += 1;
            }
        }
        assert_eq!(count, 24);
        assert_eq!(edges.len(), 12, "expected the cube's 12 edges, got {edges:?}");
    }

    #[test]
    fn every_cell_has_four_distinct_neighbours() {
        for face in 0..6usize {
            for y in (0..N as i32).step_by(7) {
                for x in (0..N as i32).step_by(7) {
                    let mut seen = BTreeSet::new();
                    for dir in 0..4usize {
                        let (nf, nx, ny, _) = step(face, x, y, dir);
                        assert!(
                            seen.insert((nf, nx, ny)),
                            "duplicate neighbour at ({face},{x},{y})"
                        );
                        assert_ne!((nf, nx, ny), (face, x, y));
                    }
                }
            }
        }
    }

    #[test]
    fn ghost_tables_are_complete_and_point_at_live_cells() {
        assert_eq!(GHOST_DST.len(), GHOST_ENTRIES);
        let mut dsts = BTreeSet::new();
        for k in 0..GHOST_ENTRIES {
            assert!(dsts.insert(GHOST_DST[k]), "ghost slot {k} written twice");
        }
        // Each face has 4 * N ghost slots along its edges; the four corner ghost
        // cells are deliberately never written (HANDOFF §3.5 — von Neumann only).
        assert_eq!(dsts.len(), 6 * 4 * N);

        // Every source must be a live cell of some face.
        let live: BTreeSet<u32> = (0..6usize)
            .flat_map(|f| (0..N).flat_map(move |y| (0..N).map(move |x| idx(f, x, y) as u32)))
            .collect();
        for k in 0..GHOST_ENTRIES {
            assert!(live.contains(&GHOST_SRC[k]), "ghost source {k} is not a live cell");
            assert!(!live.contains(&GHOST_DST[k]), "ghost slot {k} overwrites a live cell");
        }
    }

    #[test]
    fn ghost_source_agrees_with_step() {
        // The gather table is an optimisation of `step`; prove it did not drift.
        let mut k = 0;
        let mut checked = Vec::new();
        for f in 0..6usize {
            for d in 0..4usize {
                for t in 0..N {
                    let (lx, ly) = match d {
                        DIR_N => (t as i32, N as i32 - 1),
                        DIR_E => (N as i32 - 1, t as i32),
                        DIR_S => (t as i32, 0),
                        _ => (0, t as i32),
                    };
                    let (sf, sx, sy, _) = step(f, lx, ly, d);
                    assert_eq!(GHOST_SRC[k], idx(sf, sx as usize, sy as usize) as u32);
                    checked.push(k);
                    k += 1;
                }
            }
        }
        assert_eq!(checked.len(), GHOST_ENTRIES);
    }
}
