//! diomano — the entire simulation.
//!
//! This crate knows nothing about WebAssembly, the browser or Three.js. It
//! compiles to `wasm32-unknown-unknown` behind a thin `extern "C"` shell and to
//! a native binary for the replay verifier, from the same source. That split is
//! the only reason determinism is *verifiable* rather than merely intended
//! (HANDOFF §9.2), so it must not be collapsed.
//!
//! # Determinism
//!
//! HANDOFF §10 lists the rules. The ones enforced mechanically here:
//!
//! - `#![no_std]` — `std::collections::HashMap`/`HashSet` are not in scope at
//!   all, so the "no hash containers" rule cannot be broken by accident. The
//!   `clippy.toml` `disallowed-types` entry catches the `std`-linked crates.
//! - `clippy::float_arithmetic` is denied crate-wide. The single exception is
//!   [`mesh`], which is render code by §10's own wording ("`f32`/`f64` in render
//!   code only") and carries an explicit allow plus a note about why its output
//!   never re-enters simulation state.
//! - `overflow-checks` is on in *every* profile (see the workspace `Cargo.toml`)
//!   so debug and release agree bit-for-bit.
//! - One seeded PRNG, [`hash::Rng`], stored in the world and advanced only from
//!   tick passes.
//! - Fixed neighbour order (N, E, S, W) via [`seams::DIR_DX`]/[`seams::DIR_DY`].
//! - Fixed tick pass order in [`world::World::tick`].
//! - Combat resolution ordered exactly as §4.7 requires; see [`combat`].
//!
//! # Shape
//!
//! The simulation advances by `tick(commands: &[Command])` and nothing else.
//! Netcode, when it arrives, changes where that slice comes from and nothing
//! about what happens to it.

#![no_std]
#![deny(clippy::float_arithmetic)]
#![forbid(clippy::mem_forget)]

#[cfg(feature = "alloc")]
extern crate alloc;

#[cfg(test)]
extern crate std;

pub mod ai;
pub mod combat;
pub mod fixed;
pub mod flowfield;
pub mod hash;
pub mod materials;
pub mod mesh;
pub mod powers;
pub mod seams;
pub mod settlements;
pub mod tide;
pub mod walkers;
pub mod water;
pub mod world;

pub use world::{Command, MapConfig, World};

/// Simulation rate. Fixed, forever (§4.1): reducing it would change game feel
/// and invalidate every tuning value in the spec. If the budget is exceeded,
/// reduce `N`.
pub const TICK_HZ: u32 = 30;

/// Crate version, for the version string the CLI prints.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod determinism;
