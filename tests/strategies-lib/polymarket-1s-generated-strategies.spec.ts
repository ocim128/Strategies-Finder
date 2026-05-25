import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, StrategyExecutionContext } from "../../lib/types/strategies";
import { strategyManifest } from "../../lib/strategies/manifest-eager";
import { entropy_volume_gated_no_adverse } from "../../lib/strategies/lib/entropy_volume_gated_no_adverse";
import { midpoint_deviation_no_adverse } from "../../lib/strategies/lib/midpoint_deviation_no_adverse";
import { micro_wick_exhaustion_executable_agreement } from "../../lib/strategies/lib/micro_wick_exhaustion_executable_agreement";
import { price_volume_correlation_break_gamma } from "../../lib/strategies/lib/price_volume_correlation_break_gamma";
import { volume_skewness_acceleration_no_adverse } from "../../lib/strategies/lib/volume_skewness_acceleration_no_adverse";
import { vw_typical_dispersion_no_adverse } from "../../lib/strategies/lib/vw_typical_dispersion_no_adverse";

const POLYMARKET_1S_ENTRIES = strategyManifest.filter((entry) => entry.strategy.polymarket1sConfig?.required);

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

function samplePolymarket1sContext(bars: OHLCVData[]): StrategyExecutionContext {
    return {
        polymarket1s: {
            symbol: "BTCUSDT",
            outcomeSymbol: "BTCUSDT",
            seriesId: "test-series",
            outcomeInterval: "5m",
            quotes: bars.map((bar) => ({
                series_id: "test-series",
                symbol: "BTCUSDT",
                outcome_interval: "5m",
                event_start_ts: 1,
                event_end_ts: bars.length + 20,
                sample_ts: Number(bar.time),
                yes_ask: 0.51,
                yes_mid: 0.5,
                no_ask: 0.51,
                no_mid: 0.5,
            })),
            gammaSnapshots: bars.map((bar) => ({
                series_id: "test-series",
                symbol: "BTCUSDT",
                outcome_interval: "5m",
                event_start_ts: 1,
                event_end_ts: bars.length + 20,
                snapshot_ts: Number(bar.time),
                gamma_yes_price: 0.55,
                gamma_no_price: 0.45,
            })),
        },
    };
}

describe("generated Polymarket 1s strategies", () => {
    it("require 1s context and fail closed when it is missing", () => {
        const bars = sampleBars(180);

        expect(POLYMARKET_1S_ENTRIES.length, "manifest has required Polymarket 1s strategies").to.be.greaterThan(0);
        for (const entry of POLYMARKET_1S_ENTRIES) {
            expect(entry.strategy.execute(bars, entry.strategy.defaultParams), `${entry.key} no-context signals`).to.deep.equal([]);
        }
    });

    it("keeps default params canonical and walk-forward params real", () => {
        expect(POLYMARKET_1S_ENTRIES.length, "manifest has required Polymarket 1s strategies").to.be.greaterThan(0);
        for (const entry of POLYMARKET_1S_ENTRIES) {
            const strategy = entry.strategy;
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${entry.key} normalized defaults`).to.deep.equal(strategy.defaultParams);

            const defaultKeys = Object.keys(strategy.defaultParams);
            expect(Object.keys(strategy.paramLabels), `${entry.key} param labels`).to.deep.equal(defaultKeys);
            for (const param of strategy.metadata?.walkForwardParams ?? []) {
                expect(defaultKeys, `${entry.key} walk-forward param ${param}`).to.include(param);
            }
        }
    });

    it("keeps prepared execution aligned with direct execution for hot no-adverse strategies", () => {
        const bars = sampleBars(180);
        const context = samplePolymarket1sContext(bars);
        const cases = [
            {
                key: "volume_skewness_acceleration_no_adverse",
                strategy: volume_skewness_acceleration_no_adverse,
                params: { lookback: 16, skewThreshold: 0 },
            },
            {
                key: "midpoint_deviation_no_adverse",
                strategy: midpoint_deviation_no_adverse,
                params: { lookback: 16, devThreshold: 0.5 },
            },
            {
                key: "price_volume_correlation_break_gamma",
                strategy: price_volume_correlation_break_gamma,
                params: { lookback: 16, volZThreshold: 0 },
            },
            {
                key: "micro_wick_exhaustion_executable_agreement",
                strategy: micro_wick_exhaustion_executable_agreement,
                params: { lookback: 16, wickRatio: 0.1 },
            },
            {
                key: "entropy_volume_gated_no_adverse",
                strategy: entropy_volume_gated_no_adverse,
                params: { lookback: 16, entropyThreshold: 1 },
            },
            {
                key: "vw_typical_dispersion_no_adverse",
                strategy: vw_typical_dispersion_no_adverse,
                params: { lookback: 16, threshold: 0.5 },
            },
        ];

        for (const testCase of cases) {
            const prepared = testCase.strategy.prepareFinderData!(bars, undefined, context);
            const directSignals = testCase.strategy.execute(bars, testCase.params, context);
            const preparedSignals = testCase.strategy.executePrepared!(prepared, testCase.params, bars, context);

            expect(preparedSignals, testCase.key).to.deep.equal(directSignals);
        }
    });
});
