import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, StrategyParams, Time } from "../../lib/types/strategies";
import { atr_adjusted_streak_momentum } from "../../lib/strategies/lib/atr_adjusted_streak_momentum";
import { atr_normalized_range_reversion } from "../../lib/strategies/lib/atr_normalized_range_reversion";
import { body_proportion_percentile_fade } from "../../lib/strategies/lib/body_proportion_percentile_fade";
import { close_location_streak_mean_reversion } from "../../lib/strategies/lib/close_location_streak_mean_reversion";
import { compression_ratio_expansion_reversion } from "../../lib/strategies/lib/compression_ratio_expansion_reversion";
import { cumulative_return_percentile_reversion } from "../../lib/strategies/lib/cumulative_return_percentile_reversion";
import { decay_pressure_percentile_reversion } from "../../lib/strategies/lib/decay_pressure_percentile_reversion";
import { entropy_decay_momentum_acceleration } from "../../lib/strategies/lib/entropy_decay_momentum_acceleration";
import { initiative_pressure_acceleration_follow } from "../../lib/strategies/lib/initiative_pressure_acceleration_follow";
import { range_efficiency_regime_ignition } from "../../lib/strategies/lib/range_efficiency_regime_ignition";
import { return_reversal_count_reversion } from "../../lib/strategies/lib/return_reversal_count_reversion";
import { return_sign_streak_fade } from "../../lib/strategies/lib/return_sign_streak_fade";
import { return_zscore_extreme_reversion } from "../../lib/strategies/lib/return_zscore_extreme_reversion";
import { skewness_reversal_momentum_ignite } from "../../lib/strategies/lib/skewness_reversal_momentum_ignite";
import { volatility_breakout_follow } from "../../lib/strategies/lib/volatility_breakout_follow";
import { volume_correlation_trend_follow } from "../../lib/strategies/lib/volume_correlation_trend_follow";
import { wick_imbalance_thrust_continuation } from "../../lib/strategies/lib/wick_imbalance_thrust_continuation";

type StrategySmokeCase = {
    key: string;
    strategy: Strategy;
    input: Record<string, string>;
    expected: Record<string, number>;
};

const CASES: StrategySmokeCase[] = [
    { key: "return_sign_streak_fade", strategy: return_sign_streak_fade, input: { lookback: "3.2", streakMin: "4.7" }, expected: { lookback: 3, streakMin: 5 } },
    { key: "cumulative_return_percentile_reversion", strategy: cumulative_return_percentile_reversion, input: { lookback: "20.1", pctlExtreme: "0.95" }, expected: { lookback: 20, pctlExtreme: 0.95 } },
    { key: "return_zscore_extreme_reversion", strategy: return_zscore_extreme_reversion, input: { lookback: "15", zscoreThreshold: "2.2" }, expected: { lookback: 15, zscoreThreshold: 2.2 } },
    { key: "body_proportion_percentile_fade", strategy: body_proportion_percentile_fade, input: { lookback: "25", pctlExtreme: "0.80" }, expected: { lookback: 25, pctlExtreme: 0.8 } },
    { key: "return_reversal_count_reversion", strategy: return_reversal_count_reversion, input: { lookback: "15.4", crossingMin: "8" }, expected: { lookback: 15, crossingMin: 8 } },
    { key: "decay_pressure_percentile_reversion", strategy: decay_pressure_percentile_reversion, input: { lookback: "35", pctlExtreme: "0.88" }, expected: { lookback: 35, pctlExtreme: 0.88 } },
    { key: "close_location_streak_mean_reversion", strategy: close_location_streak_mean_reversion, input: { lookback: "4", streakMin: "4" }, expected: { lookback: 4, streakMin: 4 } },
    { key: "volatility_breakout_follow", strategy: volatility_breakout_follow, input: { lookback: "25", zThreshold: "1.9" }, expected: { lookback: 25, zThreshold: 1.9 } },
    { key: "atr_normalized_range_reversion", strategy: atr_normalized_range_reversion, input: { lookback: "20", shockPercentile: "0.95" }, expected: { lookback: 20, shockPercentile: 0.95 } },
    { key: "compression_ratio_expansion_reversion", strategy: compression_ratio_expansion_reversion, input: { lookback: "25", compressThreshold: "0.25", rangePercentileMin: "0.75" }, expected: { lookback: 25, compressThreshold: 0.25, rangePercentileMin: 0.75 } },
    { key: "entropy_decay_momentum_acceleration", strategy: entropy_decay_momentum_acceleration, input: { lookback: "25", entropyPercentileMax: "0.25" }, expected: { lookback: 25, entropyPercentileMax: 0.25 } },
    { key: "initiative_pressure_acceleration_follow", strategy: initiative_pressure_acceleration_follow, input: { lookback: "30", accThreshold: "0.35" }, expected: { lookback: 30, accThreshold: 0.35 } },
    { key: "skewness_reversal_momentum_ignite", strategy: skewness_reversal_momentum_ignite, input: { lookback: "35", skewChange: "0.90" }, expected: { lookback: 35, skewChange: 0.9 } },
    { key: "range_efficiency_regime_ignition", strategy: range_efficiency_regime_ignition, input: { lookback: "25", efficiencyMin: "0.55", rangePercentileMin: "0.80" }, expected: { lookback: 25, efficiencyMin: 0.55, rangePercentileMin: 0.8 } },
    { key: "volume_correlation_trend_follow", strategy: volume_correlation_trend_follow, input: { lookback: "25", correlationThreshold: "0.40" }, expected: { lookback: 25, correlationThreshold: 0.4 } },
    { key: "atr_adjusted_streak_momentum", strategy: atr_adjusted_streak_momentum, input: { lookback: "20", minStreak: "4" }, expected: { lookback: 20, minStreak: 4 } },
    { key: "wick_imbalance_thrust_continuation", strategy: wick_imbalance_thrust_continuation, input: { lookback: "25", maxWickPercentile: "0.30", rocZThreshold: "1.5" }, expected: { lookback: 25, maxWickPercentile: 0.3, rocZThreshold: 1.5 } },
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
