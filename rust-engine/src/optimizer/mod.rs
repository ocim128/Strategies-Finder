//! Optimizer Module
//!
//! Walk-forward analysis and strategy finder with parallel execution.
mod finder;
mod walk_forward;
pub use finder::{run_finder, FinderRunner};
pub use walk_forward::{run_walk_forward, WalkForwardRunner};
