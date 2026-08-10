import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { zero_wick_conviction_bar } from "../../lib/strategies/lib/zero_wick_conviction_bar";
import { open_through_prior_extreme } from "../../lib/strategies/lib/open_through_prior_extreme";
import { body_dominance_streak_follow } from "../../lib/strategies/lib/body_dominance_streak_follow";
import { gap_atr_extreme_continuation } from "../../lib/strategies/lib/gap_atr_extreme_continuation";
import { doji_symmetry_reversal } from "../../lib/strategies/lib/doji_symmetry_reversal";
import { close_location_compression_break } from "../../lib/strategies/lib/close_location_compression_break";
import { full_bar_engulfment } from "../../lib/strategies/lib/full_bar_engulfment";
import { efficiency_ratio_choppiness_breakout } from "../../lib/strategies/lib/efficiency_ratio_choppiness_breakout";
import { wick_rejection_pressure } from "../../lib/strategies/lib/wick_rejection_pressure";
import { return_sign_consistency_trend } from "../../lib/strategies/lib/return_sign_consistency_trend";

const NEW_STRATEGY_KEYS = [
    "zero_wick_conviction_bar",
    "open_through_prior_extreme",
    "body_dominance_streak_follow",
    "gap_atr_extreme_continuation",
    "doji_symmetry_reversal",
    "close_location_compression_break",
    "full_bar_engulfment",
    "efficiency_ratio_choppiness_breakout",
    "wick_rejection_pressure",
    "return_sign_consistency_trend",
];

const NEW_STRATEGIES = [
    zero_wick_conviction_bar,
    open_through_prior_extreme,
    body_dominance_streak_follow,
    gap_atr_extreme_continuation,
    doji_symmetry_reversal,
    close_location_compression_break,
    full_bar_engulfment,
    efficiency_ratio_choppiness_breakout,
    wick_rejection_pressure,
    return_sign_consistency_trend,
];

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

describe("structural / momentum strategy family", () => {
    it("registers all new structural strategies in the built-in manifest", () => {
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

    it("zero_wick_conviction_bar buys zero-lower-wick bullish bars and sells zero-upper-wick bearish bars", () => {
        const data = [
            bar(0, 100, 101, 99, 100.5),
            bar(1, 100, 101, 100, 100.2), // zero lower wick, large upper wick, bullish
            bar(2, 100, 100, 99, 99.8),   // zero upper wick, large lower wick, bearish
            bar(3, 100, 101, 99, 100.5),
        ];
        const signals = zero_wick_conviction_bar.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([1, 2]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("wick_rejection_pressure buys large upper wicks with zero lower wicks and vice versa", () => {
        const data = [
            bar(0, 100, 101, 99, 100.5),
            bar(1, 100, 101, 100, 100.2), // upper wick 0.8, lower wick 0
            bar(2, 100, 100, 99, 99.8),   // lower wick 0.8, upper wick 0
            bar(3, 100, 101, 99, 100.5),
        ];
        const signals = wick_rejection_pressure.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([1, 2]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("open_through_prior_extreme buys opens through the prior high and sells opens through the prior low", () => {
        const data = [
            bar(0, 100, 101, 99, 100.5),
            bar(1, 101.5, 103, 101, 102), // open >= prior high, bullish close
            bar(2, 102, 103.5, 101.5, 102.5),
            bar(3, 100.5, 101.5, 99.5, 100), // open <= prior low, bearish close
        ];
        const signals = open_through_prior_extreme.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([1, 3]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("full_bar_engulfment buys complete upward OHLC domination and sells complete downward domination", () => {
        const data = [
            bar(0, 100, 102, 99, 101),
            bar(1, 102, 104, 101, 103), // all four OHLC above prior
            bar(2, 100, 102, 98, 99),   // all four OHLC below prior
            bar(3, 99, 101, 98, 100.5),
        ];
        const signals = full_bar_engulfment.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([1, 2]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("body_dominance_streak_follow buys after 3 consecutive body-dominant bullish bars", () => {
        const data: OHLCVData[] = [bar(0, 100, 101, 99, 100)];
        for (let i = 1; i <= 4; i++) {
            data.push(bar(i, 100, 101, 99.95, 100.95)); // bodyPct ~0.905 > 0.90
        }
        const signals = body_dominance_streak_follow.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([3, 4]);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("gap_atr_extreme_continuation buys confirmed gaps above 2x ATR and sells confirmed gaps below -2x ATR", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(20, 110, 112, 109, 111)); // +10 gap, bullish close
        data.push(bar(21, 100, 101, 98, 99));   // -11 gap, bearish close
        const signals = gap_atr_extreme_continuation.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("doji_symmetry_reversal follows the resolution of a symmetric doji", () => {
        const data = [
            bar(0, 100, 101, 99, 100.05), // symmetric doji: body 0.05, wicks balanced
            bar(1, 100, 101, 99.5, 100.8), // bullish resolution
            bar(2, 100, 101, 99, 100.05), // symmetric doji again
            bar(3, 100, 100.5, 99, 99.2), // bearish resolution
        ];
        const signals = doji_symmetry_reversal.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([1, 3]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });

    it("efficiency_ratio_choppiness_breakout buys the chop-to-trend crossing with a positive return", () => {
        const closes: number[] = [];
        for (let i = 0; i < 20; i++) closes.push(i % 2 === 0 ? 100 : 101); // oscillating chop
        for (let i = 20; i < 30; i++) closes.push(100 + (i - 19) * 3); // monotonic rise
        const data = closes.map((close, i) => bar(i, close - 0.5, close + 1, close - 1, close));

        const signals = efficiency_ratio_choppiness_breakout.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(21);
    });

    it("return_sign_consistency_trend buys when over 75% of recent returns are positive", () => {
        const closes: number[] = [100];
        for (let block = 0; block < 4; block++) {
            closes.push(closes[closes.length - 1] + 1);
            closes.push(closes[closes.length - 1] + 1);
            closes.push(closes[closes.length - 1] + 1);
            closes.push(closes[closes.length - 1] + 1);
            closes.push(closes[closes.length - 1] - 1);
        }
        const data = closes.map((close, i) => bar(i, close - 0.5, close + 1, close - 1, close));
        const signals = return_sign_consistency_trend.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20]);
        expect(signals[0].type).to.equal("buy");
    });

    it("close_location_compression_break buys when compression breaks downward in proportion", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 15; i++) data.push(bar(i, 100, 101, 99, 100)); // cl 0.5: compressed
        for (let i = 15; i < 30; i++) data.push(bar(i, 100, 101, 99, 100.6)); // cl 0.8: break bars
        const signals = close_location_compression_break.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(25);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });
});
