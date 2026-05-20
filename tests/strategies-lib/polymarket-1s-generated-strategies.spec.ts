import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData } from "../../lib/types/strategies";
import { strategyManifest } from "../../lib/strategies/manifest-eager";

const NEW_POLYMARKET_1S_KEYS = [
    "volatility_regime_entropy_reaction_lag",
    "close_acceptance_decay_executable_persistence",
    "volume_thrust_kurtosis_pressure_gap",
    "event_open_distance_volatility_skew_consensus_gamma",
    "typical_price_autocorrelation_actionable_edge",
    "sweep_reclaim_efficiency_reaction_lag",
    "keltner_deviation_velocity_adverse_veto",
    "cumulative_decay_initiative_consensus_gamma",
    "rolling_skewness_kurtosis_executable_edge",
    "volume_weighted_entropy_reversal_reaction_lag",
    "volume_profile_value_area_breakout_executable_edge",
    "initiative_pressure_persistence_streak_pressure_gap",
    "close_midpoint_deviation_reversion_reaction_lag",
    "true_range_velocity_burst_reaction_lag",
    "sweep_reclaim_momentum_consensus_gamma",
    "initiative_autocorrelation_shock_pressure_gap",
    "typical_price_velocity_actionable_edge",
    "close_midpoint_dev_volume_adverse_veto",
    "event_open_volatility_compression_reaction_lag",
    "micro_efficiency_regime_actionable_edge",
] as const;

function sampleBars(length: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < length; i++) {
        const close = 100 + i * 0.05 + Math.sin(i / 4);
        const open = close - Math.cos(i / 5) * 0.4;
        bars.push({
            time: i + 1,
            open,
            high: Math.max(open, close) + 0.8,
            low: Math.min(open, close) - 0.8,
            close,
            volume: 1000 + (i % 9) * 75,
        });
    }
    return bars;
}

describe("generated Polymarket 1s strategies", () => {
    it("require 1s context and fail closed when it is missing", () => {
        const bars = sampleBars(180);

        for (const key of NEW_POLYMARKET_1S_KEYS) {
            const entry = strategyManifest.find((item) => item.key === key);
            expect(entry, `${key} manifest entry`).to.not.equal(undefined);
            expect(entry!.strategy.polymarket1sConfig?.required, `${key} required context`).to.equal(true);
            expect(entry!.strategy.execute(bars, entry!.strategy.defaultParams), `${key} no-context signals`).to.deep.equal([]);
        }
    });

    it("keeps default params canonical and walk-forward params real", () => {
        for (const key of NEW_POLYMARKET_1S_KEYS) {
            const entry = strategyManifest.find((item) => item.key === key);
            expect(entry, `${key} manifest entry`).to.not.equal(undefined);
            const strategy = entry!.strategy;
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${key} normalized defaults`).to.deep.equal(strategy.defaultParams);

            const defaultKeys = Object.keys(strategy.defaultParams);
            expect(Object.keys(strategy.paramLabels), `${key} param labels`).to.deep.equal(defaultKeys);
            for (const param of strategy.metadata?.walkForwardParams ?? []) {
                expect(defaultKeys, `${key} walk-forward param ${param}`).to.include(param);
            }
        }
    });
});
