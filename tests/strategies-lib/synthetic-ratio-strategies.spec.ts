import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, StrategyParams, Time } from "../../lib/types/strategies";
import { body_proportion_percentile_fade } from "../../lib/strategies/lib/body_proportion_percentile_fade";
import { cumulative_return_percentile_reversion } from "../../lib/strategies/lib/cumulative_return_percentile_reversion";
import { return_sign_streak_fade } from "../../lib/strategies/lib/return_sign_streak_fade";
import { variance_ratio_velocity_divergence_fade } from "../../lib/strategies/lib/variance_ratio_velocity_divergence_fade";
import { variance_ratio_subdiffusive_streak_fade } from "../../lib/strategies/lib/variance_ratio_subdiffusive_streak_fade";
import { sweep_reclaim_solid_body_power_veto } from "../../lib/strategies/lib/sweep_reclaim_solid_body_power_veto";
import { sweep_reclaim_gap_acceleration_step } from "../../lib/strategies/lib/sweep_reclaim_gap_acceleration_step";
import { adjacent_overlap_progressive_peeling_thrust } from "../../lib/strategies/lib/adjacent_overlap_progressive_peeling_thrust";
import { adjacent_range_gap_open_intrabar_reclaim } from "../../lib/strategies/lib/adjacent_range_gap_open_intrabar_reclaim";
import { window_giveback_median_percentile_flow } from "../../lib/strategies/lib/window_giveback_median_percentile_flow";
import { window_giveback_fib_double_touch_bounce } from "../../lib/strategies/lib/window_giveback_fib_double_touch_bounce";
import { extreme_age_relative_temporal_ratio } from "../../lib/strategies/lib/extreme_age_relative_temporal_ratio";
import { extreme_age_high_shelf_consolidation_thrust } from "../../lib/strategies/lib/extreme_age_high_shelf_consolidation_thrust";
import { variance_ratio_expansion_flip } from "../../lib/strategies/lib/variance_ratio_expansion_flip";
import { variance_ratio_subdiffusive_fade } from "../../lib/strategies/lib/variance_ratio_subdiffusive_fade";
import { sweep_reclaim_liquidity_snap } from "../../lib/strategies/lib/sweep_reclaim_liquidity_snap";
import { sweep_reclaim_delayed_acceptance } from "../../lib/strategies/lib/sweep_reclaim_delayed_acceptance";
import { adjacent_range_expansion_thrust } from "../../lib/strategies/lib/adjacent_range_expansion_thrust";
import { adjacent_overlap_compression_breakout } from "../../lib/strategies/lib/adjacent_overlap_compression_breakout";
import { window_giveback_fib_failure } from "../../lib/strategies/lib/window_giveback_fib_failure";
import { window_giveback_fib_continuation } from "../../lib/strategies/lib/window_giveback_fib_continuation";
import { extreme_age_fresh_reversal_fade } from "../../lib/strategies/lib/extreme_age_fresh_reversal_fade";
import { extreme_age_asymmetry_breakout } from "../../lib/strategies/lib/extreme_age_asymmetry_breakout";
import { variance_ratio_term_structure_slope } from "../../lib/strategies/lib/variance_ratio_term_structure_slope";
import { variance_ratio_velocity_surge } from "../../lib/strategies/lib/variance_ratio_velocity_surge";
import { sweep_reclaim_percentile_exhaustion } from "../../lib/strategies/lib/sweep_reclaim_percentile_exhaustion";
import { sweep_reclaim_absorption_cluster } from "../../lib/strategies/lib/sweep_reclaim_absorption_cluster";
import { adjacent_range_gap_exhaustion_fade } from "../../lib/strategies/lib/adjacent_range_gap_exhaustion_fade";
import { adjacent_range_balance_bracket_fade } from "../../lib/strategies/lib/adjacent_range_balance_bracket_fade";
import { window_giveback_round_trip_reversal } from "../../lib/strategies/lib/window_giveback_round_trip_reversal";
import { window_giveback_velocity_capitulation } from "../../lib/strategies/lib/window_giveback_velocity_capitulation";
import { extreme_age_stale_boundary_breach } from "../../lib/strategies/lib/extreme_age_stale_boundary_breach";
import { extreme_age_compression_glide } from "../../lib/strategies/lib/extreme_age_compression_glide";
import { variance_ratio_regime_continuation } from "../../lib/strategies/lib/variance_ratio_regime_continuation";
import { variance_ratio_efficiency_orthogonal_router } from "../../lib/strategies/lib/variance_ratio_efficiency_orthogonal_router";
import { sweep_reclaim_asymmetric_cleanliness } from "../../lib/strategies/lib/sweep_reclaim_asymmetric_cleanliness";
import { sweep_reclaim_compression_gate } from "../../lib/strategies/lib/sweep_reclaim_compression_gate";
import { adjacent_range_zero_overlap_breakout } from "../../lib/strategies/lib/adjacent_range_zero_overlap_breakout";
import { adjacent_overlap_relative_choke } from "../../lib/strategies/lib/adjacent_overlap_relative_choke";
import { window_giveback_directional_asymmetry } from "../../lib/strategies/lib/window_giveback_directional_asymmetry";
import { window_giveback_distribution_climax } from "../../lib/strategies/lib/window_giveback_distribution_climax";
import { extreme_age_fresh_thrust_acceptance } from "../../lib/strategies/lib/extreme_age_fresh_thrust_acceptance";
import { extreme_age_consolidation_decay_fade } from "../../lib/strategies/lib/extreme_age_consolidation_decay_fade";
import { variance_ratio_inverted_term_fade } from "../../lib/strategies/lib/variance_ratio_inverted_term_fade";
import { variance_ratio_subdiffusive_entry_flip } from "../../lib/strategies/lib/variance_ratio_subdiffusive_entry_flip";
import { sweep_reclaim_failed_spring_trap } from "../../lib/strategies/lib/sweep_reclaim_failed_spring_trap";
import { sweep_reclaim_acceptance_gradient } from "../../lib/strategies/lib/sweep_reclaim_acceptance_gradient";
import { adjacent_overlap_coiled_prebreakout } from "../../lib/strategies/lib/adjacent_overlap_coiled_prebreakout";
import { adjacent_range_runaway_gap_continuation } from "../../lib/strategies/lib/adjacent_range_runaway_gap_continuation";
import { window_giveback_golden_pocket_reclaim } from "../../lib/strategies/lib/window_giveback_golden_pocket_reclaim";
import { window_giveback_full_cascade_breakthrough } from "../../lib/strategies/lib/window_giveback_full_cascade_breakthrough";
import { extreme_age_blowoff_divergence_fade } from "../../lib/strategies/lib/extreme_age_blowoff_divergence_fade";
import { extreme_age_stale_false_break_fade } from "../../lib/strategies/lib/extreme_age_stale_false_break_fade";
import { variance_ratio_dispersion_halt_fade } from "../../lib/strategies/lib/variance_ratio_dispersion_halt_fade";
import { variance_ratio_subdiffusive_boundary_ping } from "../../lib/strategies/lib/variance_ratio_subdiffusive_boundary_ping";
import { sweep_reclaim_alternating_ping_pong } from "../../lib/strategies/lib/sweep_reclaim_alternating_ping_pong";
import { sweep_reclaim_wick_dominant_absorption } from "../../lib/strategies/lib/sweep_reclaim_wick_dominant_absorption";
import { adjacent_overlap_waterfall_continuation } from "../../lib/strategies/lib/adjacent_overlap_waterfall_continuation";
import { adjacent_overlap_structural_trend_channel } from "../../lib/strategies/lib/adjacent_overlap_structural_trend_channel";
import { window_giveback_shallow_momentum_hold } from "../../lib/strategies/lib/window_giveback_shallow_momentum_hold";
import { window_giveback_acceleration_thrust } from "../../lib/strategies/lib/window_giveback_acceleration_thrust";
import { extreme_age_micro_double_top_fade } from "../../lib/strategies/lib/extreme_age_micro_double_top_fade";
import { extreme_age_volatility_reset_breakout } from "../../lib/strategies/lib/extreme_age_volatility_reset_breakout";
import { variance_ratio_stealth_drift_continuation } from "../../lib/strategies/lib/variance_ratio_stealth_drift_continuation";
import { variance_ratio_subdiffusive_floor_rubberband } from "../../lib/strategies/lib/variance_ratio_subdiffusive_floor_rubberband";
import { sweep_reclaim_hyper_climax_fade } from "../../lib/strategies/lib/sweep_reclaim_hyper_climax_fade";
import { sweep_reclaim_void_breakout } from "../../lib/strategies/lib/sweep_reclaim_void_breakout";
import { adjacent_overlap_containment_coiler } from "../../lib/strategies/lib/adjacent_overlap_containment_coiler";
import { adjacent_overlap_exhaustion_dispersion_fade } from "../../lib/strategies/lib/adjacent_overlap_exhaustion_dispersion_fade";
import { window_giveback_midpoint_pivot_bounce } from "../../lib/strategies/lib/window_giveback_midpoint_pivot_bounce";
import { window_giveback_momentum_asymmetry_filter } from "../../lib/strategies/lib/window_giveback_momentum_asymmetry_filter";
import { extreme_age_symmetrical_collapse_thrust } from "../../lib/strategies/lib/extreme_age_symmetrical_collapse_thrust";
import { extreme_age_youthful_regime_ride } from "../../lib/strategies/lib/extreme_age_youthful_regime_ride";
import { variance_ratio_brownian_symmetry_break } from "../../lib/strategies/lib/variance_ratio_brownian_symmetry_break";
import { variance_ratio_bifurcation_crossover } from "../../lib/strategies/lib/variance_ratio_bifurcation_crossover";
import { sweep_reclaim_defended_floor_collapse } from "../../lib/strategies/lib/sweep_reclaim_defended_floor_collapse";
import { sweep_reclaim_rest_bar_coiling } from "../../lib/strategies/lib/sweep_reclaim_rest_bar_coiling";
import { adjacent_overlap_stalled_thrust_fade } from "../../lib/strategies/lib/adjacent_overlap_stalled_thrust_fade";
import { adjacent_range_gap_fill_rejection } from "../../lib/strategies/lib/adjacent_range_gap_fill_rejection";
import { window_giveback_anchor_turn_impulse } from "../../lib/strategies/lib/window_giveback_anchor_turn_impulse";
import { window_giveback_deep_value_discount } from "../../lib/strategies/lib/window_giveback_deep_value_discount";
import { extreme_age_marginal_probe_exhaustion } from "../../lib/strategies/lib/extreme_age_marginal_probe_exhaustion";
import { extreme_age_dual_stale_coil_release } from "../../lib/strategies/lib/extreme_age_dual_stale_coil_release";
import { variance_ratio_convexity_acceleration } from "../../lib/strategies/lib/variance_ratio_convexity_acceleration";
import { variance_ratio_anti_persistence_trap_fade } from "../../lib/strategies/lib/variance_ratio_anti_persistence_trap_fade";
import { sweep_reclaim_body_engulf_veto } from "../../lib/strategies/lib/sweep_reclaim_body_engulf_veto";
import { sweep_reclaim_trend_pullback_flush } from "../../lib/strategies/lib/sweep_reclaim_trend_pullback_flush";
import { adjacent_overlap_step_and_settle } from "../../lib/strategies/lib/adjacent_overlap_step_and_settle";
import { adjacent_overlap_regime_thaw_momentum } from "../../lib/strategies/lib/adjacent_overlap_regime_thaw_momentum";
import { window_giveback_golden_pocket_springboard } from "../../lib/strategies/lib/window_giveback_golden_pocket_springboard";
import { window_giveback_velocity_arrest_reversal } from "../../lib/strategies/lib/window_giveback_velocity_arrest_reversal";
import { extreme_age_consecutive_fresh_snowball } from "../../lib/strategies/lib/extreme_age_consecutive_fresh_snowball";
import { extreme_age_rapid_inversion_pivot } from "../../lib/strategies/lib/extreme_age_rapid_inversion_pivot";
import { variance_ratio_scale_invariant_lock } from "../../lib/strategies/lib/variance_ratio_scale_invariant_lock";
import { variance_ratio_superdiffusive_blowoff_ride } from "../../lib/strategies/lib/variance_ratio_superdiffusive_blowoff_ride";
import { sweep_reclaim_absorption_asymmetry_skew } from "../../lib/strategies/lib/sweep_reclaim_absorption_asymmetry_skew";
import { sweep_reclaim_micro_probe_exhaustion } from "../../lib/strategies/lib/sweep_reclaim_micro_probe_exhaustion";
import { adjacent_overlap_harmonic_step_advance } from "../../lib/strategies/lib/adjacent_overlap_harmonic_step_advance";
import { adjacent_range_island_reversal_gap } from "../../lib/strategies/lib/adjacent_range_island_reversal_gap";
import { window_giveback_dynamic_scale_inversion } from "../../lib/strategies/lib/window_giveback_dynamic_scale_inversion";
import { window_giveback_deep_fib_last_stand } from "../../lib/strategies/lib/window_giveback_deep_fib_last_stand";
import { extreme_age_stale_retest_springboard } from "../../lib/strategies/lib/extreme_age_stale_retest_springboard";
import { extreme_age_perimeter_knock_breakout } from "../../lib/strategies/lib/extreme_age_perimeter_knock_breakout";
import { variance_ratio_subdiffusive_exit_surge } from "../../lib/strategies/lib/variance_ratio_subdiffusive_exit_surge";
import { variance_ratio_subdiffusive_exhaustion_wick } from "../../lib/strategies/lib/variance_ratio_subdiffusive_exhaustion_wick";
import { sweep_reclaim_zero_top_wick_shave } from "../../lib/strategies/lib/sweep_reclaim_zero_top_wick_shave";
import { sweep_reclaim_higher_low_confirmation } from "../../lib/strategies/lib/sweep_reclaim_higher_low_confirmation";
import { adjacent_overlap_rotational_drive_thrust } from "../../lib/strategies/lib/adjacent_overlap_rotational_drive_thrust";
import { adjacent_overlap_percentile_drop_release } from "../../lib/strategies/lib/adjacent_overlap_percentile_drop_release";
import { window_giveback_total_wipeout_rebound } from "../../lib/strategies/lib/window_giveback_total_wipeout_rebound";
import { window_giveback_stairstep_body_dominance } from "../../lib/strategies/lib/window_giveback_stairstep_body_dominance";
import { extreme_age_marubozu_fresh_thrust } from "../../lib/strategies/lib/extreme_age_marubozu_fresh_thrust";
import { extreme_age_exhaustion_wick_spike_fade } from "../../lib/strategies/lib/extreme_age_exhaustion_wick_spike_fade";
import { variance_ratio_multi_bar_slope_surge } from "../../lib/strategies/lib/variance_ratio_multi_bar_slope_surge";
import { variance_ratio_superdiffusive_median_retest } from "../../lib/strategies/lib/variance_ratio_superdiffusive_median_retest";
import { sweep_reclaim_absorption_decay_fade } from "../../lib/strategies/lib/sweep_reclaim_absorption_decay_fade";
import { sweep_reclaim_zscore_liquidity_spike } from "../../lib/strategies/lib/sweep_reclaim_zscore_liquidity_spike";
import { adjacent_overlap_coagulation_continuation } from "../../lib/strategies/lib/adjacent_overlap_coagulation_continuation";
import { adjacent_overlap_goldilocks_trend_channel } from "../../lib/strategies/lib/adjacent_overlap_goldilocks_trend_channel";
import { window_giveback_two_bar_breakdown_lock } from "../../lib/strategies/lib/window_giveback_two_bar_breakdown_lock";
import { window_giveback_abrupt_trend_fracture } from "../../lib/strategies/lib/window_giveback_abrupt_trend_fracture";
import { extreme_age_symmetric_age_convergence_break } from "../../lib/strategies/lib/extreme_age_symmetric_age_convergence_break";
import { extreme_age_stale_break_runaway_step } from "../../lib/strategies/lib/extreme_age_stale_break_runaway_step";
import { variance_ratio_term_crossover_impulse } from "../../lib/strategies/lib/variance_ratio_term_crossover_impulse";
import { variance_ratio_superdiffusive_coil_break } from "../../lib/strategies/lib/variance_ratio_superdiffusive_coil_break";
import { sweep_reclaim_two_sided_dominance } from "../../lib/strategies/lib/sweep_reclaim_two_sided_dominance";
import { sweep_reclaim_low_efficiency_recycle } from "../../lib/strategies/lib/sweep_reclaim_low_efficiency_recycle";
import { adjacent_overlap_containment_detonation } from "../../lib/strategies/lib/adjacent_overlap_containment_detonation";
import { adjacent_overlap_expansion_wick_reversal } from "../../lib/strategies/lib/adjacent_overlap_expansion_wick_reversal";
import { window_giveback_exhausted_breakdown_fade } from "../../lib/strategies/lib/window_giveback_exhausted_breakdown_fade";
import { window_giveback_volatility_scaled_tolerance } from "../../lib/strategies/lib/window_giveback_volatility_scaled_tolerance";
import { extreme_age_body_surge_breakout } from "../../lib/strategies/lib/extreme_age_body_surge_breakout";
import { extreme_age_engulfing_fresh_trap_fade } from "../../lib/strategies/lib/extreme_age_engulfing_fresh_trap_fade";

