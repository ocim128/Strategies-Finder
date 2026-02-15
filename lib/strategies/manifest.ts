import type { Strategy } from "../types/strategies";

import { fib_speed_fan_entry } from "./lib/fib-speed-fan-entry";
import { supply_demand_zones } from "./lib/supply-demand-zones";
import { mtf_impulse_zone_reversal, mtf_impulse_zone_breakout } from "./lib/mtf-impulse-zones";
import { chandelier_rsi_ema } from "./lib/chandelier_rsi_ema";
import { adaptive_supertrend_kmeans } from "./lib/adaptive_supertrend_kmeans";
import { mean_reversion_zscore } from "./lib/mean_reversion_zscore";
import { failed_breakout } from "./lib/failed_breakout";
import { long_short_harvest } from "./lib/long-short-harvest";
import { dynamic_vix_regime } from "./lib/dynamic-vix-regime";
import { dynamic_vix_regime_iron_core } from "./lib/dynamic-vix-regime-iron-core";
import { dynamic_vix_regime_finder } from "./lib/dynamic-vix-regime-finder";
import { drawdown_regime_gate } from "./lib/drawdown-regime-gate";
import { regime_donchian_breakout } from "./lib/regime-donchian-breakout";
import { shock_reversion_trend_gate } from "./lib/shock-reversion-trend-gate";
import { momentum_volatility_rotation } from "./lib/momentum-volatility-rotation";
import { adx_atr_no_trade_zone } from "./lib/adx-atr-no-trade-zone";
import { simple_regression_line } from "./lib/simple-regression-line";
import { liquidity_sweep_reclaim } from "./lib/liquidity-sweep-reclaim";
import { volatility_compression_break } from "./lib/volatility-compression-break";
import { gap_fail_reversal } from "./lib/gap-fail-reversal";
import { exhaustion_spike_pullback } from "./lib/exhaustion-spike-pullback";
import { session_open_fakeout } from "./lib/session-open-fakeout";
import { momentum_rsi_pullback_entry } from "./lib/momentum-rsi-pullback-entry";
import { momentum_rsi_regime_gate } from "./lib/momentum-rsi-regime-gate";
import { momentum_rsi_exit_pack } from "./lib/momentum-rsi-exit-pack";
import { hypothesis_trend_persistence } from "./lib/hypothesis-trend-persistence";
import { liquidity_void_rider } from "./lib/liquidity-void-rider";
import { tick_imbalance_pressure } from "./lib/tick-imbalance-pressure";
import { volatility_compression_trigger } from "./lib/volatility-compression-trigger";
import { time_weighted_mean_reversion } from "./lib/time-weighted-mean-reversion";
import { meta_harvest_v1 } from "./lib/meta_harvest_v1";
import { meta_harvest_v2 } from "./lib/meta_harvest_v2";
import { meta_harvest_v2_1 } from "./lib/meta_harvest_v2_1";
import { meta_harvest_v2_2 } from "./lib/meta_harvest_v2_2";

export interface StrategyManifestEntry {
    key: string;
    strategy: Strategy;
}

export const strategyManifest: readonly StrategyManifestEntry[] = [
    { key: "fib_speed_fan_entry", strategy: fib_speed_fan_entry },
    { key: "supply_demand_zones", strategy: supply_demand_zones },
    { key: "mtf_impulse_zone_reversal", strategy: mtf_impulse_zone_reversal },
    { key: "mtf_impulse_zone_breakout", strategy: mtf_impulse_zone_breakout },
    { key: "chandelier_rsi_ema", strategy: chandelier_rsi_ema },
    { key: "adaptive_supertrend_kmeans", strategy: adaptive_supertrend_kmeans },
    { key: "mean_reversion_zscore", strategy: mean_reversion_zscore },
    { key: "failed_breakout", strategy: failed_breakout },
    { key: "long_short_harvest", strategy: long_short_harvest },
    { key: "dynamic_vix_regime", strategy: dynamic_vix_regime },
    { key: "dynamic_vix_regime_iron_core", strategy: dynamic_vix_regime_iron_core },
    { key: "dynamic_vix_regime_finder", strategy: dynamic_vix_regime_finder },
    { key: "drawdown_regime_gate", strategy: drawdown_regime_gate },
    { key: "regime_donchian_breakout", strategy: regime_donchian_breakout },
    { key: "shock_reversion_trend_gate", strategy: shock_reversion_trend_gate },
    { key: "momentum_volatility_rotation", strategy: momentum_volatility_rotation },
    { key: "adx_atr_no_trade_zone", strategy: adx_atr_no_trade_zone },
    { key: "simple_regression_line", strategy: simple_regression_line },
    { key: "liquidity_sweep_reclaim", strategy: liquidity_sweep_reclaim },
    { key: "volatility_compression_break", strategy: volatility_compression_break },
    { key: "gap_fail_reversal", strategy: gap_fail_reversal },
    { key: "exhaustion_spike_pullback", strategy: exhaustion_spike_pullback },
    { key: "session_open_fakeout", strategy: session_open_fakeout },
    { key: "momentum_rsi_pullback_entry", strategy: momentum_rsi_pullback_entry },
    { key: "momentum_rsi_regime_gate", strategy: momentum_rsi_regime_gate },
    { key: "momentum_rsi_exit_pack", strategy: momentum_rsi_exit_pack },
    { key: "hypothesis_trend_persistence", strategy: hypothesis_trend_persistence },
    { key: "liquidity_void_rider", strategy: liquidity_void_rider },
    { key: "tick_imbalance_pressure", strategy: tick_imbalance_pressure },
    { key: "volatility_compression_trigger", strategy: volatility_compression_trigger },
    { key: "time_weighted_mean_reversion", strategy: time_weighted_mean_reversion },
    { key: "meta_harvest_v1", strategy: meta_harvest_v1 },
    { key: "meta_harvest_v2", strategy: meta_harvest_v2 },
    { key: "meta_harvest_v2_1", strategy: meta_harvest_v2_1 },
    { key: "meta_harvest_v2_2", strategy: meta_harvest_v2_2 },
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
