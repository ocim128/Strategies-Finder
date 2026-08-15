import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { body_streak_break_fade } from "../../lib/strategies/lib/body_streak_break_fade";
import { conviction_follow_through } from "../../lib/strategies/lib/conviction_follow_through";
import { expansion_exhaustion_fade } from "../../lib/strategies/lib/expansion_exhaustion_fade";
import { fast_decay_momentum_memory } from "../../lib/strategies/lib/fast_decay_momentum_memory";
import { immediate_range_break_acceptance } from "../../lib/strategies/lib/immediate_range_break_acceptance";
import { one_bar_return_percentile_fade } from "../../lib/strategies/lib/one_bar_return_percentile_fade";
import { rejection_confirmation_pair } from "../../lib/strategies/lib/rejection_confirmation_pair";
import { smoothed_acceptance_regime_flip } from "../../lib/strategies/lib/smoothed_acceptance_regime_flip";
import { volume_acceleration_confirmation } from "../../lib/strategies/lib/volume_acceleration_confirmation";
import { volume_climax_failure_fade } from "../../lib/strategies/lib/volume_climax_failure_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_SHORT_HORIZON_KEYS = [
    "fast_decay_momentum_memory",
    "rejection_confirmation_pair",
    "immediate_range_break_acceptance",
    "conviction_follow_through",
    "expansion_exhaustion_fade",
    "volume_climax_failure_fade",
    "one_bar_return_percentile_fade",
    "volume_acceleration_confirmation",
    "body_streak_break_fade",
    "smoothed_acceptance_regime_flip",
];