type StrategySmokeCase = {
    key: string;
    strategy: Strategy;
    input: Record<string, string>;
    expected: Record<string, number>;
};

// Only the strategies that survived the 89-candidate cull (43caa6d "new lib")
// remain; culled candidates were removed from the manifest and their smoke
// cases deleted with them.
const CASES: StrategySmokeCase[] = [
    { key: "return_sign_streak_fade", strategy: return_sign_streak_fade, input: { lookback: "3.2", streakMin: "4.7" }, expected: { lookback: 3, streakMin: 5 } },
    { key: "cumulative_return_percentile_reversion", strategy: cumulative_return_percentile_reversion, input: { lookback: "20.1", pctlExtreme: "0.95" }, expected: { lookback: 20, pctlExtreme: 0.95 } },
    { key: "body_proportion_percentile_fade", strategy: body_proportion_percentile_fade, input: { lookback: "25", pctlExtreme: "0.80" }, expected: { lookback: 25, pctlExtreme: 0.8 } },
    { key: "variance_ratio_velocity_divergence_fade", strategy: variance_ratio_velocity_divergence_fade, input: { divergence_threshold: "0.2" }, expected: { divergence_threshold: 0.2 } },
    { key: "variance_ratio_subdiffusive_streak_fade", strategy: variance_ratio_subdiffusive_streak_fade, input: { min_streak: "4.8" }, expected: { min_streak: 5 } },
    { key: "sweep_reclaim_solid_body_power_veto", strategy: sweep_reclaim_solid_body_power_veto, input: { min_body_pct: "0.65" }, expected: { min_body_pct: 0.65 } },
    { key: "sweep_reclaim_gap_acceleration_step", strategy: sweep_reclaim_gap_acceleration_step, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "adjacent_overlap_progressive_peeling_thrust", strategy: adjacent_overlap_progressive_peeling_thrust, input: { max_final_overlap: "0.25" }, expected: { max_final_overlap: 0.25 } },
    { key: "adjacent_range_gap_open_intrabar_reclaim", strategy: adjacent_range_gap_open_intrabar_reclaim, input: { gap_threshold: "0.08" }, expected: { gap_threshold: 0.08 } },
    { key: "window_giveback_median_percentile_flow", strategy: window_giveback_median_percentile_flow, input: { lookback: "35.2" }, expected: { lookback: 35 } },
    { key: "window_giveback_fib_double_touch_bounce", strategy: window_giveback_fib_double_touch_bounce, input: { lookback: "28.9" }, expected: { lookback: 29 } },
    { key: "extreme_age_relative_temporal_ratio", strategy: extreme_age_relative_temporal_ratio, input: { age_ratio_threshold: "5.5" }, expected: { age_ratio_threshold: 5.5 } },
    { key: "extreme_age_high_shelf_consolidation_thrust", strategy: extreme_age_high_shelf_consolidation_thrust, input: { lookback: "21.6" }, expected: { lookback: 22 } },
    { key: "variance_ratio_expansion_flip", strategy: variance_ratio_expansion_flip, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "variance_ratio_subdiffusive_fade", strategy: variance_ratio_subdiffusive_fade, input: { lookback: "40.4" }, expected: { lookback: 40 } },
    { key: "sweep_reclaim_liquidity_snap", strategy: sweep_reclaim_liquidity_snap, input: { threshold: "0.42" }, expected: { threshold: 0.42 } },
    { key: "sweep_reclaim_delayed_acceptance", strategy: sweep_reclaim_delayed_acceptance, input: { min_score: "0.35" }, expected: { min_score: 0.35 } },
    { key: "adjacent_range_expansion_thrust", strategy: adjacent_range_expansion_thrust, input: { max_overlap: "0.2" }, expected: { max_overlap: 0.2 } },
    { key: "adjacent_overlap_compression_breakout", strategy: adjacent_overlap_compression_breakout, input: { min_streak: "4.2" }, expected: { min_streak: 4 } },
    { key: "window_giveback_fib_failure", strategy: window_giveback_fib_failure, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "window_giveback_fib_continuation", strategy: window_giveback_fib_continuation, input: { lookback: "35.8" }, expected: { lookback: 36 } },
    { key: "extreme_age_fresh_reversal_fade", strategy: extreme_age_fresh_reversal_fade, input: { lookback: "22.2" }, expected: { lookback: 22 } },
    { key: "extreme_age_asymmetry_breakout", strategy: extreme_age_asymmetry_breakout, input: { lookback: "33.7" }, expected: { lookback: 34 } },
    { key: "variance_ratio_term_structure_slope", strategy: variance_ratio_term_structure_slope, input: { lookback: "35.1" }, expected: { lookback: 35 } },
    { key: "variance_ratio_velocity_surge", strategy: variance_ratio_velocity_surge, input: { velocity_threshold: "0.3" }, expected: { velocity_threshold: 0.3 } },
    { key: "sweep_reclaim_percentile_exhaustion", strategy: sweep_reclaim_percentile_exhaustion, input: { lookback: "45.2" }, expected: { lookback: 45 } },
    { key: "sweep_reclaim_absorption_cluster", strategy: sweep_reclaim_absorption_cluster, input: { min_streak: "3.2" }, expected: { min_streak: 3 } },
    { key: "adjacent_range_gap_exhaustion_fade", strategy: adjacent_range_gap_exhaustion_fade, input: { gap_threshold: "0.15" }, expected: { gap_threshold: 0.15 } },
    { key: "adjacent_range_balance_bracket_fade", strategy: adjacent_range_balance_bracket_fade, input: { lookback: "25.2" }, expected: { lookback: 25 } },
    { key: "window_giveback_round_trip_reversal", strategy: window_giveback_round_trip_reversal, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "window_giveback_velocity_capitulation", strategy: window_giveback_velocity_capitulation, input: { velocity_threshold: "0.35" }, expected: { velocity_threshold: 0.35 } },
    { key: "extreme_age_stale_boundary_breach", strategy: extreme_age_stale_boundary_breach, input: { lookback: "40.1" }, expected: { lookback: 40 } },
    { key: "extreme_age_compression_glide", strategy: extreme_age_compression_glide, input: { lookback: "26.3" }, expected: { lookback: 26 } },
    { key: "variance_ratio_regime_continuation", strategy: variance_ratio_regime_continuation, input: { lookback: "28.4" }, expected: { lookback: 28 } },
    { key: "variance_ratio_efficiency_orthogonal_router", strategy: variance_ratio_efficiency_orthogonal_router, input: { efficiency_threshold: "0.7" }, expected: { efficiency_threshold: 0.7 } },
    { key: "sweep_reclaim_asymmetric_cleanliness", strategy: sweep_reclaim_asymmetric_cleanliness, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "sweep_reclaim_compression_gate", strategy: sweep_reclaim_compression_gate, input: { lookback: "22.1" }, expected: { lookback: 22 } },
    { key: "adjacent_range_zero_overlap_breakout", strategy: adjacent_range_zero_overlap_breakout, input: { max_overlap: "0.08" }, expected: { max_overlap: 0.08 } },
    { key: "adjacent_overlap_relative_choke", strategy: adjacent_overlap_relative_choke, input: { lookback: "32.2" }, expected: { lookback: 32 } },
    { key: "window_giveback_directional_asymmetry", strategy: window_giveback_directional_asymmetry, input: { down_giveback_threshold: "0.3" }, expected: { down_giveback_threshold: 0.3 } },
    { key: "window_giveback_distribution_climax", strategy: window_giveback_distribution_climax, input: { lookback: "40.1" }, expected: { lookback: 40 } },
    { key: "extreme_age_fresh_thrust_acceptance", strategy: extreme_age_fresh_thrust_acceptance, input: { lookback: "30.3" }, expected: { lookback: 30 } },
    { key: "extreme_age_consolidation_decay_fade", strategy: extreme_age_consolidation_decay_fade, input: { min_age: "10.4" }, expected: { min_age: 10 } },
    { key: "variance_ratio_inverted_term_fade", strategy: variance_ratio_inverted_term_fade, input: { threshold: "0.35" }, expected: { threshold: 0.35 } },
    { key: "variance_ratio_subdiffusive_entry_flip", strategy: variance_ratio_subdiffusive_entry_flip, input: { lookback: "28.4" }, expected: { lookback: 28 } },
    { key: "sweep_reclaim_failed_spring_trap", strategy: sweep_reclaim_failed_spring_trap, input: { min_score: "0.45" }, expected: { min_score: 0.45 } },
    { key: "sweep_reclaim_acceptance_gradient", strategy: sweep_reclaim_acceptance_gradient, input: { acceptance_threshold: "0.75" }, expected: { acceptance_threshold: 0.75 } },
    { key: "adjacent_overlap_coiled_prebreakout", strategy: adjacent_overlap_coiled_prebreakout, input: { min_overlap: "0.65" }, expected: { min_overlap: 0.65 } },
    { key: "adjacent_range_runaway_gap_continuation", strategy: adjacent_range_runaway_gap_continuation, input: { gap_threshold: "0.15" }, expected: { gap_threshold: 0.15 } },
    { key: "window_giveback_golden_pocket_reclaim", strategy: window_giveback_golden_pocket_reclaim, input: { lookback: "26.2" }, expected: { lookback: 26 } },
    { key: "window_giveback_full_cascade_breakthrough", strategy: window_giveback_full_cascade_breakthrough, input: { lookback: "32.8" }, expected: { lookback: 33 } },
    { key: "extreme_age_blowoff_divergence_fade", strategy: extreme_age_blowoff_divergence_fade, input: { lookback: "35.1" }, expected: { lookback: 35 } },
    { key: "extreme_age_stale_false_break_fade", strategy: extreme_age_stale_false_break_fade, input: { lookback: "40.2" }, expected: { lookback: 40 } },
    { key: "variance_ratio_dispersion_halt_fade", strategy: variance_ratio_dispersion_halt_fade, input: { decay_threshold: "0.25" }, expected: { decay_threshold: 0.25 } },
    { key: "variance_ratio_subdiffusive_boundary_ping", strategy: variance_ratio_subdiffusive_boundary_ping, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "sweep_reclaim_alternating_ping_pong", strategy: sweep_reclaim_alternating_ping_pong, input: { min_score: "0.25" }, expected: { min_score: 0.25 } },
    { key: "sweep_reclaim_wick_dominant_absorption", strategy: sweep_reclaim_wick_dominant_absorption, input: { max_body_pct: "0.3" }, expected: { max_body_pct: 0.3 } },
    { key: "adjacent_overlap_waterfall_continuation", strategy: adjacent_overlap_waterfall_continuation, input: { min_streak: "3.2" }, expected: { min_streak: 3 } },
    { key: "adjacent_overlap_structural_trend_channel", strategy: adjacent_overlap_structural_trend_channel, input: { lookback: "20.4" }, expected: { lookback: 20 } },
    { key: "window_giveback_shallow_momentum_hold", strategy: window_giveback_shallow_momentum_hold, input: { lookback: "22.2" }, expected: { lookback: 22 } },
    { key: "window_giveback_acceleration_thrust", strategy: window_giveback_acceleration_thrust, input: { velocity_threshold: "0.3" }, expected: { velocity_threshold: 0.3 } },
    { key: "extreme_age_micro_double_top_fade", strategy: extreme_age_micro_double_top_fade, input: { lookback: "24.1" }, expected: { lookback: 24 } },
    { key: "extreme_age_volatility_reset_breakout", strategy: extreme_age_volatility_reset_breakout, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "variance_ratio_stealth_drift_continuation", strategy: variance_ratio_stealth_drift_continuation, input: { lookback: "24.2" }, expected: { lookback: 24 } },
    { key: "variance_ratio_subdiffusive_floor_rubberband", strategy: variance_ratio_subdiffusive_floor_rubberband, input: { min_vr: "0.6" }, expected: { min_vr: 0.6 } },
    { key: "sweep_reclaim_hyper_climax_fade", strategy: sweep_reclaim_hyper_climax_fade, input: { climax_threshold: "0.8" }, expected: { climax_threshold: 0.8 } },
    { key: "sweep_reclaim_void_breakout", strategy: sweep_reclaim_void_breakout, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "adjacent_overlap_containment_coiler", strategy: adjacent_overlap_containment_coiler, input: { min_overlap: "0.85" }, expected: { min_overlap: 0.85 } },
    { key: "adjacent_overlap_exhaustion_dispersion_fade", strategy: adjacent_overlap_exhaustion_dispersion_fade, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "window_giveback_midpoint_pivot_bounce", strategy: window_giveback_midpoint_pivot_bounce, input: { lookback: "24.4" }, expected: { lookback: 24 } },
    { key: "window_giveback_momentum_asymmetry_filter", strategy: window_giveback_momentum_asymmetry_filter, input: { up_giveback_max: "0.25" }, expected: { up_giveback_max: 0.25 } },
    { key: "extreme_age_symmetrical_collapse_thrust", strategy: extreme_age_symmetrical_collapse_thrust, input: { lookback: "24.3" }, expected: { lookback: 24 } },
    { key: "extreme_age_youthful_regime_ride", strategy: extreme_age_youthful_regime_ride, input: { max_age: "4.8" }, expected: { max_age: 5 } },
    { key: "variance_ratio_brownian_symmetry_break", strategy: variance_ratio_brownian_symmetry_break, input: { lookback: "30.2" }, expected: { lookback: 30 } },
    { key: "variance_ratio_bifurcation_crossover", strategy: variance_ratio_bifurcation_crossover, input: { lookback: "32.4" }, expected: { lookback: 32 } },
    { key: "sweep_reclaim_defended_floor_collapse", strategy: sweep_reclaim_defended_floor_collapse, input: { min_streak: "2.7" }, expected: { min_streak: 3 } },
    { key: "sweep_reclaim_rest_bar_coiling", strategy: sweep_reclaim_rest_bar_coiling, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "adjacent_overlap_stalled_thrust_fade", strategy: adjacent_overlap_stalled_thrust_fade, input: { max_overlap: "0.3" }, expected: { max_overlap: 0.3 } },
    { key: "adjacent_range_gap_fill_rejection", strategy: adjacent_range_gap_fill_rejection, input: { gap_threshold: "0.1" }, expected: { gap_threshold: 0.1 } },
    { key: "window_giveback_anchor_turn_impulse", strategy: window_giveback_anchor_turn_impulse, input: { max_giveback: "0.8" }, expected: { max_giveback: 0.8 } },
    { key: "window_giveback_deep_value_discount", strategy: window_giveback_deep_value_discount, input: { lookback: "36.2" }, expected: { lookback: 36 } },
    { key: "extreme_age_marginal_probe_exhaustion", strategy: extreme_age_marginal_probe_exhaustion, input: { penetration_max: "0.08" }, expected: { penetration_max: 0.08 } },
    { key: "extreme_age_dual_stale_coil_release", strategy: extreme_age_dual_stale_coil_release, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "variance_ratio_convexity_acceleration", strategy: variance_ratio_convexity_acceleration, input: { accel_threshold: "0.2" }, expected: { accel_threshold: 0.2 } },
    { key: "variance_ratio_anti_persistence_trap_fade", strategy: variance_ratio_anti_persistence_trap_fade, input: { vr_ceiling: "0.8" }, expected: { vr_ceiling: 0.8 } },
    { key: "sweep_reclaim_body_engulf_veto", strategy: sweep_reclaim_body_engulf_veto, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "sweep_reclaim_trend_pullback_flush", strategy: sweep_reclaim_trend_pullback_flush, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "adjacent_overlap_step_and_settle", strategy: adjacent_overlap_step_and_settle, input: { high_overlap_threshold: "0.7" }, expected: { high_overlap_threshold: 0.7 } },
    { key: "adjacent_overlap_regime_thaw_momentum", strategy: adjacent_overlap_regime_thaw_momentum, input: { lookback: "16.2" }, expected: { lookback: 16 } },
    { key: "window_giveback_golden_pocket_springboard", strategy: window_giveback_golden_pocket_springboard, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "window_giveback_velocity_arrest_reversal", strategy: window_giveback_velocity_arrest_reversal, input: { delta_max: "0.04" }, expected: { delta_max: 0.04 } },
    { key: "extreme_age_consecutive_fresh_snowball", strategy: extreme_age_consecutive_fresh_snowball, input: { lookback: "24.1" }, expected: { lookback: 24 } },
    { key: "extreme_age_rapid_inversion_pivot", strategy: extreme_age_rapid_inversion_pivot, input: { lookback: "26.4" }, expected: { lookback: 26 } },
    { key: "variance_ratio_scale_invariant_lock", strategy: variance_ratio_scale_invariant_lock, input: { pinch_max: "0.06" }, expected: { pinch_max: 0.06 } },
    { key: "variance_ratio_superdiffusive_blowoff_ride", strategy: variance_ratio_superdiffusive_blowoff_ride, input: { min_vr: "1.4" }, expected: { min_vr: 1.4 } },
    { key: "sweep_reclaim_absorption_asymmetry_skew", strategy: sweep_reclaim_absorption_asymmetry_skew, input: { lookback: "36.2" }, expected: { lookback: 36 } },
    { key: "sweep_reclaim_micro_probe_exhaustion", strategy: sweep_reclaim_micro_probe_exhaustion, input: { micro_max: "0.06" }, expected: { micro_max: 0.06 } },
    { key: "adjacent_overlap_harmonic_step_advance", strategy: adjacent_overlap_harmonic_step_advance, input: { min_overlap: "0.4" }, expected: { min_overlap: 0.4 } },
    { key: "adjacent_range_island_reversal_gap", strategy: adjacent_range_island_reversal_gap, input: { gap_threshold: "0.08" }, expected: { gap_threshold: 0.08 } },
    { key: "window_giveback_dynamic_scale_inversion", strategy: window_giveback_dynamic_scale_inversion, input: { parabolic_giveback_max: "0.2" }, expected: { parabolic_giveback_max: 0.2 } },
    { key: "window_giveback_deep_fib_last_stand", strategy: window_giveback_deep_fib_last_stand, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "extreme_age_stale_retest_springboard", strategy: extreme_age_stale_retest_springboard, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "extreme_age_perimeter_knock_breakout", strategy: extreme_age_perimeter_knock_breakout, input: { min_age: "12.4" }, expected: { min_age: 12 } },
    { key: "variance_ratio_subdiffusive_exit_surge", strategy: variance_ratio_subdiffusive_exit_surge, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "variance_ratio_subdiffusive_exhaustion_wick", strategy: variance_ratio_subdiffusive_exhaustion_wick, input: { max_vr: "0.65" }, expected: { max_vr: 0.65 } },
    { key: "sweep_reclaim_zero_top_wick_shave", strategy: sweep_reclaim_zero_top_wick_shave, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "sweep_reclaim_higher_low_confirmation", strategy: sweep_reclaim_higher_low_confirmation, input: { min_score: "0.3" }, expected: { min_score: 0.3 } },
    { key: "adjacent_overlap_rotational_drive_thrust", strategy: adjacent_overlap_rotational_drive_thrust, input: { min_overlap: "0.6" }, expected: { min_overlap: 0.6 } },
    { key: "adjacent_overlap_percentile_drop_release", strategy: adjacent_overlap_percentile_drop_release, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "window_giveback_total_wipeout_rebound", strategy: window_giveback_total_wipeout_rebound, input: { lookback: "26.2" }, expected: { lookback: 26 } },
    { key: "window_giveback_stairstep_body_dominance", strategy: window_giveback_stairstep_body_dominance, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "extreme_age_marubozu_fresh_thrust", strategy: extreme_age_marubozu_fresh_thrust, input: { lookback: "24.1" }, expected: { lookback: 24 } },
    { key: "extreme_age_exhaustion_wick_spike_fade", strategy: extreme_age_exhaustion_wick_spike_fade, input: { lookback: "30.2" }, expected: { lookback: 30 } },
    { key: "variance_ratio_multi_bar_slope_surge", strategy: variance_ratio_multi_bar_slope_surge, input: { threshold: "0.25" }, expected: { threshold: 0.25 } },
    { key: "variance_ratio_superdiffusive_median_retest", strategy: variance_ratio_superdiffusive_median_retest, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "sweep_reclaim_absorption_decay_fade", strategy: sweep_reclaim_absorption_decay_fade, input: { min_initial_score: "0.4" }, expected: { min_initial_score: 0.4 } },
    { key: "sweep_reclaim_zscore_liquidity_spike", strategy: sweep_reclaim_zscore_liquidity_spike, input: { z_threshold: "2.5" }, expected: { z_threshold: 2.5 } },
    { key: "adjacent_overlap_coagulation_continuation", strategy: adjacent_overlap_coagulation_continuation, input: { min_final_overlap: "0.75" }, expected: { min_final_overlap: 0.75 } },
    { key: "adjacent_overlap_goldilocks_trend_channel", strategy: adjacent_overlap_goldilocks_trend_channel, input: { lookback: "24.1" }, expected: { lookback: 24 } },
    { key: "window_giveback_two_bar_breakdown_lock", strategy: window_giveback_two_bar_breakdown_lock, input: { lookback: "30.4" }, expected: { lookback: 30 } },
    { key: "window_giveback_abrupt_trend_fracture", strategy: window_giveback_abrupt_trend_fracture, input: { velocity_threshold: "0.3" }, expected: { velocity_threshold: 0.3 } },
    { key: "extreme_age_symmetric_age_convergence_break", strategy: extreme_age_symmetric_age_convergence_break, input: { delta_age_max: "4.2" }, expected: { delta_age_max: 4 } },
    { key: "extreme_age_stale_break_runaway_step", strategy: extreme_age_stale_break_runaway_step, input: { lookback: "36.2" }, expected: { lookback: 36 } },
    { key: "variance_ratio_term_crossover_impulse", strategy: variance_ratio_term_crossover_impulse, input: { lookback: "32.1" }, expected: { lookback: 32 } },
    { key: "variance_ratio_superdiffusive_coil_break", strategy: variance_ratio_superdiffusive_coil_break, input: { lookback: "28.3" }, expected: { lookback: 28 } },
    { key: "sweep_reclaim_two_sided_dominance", strategy: sweep_reclaim_two_sided_dominance, input: { min_score: "0.35" }, expected: { min_score: 0.35 } },
    { key: "sweep_reclaim_low_efficiency_recycle", strategy: sweep_reclaim_low_efficiency_recycle, input: { max_efficiency: "0.25" }, expected: { max_efficiency: 0.25 } },
    { key: "adjacent_overlap_containment_detonation", strategy: adjacent_overlap_containment_detonation, input: { max_overlap: "0.2" }, expected: { max_overlap: 0.2 } },
    { key: "adjacent_overlap_expansion_wick_reversal", strategy: adjacent_overlap_expansion_wick_reversal, input: { max_overlap: "0.35" }, expected: { max_overlap: 0.35 } },
    { key: "window_giveback_exhausted_breakdown_fade", strategy: window_giveback_exhausted_breakdown_fade, input: { lookback: "26.2" }, expected: { lookback: 26 } },
    { key: "window_giveback_volatility_scaled_tolerance", strategy: window_giveback_volatility_scaled_tolerance, input: { high_vol_giveback_max: "0.2" }, expected: { high_vol_giveback_max: 0.2 } },
    { key: "extreme_age_body_surge_breakout", strategy: extreme_age_body_surge_breakout, input: { lookback: "24.1" }, expected: { lookback: 24 } },
    { key: "extreme_age_engulfing_fresh_trap_fade", strategy: extreme_age_engulfing_fresh_trap_fade, input: { lookback: "28.3" }, expected: { lookback: 28 } },
];

