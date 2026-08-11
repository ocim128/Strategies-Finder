import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { atr_normalized_return_reversion } from "../../lib/strategies/lib/atr_normalized_return_reversion";
import { channel_boundary_acceptance_follow } from "../../lib/strategies/lib/channel_boundary_acceptance_follow";
import { efficient_trend_pullback_entry } from "../../lib/strategies/lib/efficient_trend_pullback_entry";
import { extreme_move_reversal_fade } from "../../lib/strategies/lib/extreme_move_reversal_fade";
import { multi_horizon_momentum_agreement } from "../../lib/strategies/lib/multi_horizon_momentum_agreement";
import { range_envelope_spring_follow } from "../../lib/strategies/lib/range_envelope_spring_follow";
import { return_momentum_acceleration_follow } from "../../lib/strategies/lib/return_momentum_acceleration_follow";
import { strong_body_trend_follow } from "../../lib/strategies/lib/strong_body_trend_follow";
import { typical_price_envelope_breakout } from "../../lib/strategies/lib/typical_price_envelope_breakout";
import { volume_confirmed_trend_follow } from "../../lib/strategies/lib/volume_confirmed_trend_follow";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Steady monotonic rise at +step per bar with a fixed range around the close.
function riseBars(count: number, step: number, from = 100): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = from;
    for (let i = 0; i < count; i++) {
        const open = close;
        close = close + step;
        data.push(bar(i, open, close + 0.1, open - 0.1, close));
    }
    return data;
}

const NEW_KEYS = [
    "atr_normalized_return_reversion",
    "return_momentum_acceleration_follow",
    "efficient_trend_pullback_entry",
    "channel_boundary_acceptance_follow",
    "typical_price_envelope_breakout",
    "strong_body_trend_follow",
    "volume_confirmed_trend_follow",
    "extreme_move_reversal_fade",
    "multi_horizon_momentum_agreement",
    "range_envelope_spring_follow",
];

describe("trend and breakout strategy family", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(atr_normalized_return_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(return_momentum_acceleration_follow.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(efficient_trend_pullback_entry.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 15 });
        expect(channel_boundary_acceptance_follow.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(typical_price_envelope_breakout.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(strong_body_trend_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(volume_confirmed_trend_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(extreme_move_reversal_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(multi_horizon_momentum_agreement.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(range_envelope_spring_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
    });

    it("atr_normalized_return_reversion buys a multi-bar drop of more than three ATRs", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) data.push(bar(i, 100, 101, 99, 100));
        let close = 100;
        for (let i = 25; i < 30; i++) {
            const open = close;
            close = close - 1.5;
            data.push(bar(i, open, open, close - 0.5, close));
        }
        const signals = atr_normalized_return_reversion.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(29);
    });

    it("return_momentum_acceleration_follow buys when positive momentum re-accelerates", () => {
        const data = [
            ...riseBars(48, 0.5), // ends at close 124.0
            ...riseBars(20, 0.1, 124), // slowdown: momentum decelerates but stays positive
            ...riseBars(15, 0.5, 126), // re-acceleration: acceleration crosses zero
        ];
        const signals = return_momentum_acceleration_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(82);
    });

    it("efficient_trend_pullback_entry buys a pullback to the center inside an efficient uptrend", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 60; i++) {
            const open = close;
            close = close + 2;
            data.push(bar(i, open, close + 10, open - 10, close)); // ER 1, ATR ~20
        }
        for (let i = 60; i < 65; i++) {
            const open = close;
            close = close - 2;
            data.push(bar(i, open, close + 10, open - 10, close));
        }
        const signals = efficient_trend_pullback_entry.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(64);
    });

    it("channel_boundary_acceptance_follow buys a bar that pokes and settles beyond the prior high", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 21; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(21, 100, 102, 99, 102));
        const signals = channel_boundary_acceptance_follow.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(21);
    });

    it("typical_price_envelope_breakout buys a typical price clearing the prior-only envelope", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(25, 100, 105, 100, 103));
        const signals = typical_price_envelope_breakout.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(25);
    });

    it("strong_body_trend_follow buys a full-bodied bar above the trend median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 100.5, 99.5, 100));
        data.push(bar(20, 100, 102, 100, 102));
        const signals = strong_body_trend_follow.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });

    it("volume_confirmed_trend_follow buys a top-participation up bar above the median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) data.push(bar(i, 100, 100.5, 99.5, 100, i % 2 === 0 ? 1000 : 1100));
        data.push(bar(30, 100, 102, 100, 102, 5000));
        const signals = volume_confirmed_trend_follow.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("extreme_move_reversal_fade buys an extreme down move only when the bar reverses", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 100.5, 99.5, 100));
        let close = 100;
        for (let i = 20; i < 39; i++) {
            const open = close;
            close = close - 0.5;
            data.push(bar(i, open, open * 1.001, close * 0.999, close));
        }
        data.push(bar(39, 68, 70.5, 67.5, 70)); // crash bar that closes up: reversal
        const signals = extreme_move_reversal_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(39);
    });

    it("multi_horizon_momentum_agreement buys a fast turn with slow-horizon agreement", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) data.push(bar(i, 100, 100.5, 99.5, 100));
        let close = 100;
        for (let i = 40; i < 55; i++) {
            const open = close;
            close = close + 0.2;
            data.push(bar(i, open, close + 0.1, open - 0.1, close));
        }
        const signals = multi_horizon_momentum_agreement.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("range_envelope_spring_follow buys a range-floor squeeze bar closing at its high", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            if (i % 2 === 0) data.push(bar(i, 100, 102, 98, 100));
            else data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(30, 100, 100.05, 99.95, 100.05));
        const signals = range_envelope_spring_follow.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });
});
