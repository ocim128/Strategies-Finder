import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { close_location_extreme_fade_chop } from "../../lib/strategies/lib/close_location_extreme_fade_chop";
import { short_return_streak_fade_chop } from "../../lib/strategies/lib/short_return_streak_fade_chop";
import { alternating_return_regime_follow } from "../../lib/strategies/lib/alternating_return_regime_follow";
import { doji_resolution_in_compression } from "../../lib/strategies/lib/doji_resolution_in_compression";

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

function closesToBars(closes: number[]): OHLCVData[] {
    return closes.map((close, i) => bar(i, close - 0.5, close + 1, close - 1, close));
}

const CHOP_STRATEGY_KEYS = [
    "close_location_extreme_fade_chop",
    "short_return_streak_fade_chop",
    "efficiency_spike_fade_chop",
    "range_percentile_extreme_fade_chop",
    "median_deviation_fade_chop",
    "wick_rejection_at_range_edge",
    "alternating_return_regime_follow",
    "short_term_overextension_fade",
    "body_proportion_fade_low_vol",
    "doji_resolution_in_compression",
];

describe("chop fade strategy family", () => {
    it("registers all new chop strategies in the built-in manifest", () => {
        for (const key of CHOP_STRATEGY_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("close_location_extreme_fade_chop buys at bottom-extreme closes and sells at top-extreme closes", () => {
        const data = [
            bar(0, 100, 101, 99, 100),      // close location 0.50
            bar(1, 100, 101, 99, 99.1),     // close location 0.05 -> buy
            bar(2, 100, 101, 99, 100.9),    // close location 0.95 -> sell
            bar(3, 100, 101, 99, 100),      // close location 0.50
        ];
        const signals = close_location_extreme_fade_chop.execute(data, {});
        expect(signals).to.have.length(2);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(1);
        expect(signals[1].type).to.equal("sell");
        expect(signals[1].barIndex).to.equal(2);
    });

    it("short_return_streak_fade_chop buys after three consecutive negative returns", () => {
        const data = closesToBars([100, 99, 98, 97, 96, 97]);
        const signals = short_return_streak_fade_chop.execute(data, {});
        expect(signals).to.have.length(2);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
        expect(signals.map((s) => s.barIndex)).to.deep.equal([3, 4]);
    });

    it("alternating_return_regime_follow fades the current return in high-oscillation regimes", () => {
        // Strictly alternating closes: the oscillation regime is always active.
        const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
        const data = closesToBars(closes);
        const signals = alternating_return_regime_follow.execute(data, { lookback: 10 });

        expect(signals.length).to.be.greaterThan(0);
        const lastSignal = signals[signals.length - 1];
        // Final bar closes down from the prior bar -> fade the negative return with a buy.
        expect(lastSignal.barIndex).to.equal(data.length - 1);
        expect(lastSignal.type).to.equal("buy");
        // The bar before it closes up -> fade the positive return with a sell.
        const sellSignals = signals.filter((s) => s.type === "sell");
        expect(sellSignals.some((s) => s.barIndex === data.length - 2)).to.equal(true);
    });

    it("doji_resolution_in_compression buys the bearish resolution of a doji in low volatility", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 22; i++) {
            data.push(bar(i, 100, 101, 99, 100)); // doji-like bars, uniform range -> low range percentile
        }
        data.push(bar(22, 100, 100.5, 98.5, 99)); // bearish resolution after the prior doji
        const signals = doji_resolution_in_compression.execute(data, {});
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(22);
    });
});