function generateMockData(length = 120): OHLCVData[] {
    const data: OHLCVData[] = [];
    let price = 100;
    for (let i = 0; i < length; i += 1) {
        const change = Math.sin(i * 0.5) * 2 + (i % 15 === 0 ? 5 : 0) - (i % 20 === 0 ? 6 : 0);
        const open = price;
        const close = price + change;
        data.push({
            time: (1_700_000_000 + i * 3600) as Time,
            open,
            high: Math.max(open, close) + 0.5,
            low: Math.min(open, close) - 0.5,
            close,
            volume: 100 + (i % 10) * 10,
        });
        price = close;
    }
    return data;
}

function normalize(strategy: Strategy, input: Record<string, string>): StrategyParams {
    if (!strategy.normalizeParams) {
        throw new Error(`${strategy.name} has no normalizeParams`);
    }
    return strategy.normalizeParams(input as unknown as StrategyParams);
}

describe("Synthetic Ratio Strategies Smoke Tests", () => {
    const data = generateMockData();

    for (const testCase of CASES) {
        it(`${testCase.key} executes and normalizes`, () => {
            expect(testCase.strategy.execute(data, testCase.strategy.defaultParams)).to.be.an("array");
            const normalized = normalize(testCase.strategy, testCase.input);
            for (const [key, expected] of Object.entries(testCase.expected)) {
                expect(normalized[key], `${testCase.key}.${key}`).to.equal(expected);
            }
        });
    }
});
