import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { atr_r_multiple_follow } from "../../lib/strategies/lib/atr_r_multiple_follow";
import { median_extreme_envelope_breakout } from "../../lib/strategies/lib/median_extreme_envelope_breakout";
import { gap_percentile_fade } from "../../lib/strategies/lib/gap_percentile_fade";
import { body_direction_autocorr_switch } from "../../lib/strategies/lib/body_direction_autocorr_switch";
import { deep_wick_reversal } from "../../lib/strategies/lib/deep_wick_reversal";
import { true_range_extreme_fade } from "../../lib/strategies/lib/true_range_extreme_fade";
import { atr_regime_follow } from "../../lib/strategies/lib/atr_regime_follow";
import { median_side_streak_follow } from "../../lib/strategies/lib/median_side_streak_follow";
import { dual_median_crossover } from "../../lib/strategies/lib/dual_median_crossover";
import { indecision_share_fade } from "../../lib/strategies/lib/indecision_share_fade";

const NEW_KEYS = [
    "atr_r_multiple_follow",
    "median_extreme_envelope_breakout",
    "gap_percentile_fade",
    "body_direction_autocorr_switch",
    "deep_wick_reversal",
    "true_range_extreme_fade",
    "atr_regime_follow",
    "median_side_streak_follow",
    "dual_median_crossover",
    "indecision_share_fade",
];

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

// Bars with no gaps, a fixed small range, and an optional alternating close.
function quietBars(count: number, base: number, range = 0.2, altClose = false): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = altClose && i % 2 === 1 ? base + 0.1 : base;
        bars.push(bar(i, close, close + range / 2, close - range / 2, close));
    }
    return bars;
}

describe("volatility impulse and envelope strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(atr_r_multiple_follow.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
        expect(median_extreme_envelope_breakout.normalizeParams?.({ lookback: 5.6 })).to.deep.equal({ lookback: 6 });
        expect(body_direction_autocorr_switch.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(dual_median_crossover.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(gap_percentile_fade.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
    });

    it("atr_r_multiple_follow buys a 2+ prior-ATR impulse bar", () => {
        const data = [...quietBars(25, 100), bar(25, 100, 101, 99.9, 101)];
        const signals = atr_r_multiple_follow.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(25);
    });

    it("median_extreme_envelope_breakout buys a close above the median of highs", () => {
        const data = [...quietBars(44, 99), bar(44, 100.5, 103, 100.4, 102.5)];
        const signals = median_extreme_envelope_breakout.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(44);
    });

    it("gap_percentile_fade buys an extreme negative reopen gap", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 50; i++) {
            // After the extreme gap bar, the next bar opens at the prior close so it
            // does not create a second extreme gap itself.
            const open = i === 40 ? 98 : i === 41 ? 98.5 : 100 + (i % 2 === 0 ? 0.001 : -0.001);
            const close = i === 40 ? 98.5 : 100;
            data.push(bar(i, open, Math.max(open, close) + 0.01, Math.min(open, close) - 0.01, close));
        }
        const signals = gap_percentile_fade.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("body_direction_autocorr_switch follows the current bar when bull/bear runs cluster", () => {
        const data: OHLCVData[] = [];
        // Balanced 4-bull / 4-bear blocks give a strongly positive lag-1 autocorrelation
        // with non-zero variance; the switch should then follow each bar's direction.
        for (let i = 0; i < 45; i++) {
            const bull = Math.floor(i / 4) % 2 === 0;
            const open = 100 + i * 0.05;
            const close = bull ? open + 0.4 : open - 0.4;
            data.push(bar(i, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close));
        }
        const signals = body_direction_autocorr_switch.execute(data, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            const isBullBar = data[signal.barIndex!].close > data[signal.barIndex!].open;
            if (signal.type === "buy") {
                expect(isBullBar, "buy must follow a bull bar").to.equal(true);
            } else {
                expect(isBullBar, "sell must follow a bear bar").to.equal(false);
            }
        }
    });

    it("deep_wick_reversal buys an extreme lower-wick rejection bar", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            data.push(bar(i, 100 + i * 0.05, 100 + i * 0.05 + 0.15, 100 + i * 0.05 - 0.05, 100 + i * 0.05 + 0.1));
        }
        data.push(bar(40, 102, 102.4, 99, 102.3));
        const signals = deep_wick_reversal.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("true_range_extreme_fade buys a huge down bar at a range extreme", () => {
        const data = [...quietBars(40, 100), bar(40, 101, 101.5, 98.5, 99)];
        const signals = true_range_extreme_fade.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("atr_regime_follow buys directional bars only inside the active ATR regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            data.push(bar(i, 100, 100.1, 99.9, i % 2 === 1 ? 100.1 : 100));
        }
        // A volatile stretch of up bars lifts ATR to a high percentile of its own history.
        for (let i = 30; i < 40; i++) {
            const open = data[i - 1].close;
            data.push(bar(i, open, open + 1.4, open - 0.1, open + 1.0));
        }
        const signals = atr_regime_follow.execute(data, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("median_side_streak_follow buys after three consecutive closes above the median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            data.push(bar(i, 100, 100, 100, 100));
        }
        for (let i = 30; i < 45; i++) {
            data.push(bar(i, 102, 102, 102, 102));
        }
        const signals = median_side_streak_follow.execute(data, { lookback: 40 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
        expect(signals[0].barIndex).to.be.greaterThanOrEqual(41);
    });

    it("dual_median_crossover buys the fast median crossing above the slow median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 60; i++) {
            data.push(bar(i, 100, 100, 100, 100));
        }
        for (let i = 60; i < 80; i++) {
            data.push(bar(i, 110, 110, 110, 110));
        }
        const signals = dual_median_crossover.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(69);
    });

    it("indecision_share_fade buys a down bar inside a doji-dominated window", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 35; i++) {
            data.push(bar(i, 100, 102, 98, 100));
        }
        data.push(bar(35, 100.5, 101, 98.5, 99));
        const signals = indecision_share_fade.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(35);
    });
});
