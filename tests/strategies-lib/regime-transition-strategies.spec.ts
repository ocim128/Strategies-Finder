import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { return_volume_correlation_divergence } from "../../lib/strategies/lib/return_volume_correlation_divergence";
import { kurtosis_expansion_breakout } from "../../lib/strategies/lib/kurtosis_expansion_breakout";
import { return_zero_crossing_frequency_reversal } from "../../lib/strategies/lib/return_zero_crossing_frequency_reversal";
import { skewness_compression_fade } from "../../lib/strategies/lib/skewness_compression_fade";
import { wick_ratio_percentile_exhaustion } from "../../lib/strategies/lib/wick_ratio_percentile_exhaustion";
import { close_location_gradient_persistence } from "../../lib/strategies/lib/close_location_gradient_persistence";
import { initiative_pressure_streak_continuation } from "../../lib/strategies/lib/initiative_pressure_streak_continuation";
import { body_proportion_autocorrelation_regime } from "../../lib/strategies/lib/body_proportion_autocorrelation_regime";
import { range_percentile_efficiency_continuation } from "../../lib/strategies/lib/range_percentile_efficiency_continuation";

const NEW_STRATEGY_KEYS = [
    "return_volume_correlation_divergence",
    "kurtosis_expansion_breakout",
    "return_zero_crossing_frequency_reversal",
    "skewness_compression_fade",
    "wick_ratio_percentile_exhaustion",
    "close_location_gradient_persistence",
    "initiative_pressure_streak_continuation",
    "body_proportion_autocorrelation_regime",
    "range_percentile_efficiency_continuation",
];

