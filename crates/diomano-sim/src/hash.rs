//! State hashing and the one seeded simulation PRNG.
//!
//! HANDOFF §6.3: hash the terrain arrays plus walker and settlement state every
//! 30 ticks; the terrain arrays are extremely sensitive to divergence, which
//! makes them a near-ideal checksum.
//!
//! HANDOFF §10: exactly one seeded PRNG for the simulation, advanced only on
//! tick boundaries. The render PRNG lives in TypeScript and never touches this.

/// FNV-1a, 64-bit.
///
/// Chosen over xxhash for the same reason `wasm-bindgen` was chosen against:
/// it is twenty lines we own, with no dependency and no chance of a version
/// bump silently changing the hash of a recorded fixture.
#[derive(Clone, Copy, Debug)]
pub struct Fnv64(u64);

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

impl Default for Fnv64 {
    fn default() -> Self {
        Self::new()
    }
}

impl Fnv64 {
    #[inline]
    #[must_use]
    pub const fn new() -> Self {
        Self(FNV_OFFSET)
    }

    #[inline]
    pub const fn write_u8(&mut self, v: u8) {
        self.0 ^= v as u64;
        self.0 = self.0.wrapping_mul(FNV_PRIME);
    }

    #[inline]
    pub const fn write_u16(&mut self, v: u16) {
        self.write_u8(v as u8);
        self.write_u8((v >> 8) as u8);
    }

    #[inline]
    pub const fn write_u32(&mut self, v: u32) {
        self.write_u16(v as u16);
        self.write_u16((v >> 16) as u16);
    }

    #[inline]
    pub const fn write_u64(&mut self, v: u64) {
        self.write_u32(v as u32);
        self.write_u32((v >> 32) as u32);
    }

    #[inline]
    pub const fn write_i8(&mut self, v: i8) {
        self.write_u8(v as u8);
    }

    #[inline]
    pub const fn write_i16(&mut self, v: i16) {
        self.write_u16(v as u16);
    }

    #[inline]
    pub const fn write_i32(&mut self, v: i32) {
        self.write_u32(v as u32);
    }

    pub fn write_u8s(&mut self, v: &[u8]) {
        for &b in v {
            self.write_u8(b);
        }
    }

    pub fn write_i16s(&mut self, v: &[i16]) {
        for &b in v {
            self.write_i16(b);
        }
    }

    pub fn write_i8s(&mut self, v: &[i8]) {
        for &b in v {
            self.write_i8(b);
        }
    }

    #[inline]
    #[must_use]
    pub const fn finish(self) -> u64 {
        self.0
    }
}

/// `SplitMix64`. The single simulation PRNG (HANDOFF §10).
///
/// Deliberately a value type with an explicit `&mut self`: there is no global
/// or thread-local instance to accidentally advance from a render callback.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct Rng {
    pub state: u64,
}

impl Rng {
    #[inline]
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        // A zero seed is legal for SplitMix64, but seeding it away from zero
        // keeps the first few outputs from being suspiciously small.
        Self { state: seed ^ 0x9E37_79B9_7F4A_7C15 }
    }

    #[inline]
    pub const fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    #[inline]
    pub const fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform in `0..bound` (bound > 0), by Lemire's multiply-shift.
    /// Rejection-free, so the number of PRNG draws is a function of the inputs
    /// only — which matters, because a variable draw count would desync.
    #[inline]
    pub const fn below(&mut self, bound: u32) -> u32 {
        if bound == 0 {
            return 0;
        }
        (((self.next_u32() as u64) * (bound as u64)) >> 32) as u32
    }

    /// Uniform in `lo..=hi`.
    #[inline]
    pub const fn range(&mut self, lo: i32, hi: i32) -> i32 {
        if hi <= lo {
            return lo;
        }
        lo.wrapping_add(self.below((hi - lo + 1) as u32) as i32)
    }
}