describe("short horizon strategy candidates", () => {
    it("registers all new short-horizon strategies in the built-in manifest", () => {
        for (const key of NEW_SHORT_HORIZON_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(fast_decay_momentum_memory.normalizeParams?.({ decay: -0.5 })).to.deep.equal({ decay: 0.01 });
        expect(fast_decay_momentum_memory.normalizeParams?.({ decay: 1.5 })).to.deep.equal({ decay: 1 });
        expect(fast_decay_momentum_memory.normalizeParams?.({ decay: 0.6 })).to.deep.equal({ decay: 0.6 });
        expect(rejection_confirmation_pair.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(rejection_confirmation_pair.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(immediate_range_break_acceptance.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(immediate_range_break_acceptance.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(conviction_follow_through.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(conviction_follow_through.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(expansion_exhaustion_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(expansion_exhaustion_fade.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(volume_climax_failure_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(volume_climax_failure_fade.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(one_bar_return_percentile_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(one_bar_return_percentile_fade.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(volume_acceleration_confirmation.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(volume_acceleration_confirmation.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(body_streak_break_fade.normalizeParams?.({ streakMin: 1.6 })).to.deep.equal({ streakMin: 2 });
        expect(body_streak_break_fade.normalizeParams?.({ streakMin: 3 })).to.deep.equal({ streakMin: 3 });
        expect(smoothed_acceptance_regime_flip.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(smoothed_acceptance_regime_flip.normalizeParams?.({ lookback: 6 })).to.deep.equal({ lookback: 6 });
    });

    it("fast_decay_momentum_memory buys as soon as decayed return pressure crosses the fixed threshold", () => {
        const closes: number[] = [];
        for (let i = 0; i < 16; i++) {
            closes.push(100 * Math.pow(1.01, i));
        }
        const data = closes.map((close, i) => bar(i, i === 0 ? close - 0.5 : closes[i - 1], close + 1, close - 1, close));
        const signals = fast_decay_momentum_memory.execute(data, { decay: 0.6 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(4);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("rejection_confirmation_pair buys a defended low confirmed by next-bar acceptance", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(13, 100, 100.5, 96, 99)); // extreme lower wick, lows defended
        data.push(bar(14, 98.5, 101.5, 98, 101)); // bullish acceptance confirmation
        const signals = rejection_confirmation_pair.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("immediate_range_break_acceptance buys a percentile-ranked decisive break of the prior bar's range", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 100, 104, 99.5, 103.5));
        const signals = immediate_range_break_acceptance.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("conviction_follow_through buys the same-direction bar after a conviction bar", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(13, 98, 101.2, 97.8, 101)); // high body-proportion bullish conviction bar
        data.push(bar(14, 100.5, 102.3, 100, 102)); // same-direction follow through
        const signals = conviction_follow_through.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("expansion_exhaustion_fade buys when the bar after an expansion closes lower-third", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(13, 100, 104, 96, 100)); // expansion bar
        data.push(bar(14, 100, 100.5, 96.8, 97.5)); // rejected close in the lower third
        const signals = expansion_exhaustion_fade.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("volume_climax_failure_fade buys a bearish climax bar that closed upper-half", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 100.5, 99.5, 100, 1000));
        }
        data.push(bar(14, 102, 102.5, 95, 99, 5000)); // extreme volume, bearish body, upper-half close
        const signals = volume_climax_failure_fade.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("one_bar_return_percentile_fade fades extreme one-bar returns at the percentile bands", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 14; i++) {
            const move = i % 2 === 0 ? 0.002 : -0.002;
            const next = close * (1 + move);
            data.push(bar(i, close, Math.max(close, next) + 1, Math.min(close, next) - 1, next));
            close = next;
        }
        data.push(bar(14, close, close * 1.005, close * 0.955, close * 0.97)); // extreme gap down
        close = data[14].close;
        for (let i = 15; i < 21; i++) {
            const move = i % 2 === 0 ? 0.002 : -0.002;
            const next = close * (1 + move);
            data.push(bar(i, close, Math.max(close, next) + 1, Math.min(close, next) - 1, next));
            close = next;
        }
        data.push(bar(21, close, close * 1.055, close * 1.045, close * 1.05)); // extreme gap up

        const signals = one_bar_return_percentile_fade.execute(data, { lookback: 8 });
        expect(signals.some((s) => s.barIndex === 14 && s.type === "buy"), "extreme down bar should be faded long").to.equal(true);
        expect(signals.some((s) => s.barIndex === 21 && s.type === "sell"), "extreme up bar should be faded short").to.equal(true);
    });

    it("volume_acceleration_confirmation buys when the volume percentile jumps on a bullish bar", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100, 1000));
        }
        data.push(bar(14, 99, 101.5, 98.5, 101, 5000));
        for (let i = 15; i < 30; i++) {
            data.push(bar(i, 100, 101, 99, 100, 1000));
        }
        const signals = volume_acceleration_confirmation.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("body_streak_break_fade fades the streak the moment the opposite body breaks it", () => {
        const data = [
            bar(0, 101, 101.5, 99.5, 100),
            bar(1, 100, 100.5, 98.5, 99),
            bar(2, 99, 99.5, 97.5, 98),
            bar(3, 98, 100, 97.5, 99.5),
            bar(4, 99.5, 101.5, 99, 101),
            bar(5, 101, 103, 100.5, 102.5),
            bar(6, 102.5, 104.5, 102, 104),
            bar(7, 104, 104.5, 102.5, 103),
        ];
        const signals = body_streak_break_fade.execute(data, { streakMin: 3 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 3 },
            { type: "sell", barIndex: 7 },
        ]);
    });

    it("smoothed_acceptance_regime_flip buys the short smoothed acceptance zero-cross", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 5; i++) {
            data.push(bar(i, 101, 101.5, 99.5, 100)); // bearish acceptance bars
        }
        data.push(bar(5, 100, 103.5, 99.5, 103)); // strong bullish bar
        data.push(bar(6, 103, 106.5, 102.5, 106)); // sustained bullish bar flips the average
        const signals = smoothed_acceptance_regime_flip.execute(data, { lookback: 4 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 6 },
        ]);
    });
});
