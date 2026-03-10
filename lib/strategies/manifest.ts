import type { Strategy } from "../types/strategies";

import { adaptive_supertrend_kmeans } from "./lib/adaptive_supertrend_kmeans";
import { mean_reversion_zscore } from "./lib/mean_reversion_zscore";
import { dynamic_vix_regime } from "./lib/dynamic-vix-regime";
import { dynamic_vix_regime_iron_core } from "./lib/dynamic-vix-regime-iron-core";
import { volatility_compression_break } from "./lib/volatility-compression-break";
import { volatility_compression_break_trend } from "./lib/volatility-compression-break-trend";
import { exhaustion_spike_pullback } from "./lib/exhaustion-spike-pullback";
import { hypothesis_trend_persistence } from "./lib/hypothesis-trend-persistence";
import { liquidity_void_rider } from "./lib/liquidity-void-rider";
import { volatility_compression_trigger } from "./lib/volatility-compression-trigger";
import { liquidity_sweep_reclaim_v1 } from "./lib/liquidity_sweep_reclaim_v1";
import { stochastic_momentum_divergence_entry } from "./lib/stochastic-momentum-divergence-entry";
import { volume_dry_up_reversal } from "./lib/volume-dry-up-reversal";
import { inside_bar_momentum_burst } from "./lib/inside-bar-momentum-burst";
import { vwap_reclaim_sniper } from "./lib/vwap-reclaim-sniper";
import { parabolic_sar_flip_adx_gate } from "./lib/parabolic-sar-flip-adx-gate";
import { bollinger_squeeze_breakout } from "./lib/bollinger-squeeze-breakout";
import { roc_reversal_at_extremes } from "./lib/roc-reversal-at-extremes";
import { ema_ribbon_compression_entry } from "./lib/ema-ribbon-compression-entry";
import { gap_fill_momentum } from "./lib/gap-fill-momentum";
import { candle_pattern_persistence_score } from "./lib/candle-pattern-persistence-score";
import { candle_pattern_persistence_score_ema_bias } from "./lib/candle-pattern-persistence-score-ema-bias";
import { candle_pattern_persistence_score_rsi_midline } from "./lib/candle-pattern-persistence-score-rsi-midline";
import { candle_pattern_persistence_score_cci_zero } from "./lib/candle-pattern-persistence-score-cci-zero";
import { candle_pattern_persistence_score_macd_phase } from "./lib/candle-pattern-persistence-score-macd-phase";
import { candle_pattern_persistence_score_stoch_mid } from "./lib/candle-pattern-persistence-score-stoch-mid";
import { candle_pattern_persistence_score_macd_zero } from "./lib/candle-pattern-persistence-score-macd-zero";
import { candle_pattern_persistence_score_macd_signal_cross } from "./lib/candle-pattern-persistence-score-macd-signal-cross";
import { candle_pattern_persistence_score_macd_hist_slope } from "./lib/candle-pattern-persistence-score-macd-hist-slope";
import { candle_pattern_persistence_score_macd_div_gate } from "./lib/candle-pattern-persistence-score-macd-div-gate";
import { candle_pattern_persistence_score_macd_dual_tf } from "./lib/candle-pattern-persistence-score-macd-dual-tf";
import { wick_dominance_persistence } from "./lib/wick-dominance-persistence";
import { close_position_momentum_score } from "./lib/close-position-momentum-score";
import { sequential_gap_fill_pressure } from "./lib/sequential-gap-fill-pressure";
import { range_expansion_directional_bias } from "./lib/range-expansion-directional-bias";
import { open_to_close_drift_consistency } from "./lib/open-to-close-drift-consistency";
import { high_low_bias_accumulator } from "./lib/high-low-bias-accumulator";
import { shadow_reversal_frequency_score } from "./lib/shadow-reversal-frequency-score";
import { close_displacement_velocity } from "./lib/close-displacement-velocity";
import { intrabar_polarity_reversal_count } from "./lib/intrabar-polarity-reversal-count";
import { consecutive_midpoint_advance_score } from "./lib/consecutive-midpoint-advance-score";
import { candle_return_rate_mean_reversion } from "./lib/candle-return-rate-mean-reversion";
import { adx_slope_pivot_entry } from "./lib/adx_slope_pivot_entry";
import { wick_imbalance_persistence_score } from "./lib/wick-imbalance-persistence-score";
import { previous_midpoint_reclaim_score } from "./lib/previous-midpoint-reclaim-score";
import { failed_range_expansion_flip } from "./lib/failed-range-expansion-flip";
import { tail_echo_pressure_score } from "./lib/tail-echo-pressure-score";
import { body_overlap_drift_score } from "./lib/body-overlap-drift-score";
import { close_location_failure_score } from "./lib/close-location-failure-score";
import { compression_reclaim_impulse } from "./lib/compression-reclaim-impulse";
import { prior_range_open_trap } from "./lib/prior-range-open-trap";
import { micro_sweep_reclaim_score } from "./lib/micro-sweep-reclaim-score";
import { follow_through_failure_persistence } from "./lib/follow-through-failure-persistence";
import { high_low_midpoint_crossover_momentum } from "./lib/high-low-midpoint-crossover-momentum";
import { volatility_efficiency_breakout } from "./lib/volatility_efficiency_breakout";
import { efficiency_ratio_pinch_trigger } from "./lib/efficiency_ratio_pinch_trigger";


export interface StrategyManifestEntry {
    key: string;
    strategy: Strategy;
    assets?: string[];
}

