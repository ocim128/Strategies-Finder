import type { Strategy } from "../types/strategies";

import { fib_speed_fan_entry } from "./lib/fib-speed-fan-entry";
import { supply_demand_zones } from "./lib/supply-demand-zones";
import { mtf_impulse_zone_reversal, mtf_impulse_zone_breakout } from "./lib/mtf-impulse-zones";
import { chandelier_rsi_ema } from "./lib/chandelier_rsi_ema";
import { adaptive_supertrend_kmeans } from "./lib/adaptive_supertrend_kmeans";
import { mean_reversion_zscore } from "./lib/mean_reversion_zscore";
import { dynamic_vix_regime } from "./lib/dynamic-vix-regime";
import { dynamic_vix_regime_iron_core } from "./lib/dynamic-vix-regime-iron-core";
import { asian_session_breakout_v2 } from "./lib/asian_session_breakout_v2";
import { btc_queen_v1 } from "./lib/btc_queen_v1";
import { dynamic_vix_regime_finder } from "./lib/dynamic-vix-regime-finder";
import { drawdown_regime_gate } from "./lib/drawdown-regime-gate";
import { regime_donchian_breakout } from "./lib/regime-donchian-breakout";
import { shock_reversion_trend_gate } from "./lib/shock-reversion-trend-gate";
import { momentum_volatility_rotation } from "./lib/momentum-volatility-rotation";
import { simple_regression_line } from "./lib/simple-regression-line";
import { sol_queen_v1 } from "./lib/sol_queen_v1";
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
import { candle_return_rate_mean_reversion } from "./lib/candle-return-rate-mean-reversion";

export interface StrategyManifestEntry {
    key: string;
    strategy: Strategy;
    assets?: string[];
}

export const strategyManifest: readonly StrategyManifestEntry[] = [
    { key: "fib_speed_fan_entry", strategy: fib_speed_fan_entry },
    { key: "supply_demand_zones", strategy: supply_demand_zones },
    { key: "mtf_impulse_zone_reversal", strategy: mtf_impulse_zone_reversal },
    { key: "mtf_impulse_zone_breakout", strategy: mtf_impulse_zone_breakout },
    { key: "chandelier_rsi_ema", strategy: chandelier_rsi_ema },
    { key: "adaptive_supertrend_kmeans", strategy: adaptive_supertrend_kmeans },
    { key: "mean_reversion_zscore", strategy: mean_reversion_zscore },
    { key: "dynamic_vix_regime", strategy: dynamic_vix_regime },
    { key: "dynamic_vix_regime_iron_core", strategy: dynamic_vix_regime_iron_core },
    { key: "asian_session_breakout_v2", strategy: asian_session_breakout_v2 },
    { key: "btc_queen_v1", strategy: btc_queen_v1, assets: ["BTC"] },
    { key: "dynamic_vix_regime_finder", strategy: dynamic_vix_regime_finder },
    { key: "drawdown_regime_gate", strategy: drawdown_regime_gate },
    { key: "regime_donchian_breakout", strategy: regime_donchian_breakout },
    { key: "shock_reversion_trend_gate", strategy: shock_reversion_trend_gate },
    { key: "momentum_volatility_rotation", strategy: momentum_volatility_rotation },
    { key: "simple_regression_line", strategy: simple_regression_line },
    { key: "sol_queen_v1", strategy: sol_queen_v1, assets: ["SOL"] },
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
    { key: "candle_return_rate_mean_reversion", strategy: candle_return_rate_mean_reversion },
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
