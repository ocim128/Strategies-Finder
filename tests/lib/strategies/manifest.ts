import type { Strategy } from "../types/strategies";


import { median_deviation_streak } from "./lib/median_deviation_streak";
import { median_deviation_streak_v7 } from "./lib/median_deviation_streak_v7";
import { entropy_ratio_regime_alignment } from "./lib/entropy_ratio_regime_alignment";
import { pattern_regime_alignment } from "./lib/pattern_regime_alignment";
import { skew_entropy_polarization_entry } from "./lib/skew_entropy_polarization_entry";
import { supertrend_friction_pinch } from "./lib/supertrend_friction_pinch";
import { volatility_compression_break } from "./lib/volatility-compression-break";
import { volatility_compression_break_trend } from "./lib/volatility-compression-break-trend";
import { exhaustion_spike_pullback } from "./lib/exhaustion-spike-pullback";
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
import { candle_pattern_persistence_score_median_deviation_streak } from "./lib/candle-pattern-persistence-score-median-deviation-streak";
import { adx_slope_pivot_entry } from "./lib/adx_slope_pivot_entry";
import { exhaustion_spike_follow_through } from "./lib/exhaustion-spike-follow-through";
import { high_low_midpoint_crossover_momentum } from "./lib/high-low-midpoint-crossover-momentum";
import { volatility_efficiency_breakout } from "./lib/volatility_efficiency_breakout";
import { efficiency_ratio_pinch_trigger } from "./lib/efficiency_ratio_pinch_trigger";
import { absorptive_wick_decay_wave } from "./lib/absorptive_wick_decay_wave";
import { fractal_volatility_pinch_impulse } from "./lib/fractal_volatility_pinch_impulse";
import { dead_zone_efficiency_breakout } from "./lib/dead_zone_efficiency_breakout";
import { stddev_compression_to_roc_surge } from "./lib/stddev_compression_to_roc_surge";
import { noise_to_signal_efficiency_breakout } from "./lib/noise_to_signal_efficiency_breakout";
import { crossing_persistence_event_regime } from "./lib/crossing_persistence_event_regime";
import { efficiency_pinch_roc_breakout } from "./lib/efficiency_pinch_roc_breakout";
import { cumulative_decay_regime_filter } from "./lib/cumulative_decay_regime_filter";
import { skewness_deadzone_break } from "./lib/skewness_deadzone_break";
import { crossing_churn_suppression } from "./lib/crossing_churn_suppression";
import { autocorr_deadband_release } from "./lib/autocorr_deadband_release";
import { vwap_zscore_reversion } from "./lib/vwap_zscore_reversion";
import { supertrend_churn_resilience } from "./lib/supertrend_churn_resilience";
import { adx_skewness_drift } from "./lib/adx_skewness_drift";
import { macd_signal_pinch_explosion } from "./lib/macd_signal_pinch_explosion";
import { bollinger_skewness_ride } from "./lib/bollinger_skewness_ride";
import { supertrend_distance_zscore } from "./lib/supertrend_distance_zscore";
import { rsi_volatility_pinch_pop } from "./lib/rsi_volatility_pinch_pop";
import { momentum_zscore_exhaustion } from "./lib/momentum_zscore_exhaustion";


import { macd_histogram_volatility_squeeze } from "./lib/macd_histogram_volatility_squeeze";
import { volume_profile_poc_median_shift } from "./lib/volume_profile_poc_median_shift";

import { value_area_median_shift } from "./lib/value_area_median_shift";

export interface StrategyManifestEntry {


    key: string;
    strategy: Strategy;
    assets?: string[];
}

export const strategyManifest: readonly StrategyManifestEntry[] = [
    
    { key: "median_deviation_streak", strategy: median_deviation_streak },
    { key: "median_deviation_streak_v7", strategy: median_deviation_streak_v7 },
    { key: "skew_entropy_polarization_entry", strategy: skew_entropy_polarization_entry },
    { key: "entropy_ratio_regime_alignment", strategy: entropy_ratio_regime_alignment },
    { key: "pattern_regime_alignment", strategy: pattern_regime_alignment },
    { key: "value_area_median_shift", strategy: value_area_median_shift },
    { key: "supertrend_friction_pinch", strategy: supertrend_friction_pinch },
    { key: "exhaustion_spike_follow_through", strategy: exhaustion_spike_follow_through },
    { key: "exhaustion_spike_pullback", strategy: exhaustion_spike_pullback },
    { key: "volatility_compression_break", strategy: volatility_compression_break },
    { key: "volatility_compression_break_trend", strategy: volatility_compression_break_trend },
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
    { key: "candle_pattern_persistence_score_median_deviation_streak", strategy: candle_pattern_persistence_score_median_deviation_streak },
    { key: "adx_slope_pivot_entry", strategy: adx_slope_pivot_entry },
    { key: "high_low_midpoint_crossover_momentum", strategy: high_low_midpoint_crossover_momentum },
    { key: "volatility_efficiency_breakout", strategy: volatility_efficiency_breakout },
    { key: "efficiency_ratio_pinch_trigger", strategy: efficiency_ratio_pinch_trigger },
    { key: "dead_zone_efficiency_breakout", strategy: dead_zone_efficiency_breakout },
    { key: "fractal_volatility_pinch_impulse", strategy: fractal_volatility_pinch_impulse },
    { key: "stddev_compression_to_roc_surge", strategy: stddev_compression_to_roc_surge },
    { key: "noise_to_signal_efficiency_breakout", strategy: noise_to_signal_efficiency_breakout },
    { key: "absorptive_wick_decay_wave", strategy: absorptive_wick_decay_wave },
    { key: "crossing_persistence_event_regime", strategy: crossing_persistence_event_regime },
    { key: "efficiency_pinch_roc_breakout", strategy: efficiency_pinch_roc_breakout },
    { key: "cumulative_decay_regime_filter", strategy: cumulative_decay_regime_filter },
    { key: "skewness_deadzone_break", strategy: skewness_deadzone_break },
    { key: "crossing_churn_suppression", strategy: crossing_churn_suppression },
    { key: "autocorr_deadband_release", strategy: autocorr_deadband_release },
    { key: "vwap_zscore_reversion", strategy: vwap_zscore_reversion },
    { key: "supertrend_churn_resilience", strategy: supertrend_churn_resilience },
    { key: "adx_skewness_drift", strategy: adx_skewness_drift },
    { key: "macd_signal_pinch_explosion", strategy: macd_signal_pinch_explosion },
    { key: "bollinger_skewness_ride", strategy: bollinger_skewness_ride },
    { key: "supertrend_distance_zscore", strategy: supertrend_distance_zscore },
    { key: "rsi_volatility_pinch_pop", strategy: rsi_volatility_pinch_pop },
    { key: "momentum_zscore_exhaustion", strategy: momentum_zscore_exhaustion },


    { key: "macd_histogram_volatility_squeeze", strategy: macd_histogram_volatility_squeeze },
    { key: "volume_profile_poc_median_shift", strategy: volume_profile_poc_median_shift },


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
