//! Q16.16 fixed point.
//!
//! HANDOFF §4.1: walker positions and mana accumulators are Q16.16. §9.2: the
//! multiply needs a 64-bit intermediate, which is why this lives in Rust and
//! not in JavaScript.
//!
//! Every operation here is total: no panics, no undefined behaviour, no
//! profile-dependent results. Overflow saturates rather than wrapping, because
//! a saturated value is still a legal game state whereas a wrapped one flips
//! sign and teleports a walker to the other side of the planet.

/// A Q16.16 fixed-point number.
pub type Fx = i32;

/// Number of fractional bits.
pub const FRAC_BITS: u32 = 16;
/// 1.0
pub const ONE: Fx = 1 << FRAC_BITS;
/// 0.5
pub const HALF: Fx = ONE >> 1;
/// Fractional mask.
pub const FRAC_MASK: Fx = ONE - 1;

/// Convert an integer to Q16.16, saturating outside ±32767.
#[inline]
#[must_use]
pub const fn from_int(v: i32) -> Fx {
    if v > 32767 {
        Fx::MAX
    } else if v < -32768 {
        Fx::MIN
    } else {
        v << FRAC_BITS
    }
}

/// Convert a ratio `num / den` to Q16.16. `den == 0` yields 0.
#[inline]
#[must_use]
pub const fn from_ratio(num: i32, den: i32) -> Fx {
    if den == 0 {
        return 0;
    }
    let p = ((num as i64) << FRAC_BITS) / (den as i64);
    clamp_i64(p)
}

/// Floor towards negative infinity (arithmetic shift), giving the containing cell.
#[inline]
#[must_use]
pub const fn floor_int(v: Fx) -> i32 {
    v >> FRAC_BITS
}

/// Round to nearest, halves away from negative infinity.
#[inline]
#[must_use]
pub const fn round_int(v: Fx) -> i32 {
    (v.saturating_add(HALF)) >> FRAC_BITS
}

/// The fractional part, always in `0..ONE` even for negative values.
#[inline]
#[must_use]
pub const fn frac(v: Fx) -> Fx {
    v & FRAC_MASK
}

#[inline]
const fn clamp_i64(p: i64) -> Fx {
    if p > Fx::MAX as i64 {
        Fx::MAX
    } else if p < Fx::MIN as i64 {
        Fx::MIN
    } else {
        p as Fx
    }
}

/// Multiply, via a 64-bit intermediate, saturating on overflow.
#[inline]
#[must_use]
pub const fn mul(a: Fx, b: Fx) -> Fx {
    clamp_i64(((a as i64) * (b as i64)) >> FRAC_BITS)
}

/// Divide, via a 64-bit intermediate. `b == 0` yields 0.
#[inline]
#[must_use]
pub const fn div(a: Fx, b: Fx) -> Fx {
    if b == 0 {
        return 0;
    }
    // i32::MIN / -1 would overflow the i32 result; the i64 intermediate plus
    // the clamp handles it without a special case.
    clamp_i64(((a as i64) << FRAC_BITS) / (b as i64))
}

/// Saturating add.
#[inline]
#[must_use]
pub const fn add(a: Fx, b: Fx) -> Fx {
    a.saturating_add(b)
}

/// Saturating subtract.
#[inline]
#[must_use]
pub const fn sub(a: Fx, b: Fx) -> Fx {
    a.saturating_sub(b)
}

/// Multiply a Q16.16 value by a plain integer, saturating.
#[inline]
#[must_use]
pub const fn scale(a: Fx, k: i32) -> Fx {
    clamp_i64((a as i64) * (k as i64))
}

/// Absolute value, saturating (`|i32::MIN|` clamps to `i32::MAX`).
#[inline]
#[must_use]
pub const fn abs(a: Fx) -> Fx {
    if a < 0 { a.saturating_neg() } else { a }
}