const NEW_STRATEGIES = [
    return_volume_correlation_divergence,
    kurtosis_expansion_breakout,
    return_zero_crossing_frequency_reversal,
    skewness_compression_fade,
    wick_ratio_percentile_exhaustion,
    close_location_gradient_persistence,
    initiative_pressure_streak_continuation,
    body_proportion_autocorrelation_regime,
    range_percentile_efficiency_continuation,
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

/** Bar with an exact body proportion p (open at the low, close above it). */
function bodyBar(time: number, p: number): OHLCVData {
    return bar(time, 99, 101, 99, 99 + 2 * p);
}

describe("regime transition strategy family", () => {
    it("registers all new regime strategies in the built-in manifest", () => {
        for (const key of NEW_STRATEGY_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("executes every new strategy with default params without throwing", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 260; i++) {
            close = close + Math.sin(i / 4) * 0.6 + (i < 130 ? 0.15 : -0.1);
            const open = close - Math.sin(i / 5) * 0.4;
            data.push(bar(i, open, Math.max(open, close) + 0.8, Math.min(open, close) - 0.8, close, 1000 + (i % 7) * 40));
        }

        for (let index = 0; index < NEW_STRATEGIES.length; index++) {
            const signals = NEW_STRATEGIES[index].execute(data, NEW_STRATEGIES[index].defaultParams);
            expect(signals, `${NEW_STRATEGY_KEYS[index]} signals`).to.be.an("array");
            for (const signal of signals) {
                expect(signal.type === "buy" || signal.type === "sell", `${NEW_STRATEGY_KEYS[index]} signal type`).to.equal(true);
                expect(signal.barIndex, `${NEW_STRATEGY_KEYS[index]} signal barIndex`).to.be.a("number");
            }
        }
    });

    it("return_volume_correlation_divergence buys when returns and volume changes are strongly correlated", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        let volume = 1000;
        for (let i = 0; i < 25; i++) {
            close = close * (1 + (i % 2 ? 0.02 : 0.01));
            volume = volume * (1 + (i % 2 ? 0.2 : 0.1));
            data.push(bar(i, close - 0.5, close + 1, close - 1, close, volume));
        }
        const signals = return_volume_correlation_divergence.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(20);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("kurtosis_expansion_breakout buys the kurtosis percentile crossing above 0.80 with a positive return", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            const close = 100 + (i % 2) * 0.001;
            data.push(bar(i, close, close + 0.5, close - 0.5, close));
        }
        const lastClose = (data[29].close as number) * 1.05;
        data.push(bar(30, lastClose - 0.5, lastClose + 1, lastClose - 1, lastClose));

        const signals = kurtosis_expansion_breakout.execute(data, { lookback: 25 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("return_zero_crossing_frequency_reversal follows rare-crossing trends and fades the first move out of chop", () => {
        // Rare crossings: monotonic rise.
        const rising = Array.from({ length: 25 }, (_, i) => bar(i, 99.5 + i, 101.5 + i, 99 + i, 100 + i));
        const trendSignals = return_zero_crossing_frequency_reversal.execute(rising, { lookback: 20 });
        expect(trendSignals[0].barIndex).to.equal(20);
        expect(trendSignals[0].type).to.equal("buy");

        // Frequent crossings: alternating returns.
        const alternating: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 25; i++) {
            close = close * (1 + (i % 2 ? 0.01 : -0.01));
            alternating.push(bar(i, close - 0.5, close + 1, close - 1, close));
        }
        const chopSignals = return_zero_crossing_frequency_reversal.execute(alternating, { lookback: 20 });
        // First signal lands one bar after warm-up due to the loop's i-1 guard.
        expect(chopSignals[0].barIndex).to.equal(20);
        expect(chopSignals[0].type).to.equal("sell");
        expect(chopSignals[1].barIndex).to.equal(21);
        expect(chopSignals[1].type).to.equal("buy");
    });

    it("skewness_compression_fade buys when negative skewness recovers toward zero", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        data.push(bar(0, close, close + 1, close - 1, close));
        for (let i = 1; i <= 24; i++) {
            close = close * (1 + (i % 2 ? 0.012 : 0.01));
            data.push(bar(i, close - 0.5, close + 1, close - 1, close));
        }
        close = close * 0.9; // negative skew outlier
        data.push(bar(25, close - 0.5, close + 1, close - 1, close));
        for (let i = 26; i <= 50; i++) {
            close = close * (1 + (i % 2 ? 0.012 : 0.01));
            data.push(bar(i, close - 0.5, close + 1, close - 1, close));
        }

        const signals = skewness_compression_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(45);
    });

    it("wick_ratio_percentile_exhaustion buys extreme lower-wick ratios and sells extreme upper-wick ratios", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(20, 100, 100, 99, 100)); // lower wick ratio 1.0
        data.push(bar(21, 100, 101, 100, 100)); // upper wick ratio 1.0
        const signals = wick_ratio_percentile_exhaustion.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("close_location_gradient_persistence buys after the configured streak of high close locations", () => {
        const data = [
            bar(0, 100, 101, 99, 100), // close location 0.5
            bar(1, 100, 101, 99, 100.6), // close location 0.8
            bar(2, 100, 101, 99, 100.6),
            bar(3, 100, 101, 99, 100.6),
            bar(4, 100, 101, 99, 100.6),
            bar(5, 100, 101, 99, 100.6),
        ];
        const signals = close_location_gradient_persistence.execute(data, { lookback: 5 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([5]);
        expect(signals[0].type).to.equal("buy");
    });

    it("initiative_pressure_streak_continuation buys after 3 consecutive positive-pressure bars", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) {
            data.push(bar(i, 99, 101, 99, 101, 1000)); // bullish marubozu
        }
        const signals = initiative_pressure_streak_continuation.execute(data, { lookback: 20 });
        expect(signals[0].barIndex).to.equal(21);
        expect(signals[0].type).to.equal("buy");
    });

    it("body_proportion_autocorrelation_regime buys the negative-to-positive autocorrelation transition", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bodyBar(i, i % 2 ? 0.9 : 0.1)); // alternating
        for (let i = 20; i < 60; i++) {
            const p = Math.max(0.02, Math.min(0.98, 0.5 + 0.4 * Math.sin(((i - 20) * Math.PI) / 4)));
            data.push(bodyBar(i, p));
        }
        const signals = body_proportion_autocorrelation_regime.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(35);
    });

    it("range_percentile_efficiency_continuation buys high-range expansions with efficiency and bullish close", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            const close = 100 + i;
            data.push(bar(i, close - 0.5, close + 1, close - 1, close));
        }
        data.push(bar(20, 110, 115, 105, 114)); // range 10
        data.push(bar(21, 110, 113, 108, 112)); // range 5
        const signals = range_percentile_efficiency_continuation.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(21);
    });
});