export const strategyManifest: readonly StrategyManifestEntry[] = [
    { key: "adaptive_supertrend_kmeans", strategy: adaptive_supertrend_kmeans },
    { key: "mean_reversion_zscore", strategy: mean_reversion_zscore },
    { key: "dynamic_vix_regime", strategy: dynamic_vix_regime },
    { key: "dynamic_vix_regime_iron_core", strategy: dynamic_vix_regime_iron_core },
    { key: "volatility_compression_break", strategy: volatility_compression_break },
    { key: "volatility_compression_break_trend", strategy: volatility_compression_break_trend },
    { key: "exhaustion_spike_pullback", strategy: exhaustion_spike_pullback },
    { key: "hypothesis_trend_persistence", strategy: hypothesis_trend_persistence },
    { key: "liquidity_void_rider", strategy: liquidity_void_rider },
    { key: "volatility_compression_trigger", strategy: volatility_compression_trigger },
    { key: "liquidity_sweep_reclaim_v1", strategy: liquidity_sweep_reclaim_v1 },
    { key: "stochastic_momentum_divergence_entry", strategy: stochastic_momentum_divergence_entry },
    { key: "volume_dry_up_reversal", strategy: volume_dry_up_reversal },
    { key: "inside_bar_momentum_burst", strategy: inside_bar_momentum_burst },
    { key: "vwap_reclaim_sniper", strategy: vwap_reclaim_sniper },
    { key: "parabolic_sar_flip_adx_gate", strategy: parabolic_sar_flip_adx_gate },
    { key: "bollinger_squeeze_breakout", strategy: bollinger_squeeze_breakout },
    { key: "roc_reversal_at_extremes", strategy: roc_reversal_at_extremes },
    { key: "ema_ribbon_compression_entry", strategy: ema_ribbon_compression_entry },
    { key: "gap_fill_momentum", strategy: gap_fill_momentum },
    { key: "candle_pattern_persistence_score", strategy: candle_pattern_persistence_score },
    { key: "candle_pattern_persistence_score_ema_bias", strategy: candle_pattern_persistence_score_ema_bias },
    { key: "candle_pattern_persistence_score_rsi_midline", strategy: candle_pattern_persistence_score_rsi_midline },
    { key: "candle_pattern_persistence_score_cci_zero", strategy: candle_pattern_persistence_score_cci_zero },
    { key: "candle_pattern_persistence_score_macd_phase", strategy: candle_pattern_persistence_score_macd_phase },
    { key: "candle_pattern_persistence_score_stoch_mid", strategy: candle_pattern_persistence_score_stoch_mid },
    { key: "candle_pattern_persistence_score_macd_zero", strategy: candle_pattern_persistence_score_macd_zero },
    { key: "candle_pattern_persistence_score_macd_signal_cross", strategy: candle_pattern_persistence_score_macd_signal_cross },
    { key: "candle_pattern_persistence_score_macd_hist_slope", strategy: candle_pattern_persistence_score_macd_hist_slope },
    { key: "candle_pattern_persistence_score_macd_div_gate", strategy: candle_pattern_persistence_score_macd_div_gate },
    { key: "candle_pattern_persistence_score_macd_dual_tf", strategy: candle_pattern_persistence_score_macd_dual_tf },
    { key: "wick_dominance_persistence", strategy: wick_dominance_persistence },
    { key: "close_position_momentum_score", strategy: close_position_momentum_score },
    { key: "sequential_gap_fill_pressure", strategy: sequential_gap_fill_pressure },
    { key: "range_expansion_directional_bias", strategy: range_expansion_directional_bias },
    { key: "open_to_close_drift_consistency", strategy: open_to_close_drift_consistency },
    { key: "high_low_bias_accumulator", strategy: high_low_bias_accumulator },
    { key: "shadow_reversal_frequency_score", strategy: shadow_reversal_frequency_score },
    { key: "close_displacement_velocity", strategy: close_displacement_velocity },
    { key: "intrabar_polarity_reversal_count", strategy: intrabar_polarity_reversal_count },
    { key: "consecutive_midpoint_advance_score", strategy: consecutive_midpoint_advance_score },
    { key: "candle_return_rate_mean_reversion", strategy: candle_return_rate_mean_reversion },
    { key: "adx_slope_pivot_entry", strategy: adx_slope_pivot_entry },
    { key: "wick_imbalance_persistence_score", strategy: wick_imbalance_persistence_score },
    { key: "previous_midpoint_reclaim_score", strategy: previous_midpoint_reclaim_score },
    { key: "failed_range_expansion_flip", strategy: failed_range_expansion_flip },
    { key: "tail_echo_pressure_score", strategy: tail_echo_pressure_score },
    { key: "body_overlap_drift_score", strategy: body_overlap_drift_score },
    { key: "close_location_failure_score", strategy: close_location_failure_score },
    { key: "compression_reclaim_impulse", strategy: compression_reclaim_impulse },
    { key: "prior_range_open_trap", strategy: prior_range_open_trap },
    { key: "micro_sweep_reclaim_score", strategy: micro_sweep_reclaim_score },
    { key: "follow_through_failure_persistence", strategy: follow_through_failure_persistence },
    { key: "high_low_midpoint_crossover_momentum", strategy: high_low_midpoint_crossover_momentum },
    { key: "volatility_efficiency_breakout", strategy: volatility_efficiency_breakout },
    { key: "efficiency_ratio_pinch_trigger", strategy: efficiency_ratio_pinch_trigger },
];

export function createStrategiesRecordFromManifest(
    manifest: readonly StrategyManifestEntry[] = strategyManifest
): Record<string, Strategy> {
    const strategies: Record<string, Strategy> = {};

    for (const entry of manifest) {
        if (entry.key in strategies) {
            throw new Error(`Duplicate strategy key in manifest: ${entry.key}`);
        }
        strategies[entry.key] = entry.strategy;
    }

    return strategies;
}