/// Clamp into `[lo, hi]`. `lo > hi` yields `lo`.
#[inline]
#[must_use]
pub const fn clamp(v: Fx, lo: Fx, hi: Fx) -> Fx {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Linear interpolation, `t` in Q16.16 and clamped to `[0, 1]`.
#[inline]
#[must_use]
pub const fn lerp(a: Fx, b: Fx, t: Fx) -> Fx {
    let t = clamp(t, 0, ONE);
    add(a, mul(sub(b, a), t))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::Rng;
    use std::vec::Vec;

    /// Reference multiply computed independently of the implementation.
    fn ref_mul(a: i64, b: i64) -> i64 {
        (a * b) >> 16
    }

    /// Edge cases first, then a deterministic pseudo-random sweep. There is no
    /// `rand` dependency and no wall-clock seed: a property test that is not
    /// itself reproducible cannot guard a determinism invariant.
    const EDGES: [Fx; 17] = [
        0,
        1,
        -1,
        ONE,
        -ONE,
        HALF,
        -HALF,
        ONE - 1,
        -(ONE - 1),
        Fx::MAX,
        Fx::MIN,
        Fx::MAX - 1,
        Fx::MIN + 1,
        1 << 30,
        -(1 << 30),
        0x7FFF_0000u32 as i32,
        0x0001_0001,
    ];

    fn sample_values(n: usize, seed: u64) -> Vec<Fx> {
        let mut rng = Rng::new(seed);
        let mut v = Vec::with_capacity(EDGES.len() + n);
        v.extend_from_slice(&EDGES);
        for _ in 0..n {
            v.push(rng.next_u32() as i32);
        }
        v
    }

    fn expected_sat(want: i64) -> Fx {
        if want > i64::from(Fx::MAX) {
            Fx::MAX
        } else if want < i64::from(Fx::MIN) {
            Fx::MIN
        } else {
            want as Fx
        }
    }

    #[test]
    fn mul_matches_64bit_reference_and_saturates() {
        let vs = sample_values(1200, 0x0D10_1A20);
        for &a in &vs {
            for &b in &vs {
                assert_eq!(mul(a, b), expected_sat(ref_mul(a as i64, b as i64)), "mul({a}, {b})");
            }
        }
    }

    #[test]
    fn one_is_the_multiplicative_identity() {
        for a in sample_values(200_000, 0x0D10_1A21) {
            assert_eq!(mul(a, ONE), a, "mul({a}, ONE)");
            assert_eq!(mul(ONE, a), a, "mul(ONE, {a})");
        }
    }

    #[test]
    fn mul_is_commutative() {
        let vs = sample_values(1200, 0x0D10_1A22);
        for &a in &vs {
            for &b in &vs {
                assert_eq!(mul(a, b), mul(b, a), "mul({a}, {b})");
            }
        }
    }

    #[test]
    fn int_roundtrip() {
        for v in -32768..=32767 {
            assert_eq!(floor_int(from_int(v)), v);
            assert_eq!(round_int(from_int(v)), v);
        }
    }

    #[test]
    fn floor_is_floor_not_truncation() {
        // -0.5 must floor to -1, not to 0. Truncation here would make walkers
        // stutter across the x = 0 line.
        assert_eq!(floor_int(-HALF), -1);
        assert_eq!(floor_int(-ONE - HALF), -2);
        assert_eq!(floor_int(HALF), 0);
        assert_eq!(frac(-HALF), HALF);
        assert_eq!(frac(-ONE), 0);
    }

    #[test]
    fn div_then_mul_roundtrips_within_the_truncation_bound() {
        let mut rng = Rng::new(0xBEEF_0001);
        for _ in 0..200_000 {
            // `div` shifts `a` left by 16 before dividing, so `a` must stay
            // small enough that the quotient fits in i32 for *any* divisor —
            // otherwise the saturation clamp fires and the roundtrip is
            // meaningless rather than wrong.
            let a = (rng.next_u32() as i32) >> 18;
            let b = ((rng.next_u32() as i32) >> 20) | 1;
            let q = div(a, b);
            let back = mul(q, b);
            // `div` truncates towards zero and so does `mul`; the composed error
            // is bounded by one ulp of each, i.e. |b| >> 16 plus one.
            let bound = i64::from(b.unsigned_abs() >> 16) + 2;
            let err = (i64::from(back) - i64::from(a)).abs();
            assert!(err <= bound, "a={a} b={b} q={q} back={back} err={err} bound={bound}");
        }
    }

    #[test]
    fn div_by_zero_is_zero_not_a_panic() {
        for a in sample_values(20_000, 0x0D10_1A23) {
            assert_eq!(div(a, 0), 0);
            assert_eq!(from_ratio(a, 0), 0);
        }
    }

    #[test]
    fn min_over_minus_one_saturates_instead_of_overflowing() {
        assert_eq!(div(Fx::MIN, -ONE), Fx::MAX);
        assert_eq!(abs(Fx::MIN), Fx::MAX);
    }

    #[test]
    fn add_sub_saturate() {
        assert_eq!(add(Fx::MAX, ONE), Fx::MAX);
        assert_eq!(sub(Fx::MIN, ONE), Fx::MIN);
        for a in sample_values(50_000, 0x0D10_1A24) {
            if (Fx::MIN + ONE..=Fx::MAX - ONE).contains(&a) {
                assert_eq!(sub(add(a, ONE), ONE), a);
            }
        }
    }

    #[test]
    fn lerp_endpoints_are_exact() {
        let mut rng = Rng::new(0x1234_5678);
        for _ in 0..50_000 {
            let a = (rng.next_u32() as i32) >> 8;
            let b = (rng.next_u32() as i32) >> 8;
            assert_eq!(lerp(a, b, 0), a);
            assert_eq!(lerp(a, b, ONE), b);
            // Out-of-range t clamps rather than extrapolating.
            assert_eq!(lerp(a, b, -ONE), a);
            assert_eq!(lerp(a, b, ONE * 4), b);
        }
    }
}
