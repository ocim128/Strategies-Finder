import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { open_prior_close_gap_zscore } from "../../lib/strategies/lib/open_prior_close_gap_zscore";
import { wick_asymmetry_ratio_fade } from "../../lib/strategies/lib/wick_asymmetry_ratio_fade";
import { high_low_efficiency_divergence } from "../../lib/strategies/lib/high_low_efficiency_divergence";
import { close_location_rate_of_change } from "../../lib/strategies/lib/close_location_rate_of_change";
import { intra_to_inter_bar_volatility_ratio } from "../../lib/strategies/lib/intra_to_inter_bar_volatility_ratio";
import { streak_to_magnitude_ratio } from "../../lib/strategies/lib/streak_to_magnitude_ratio";
import { bar_range_percentile_regime } from "../../lib/strategies/lib/bar_range_percentile_regime";
import { open_location_zscore_reversion } from "../../lib/strategies/lib/open_location_zscore_reversion";

const NEW_STRATEGY_KEYS = [
    "open_prior_close_gap_zscore",
    "wick_asymmetry_ratio_fade",
    "high_low_efficiency_divergence",
    "close_location_rate_of_change",
    "intra_to_inter_bar_volatility_ratio",
    "streak_to_magnitude_ratio",
    "bar_range_percentile_regime",
    "open_location_zscore_reversion",
];

const NEW_STRATEGIES = [
    open_prior_close_gap_zscore,
    wick_asymmetry_ratio_fade,
    high_low_efficiency_divergence,
    close_location_rate_of_change,
    intra_to_inter_bar_volatility_ratio,
    streak_to_magnitude_ratio,
    bar_range_percentile_regime,
    open_location_zscore_reversion,
];

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

describe("divergence / ratio strategy family", () => {
    it("registers all new divergence strategies in the built-in manifest", () => {
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
            data.push(bar(i, open, Math.max(open, close) + 0.8, Math.min(open, close) - 0.8, close));
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

    it("open_prior_close_gap_zscore fades extreme upward and downward gaps", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(25, 105, 106, 104, 105)); // +5 gap
        data.push(bar(26, 100, 101, 99, 100)); // -5 gap
        const signals = open_prior_close_gap_zscore.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([25, 26]);
        expect(signals[0].type).to.equal("sell");
        expect(signals[1].type).to.equal("buy");
    });

    it("wick_asymmetry_ratio_fade fades extreme wick ratio percentile bars", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100)); // balanced wicks
        data.push(bar(20, 100, 102, 100, 100)); // upper wick dominates
        data.push(bar(21, 100, 100, 98, 100)); // lower wick dominates
        const signals = wick_asymmetry_ratio_fade.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("high_low_efficiency_divergence buys when highs trend cleanly while lows stay choppy", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            data.push(bar(i, 100, 100 + i, 98 + (i % 2) * 4, 100));
        }
        const signals = high_low_efficiency_divergence.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        // First signal lands one bar after warm-up due to the loop's i-1 guard.
        expect(signals[0].barIndex).to.equal(21);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("close_location_rate_of_change buys when rolling close location accelerates upward", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 10; i++) data.push(bar(i, 100, 101, 99, 99.4)); // close location 0.2
        for (let i = 10; i < 30; i++) data.push(bar(i, 100, 101, 99, 100.8)); // close location 0.9
        const signals = close_location_rate_of_change.execute(data, { lookback: 15 });
        expect(signals.length).to.be.greaterThan(0);
        // First signal lands one bar after warm-up due to the loop's i-1 guard.
        expect(signals[0].barIndex).to.equal(20);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("intra_to_inter_bar_volatility_ratio follows bars absorbing disproportionate volatility", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            const close = 100 + (i % 2);
            data.push(bar(i, close, close + 0.5, close - 0.5, close));
        }
        data.push(bar(20, 105, 108, 102, 106.5)); // range 6, bullish close
        data.push(bar(21, 103, 104.5, 100.5, 101)); // range 4, bearish close
        const signals = intra_to_inter_bar_volatility_ratio.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("streak_to_magnitude_ratio follows explosive short-streak moves", () => {
        const closes: number[] = [100];
        for (let i = 1; i <= 24; i++) {
            closes.push(closes[closes.length - 1] * (i % 2 ? 1.02 : 0.98));
        }
        const data = closes.map((close, i) => bar(i, close - 0.5, close + 1, close - 1, close));
        const signals = streak_to_magnitude_ratio.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        // First signal lands one bar after warm-up due to the loop's i-1 guard.
        expect(signals[0].barIndex).to.equal(20);
        expect(signals[0].type).to.equal("sell");
        expect(signals[1].barIndex).to.equal(21);
        expect(signals[1].type).to.equal("buy");
    });

    it("bar_range_percentile_regime follows top-percentile range expansions in the close direction", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(20, 100, 105, 95, 104)); // range 10, bullish close
        data.push(bar(21, 104, 106, 95, 96)); // range 11, bearish close
        const signals = bar_range_percentile_regime.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("open_location_zscore_reversion fades extreme open locations when the close reverses", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(20, 99, 101.5, 99, 101)); // opened at prior low, closed above midpoint
        data.push(bar(21, 101, 101.5, 99, 99)); // opened at prior high, closed below midpoint
        const signals = open_location_zscore_reversion.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });
});