/// A cheap integer hash of three coordinates, used by the terrain generator.
///
/// Not a PRNG: it must be a pure function of position so that terrain is
/// identical no matter what order cells are visited in.
#[inline]
#[must_use]
pub const fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u32 {
    let mut h = Fnv64::new();
    h.write_i32(x);
    h.write_i32(y);
    h.write_i32(z);
    h.write_u32(seed);
    let v = h.finish();
    ((v >> 32) as u32) ^ (v as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::vec::Vec;

    #[test]
    fn fnv_matches_known_vectors() {
        // Reference vectors for FNV-1a 64 over ASCII input.
        let mut h = Fnv64::new();
        assert_eq!(h.finish(), 0xcbf2_9ce4_8422_2325);
        h.write_u8s(b"a");
        assert_eq!(h.finish(), 0xaf63_dc4c_8601_ec8c);
        let mut h = Fnv64::new();
        h.write_u8s(b"foobar");
        assert_eq!(h.finish(), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn fnv_is_order_sensitive() {
        let mut a = Fnv64::new();
        a.write_u8s(&[1, 2]);
        let mut b = Fnv64::new();
        b.write_u8s(&[2, 1]);
        assert_ne!(a.finish(), b.finish());
    }

    #[test]
    fn fnv_width_helpers_agree_with_little_endian_bytes() {
        let mut a = Fnv64::new();
        a.write_u32(0x1234_5678);
        let mut b = Fnv64::new();
        b.write_u8s(&0x1234_5678u32.to_le_bytes());
        assert_eq!(a.finish(), b.finish());

        let mut a = Fnv64::new();
        a.write_i16(-2);
        let mut b = Fnv64::new();
        b.write_u8s(&(-2i16).to_le_bytes());
        assert_eq!(a.finish(), b.finish());
    }

    #[test]
    fn rng_is_reproducible_and_does_not_repeat_early() {
        let a: Vec<u64> = {
            let mut r = Rng::new(42);
            (0..4096).map(|_| r.next_u64()).collect()
        };
        let b: Vec<u64> = {
            let mut r = Rng::new(42);
            (0..4096).map(|_| r.next_u64()).collect()
        };
        assert_eq!(a, b);
        let uniq: BTreeSet<u64> = a.iter().copied().collect();
        assert_eq!(uniq.len(), a.len(), "SplitMix64 must not repeat within 4096 draws");

        let c: Vec<u64> = {
            let mut r = Rng::new(43);
            (0..64).map(|_| r.next_u64()).collect()
        };
        assert_ne!(a[..64], c[..]);
    }

    #[test]
    fn below_stays_in_range_and_is_roughly_uniform() {
        let mut r = Rng::new(7);
        let mut buckets = [0u32; 6];
        for _ in 0..600_000 {
            let v = r.below(6) as usize;
            assert!(v < 6);
            buckets[v] += 1;
        }
        for b in buckets {
            assert!((90_000..110_000).contains(&b), "bucket skew: {buckets:?}");
        }
        assert_eq!(r.below(0), 0);
        assert_eq!(r.below(1), 0);
    }

    #[test]
    fn range_is_inclusive_and_handles_inverted_bounds() {
        let mut r = Rng::new(9);
        let mut saw_lo = false;
        let mut saw_hi = false;
        for _ in 0..10_000 {
            let v = r.range(-3, 3);
            assert!((-3..=3).contains(&v));
            saw_lo |= v == -3;
            saw_hi |= v == 3;
        }
        assert!(saw_lo && saw_hi);
        assert_eq!(r.range(5, 5), 5);
        assert_eq!(r.range(5, 1), 5);
    }

    #[test]
    fn hash3_is_a_pure_function_of_position() {
        assert_eq!(hash3(1, 2, 3, 0x5EED), hash3(1, 2, 3, 0x5EED));
        assert_ne!(hash3(1, 2, 3, 1), hash3(3, 2, 1, 1));
        assert_ne!(hash3(1, 2, 3, 1), hash3(1, 2, 3, 2));
        assert_ne!(hash3(-1, 0, 0, 1), hash3(1, 0, 0, 1));
    }
}
