import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { breakout_retest_entry } from "../../lib/strategies/lib/breakout_retest_entry";
import { capitulation_streak_fade } from "../../lib/strategies/lib/capitulation_streak_fade";
import { cmf_persistent_accumulation } from "../../lib/strategies/lib/cmf_persistent_accumulation";
import { dual_anchor_discount } from "../../lib/strategies/lib/dual_anchor_discount";
import { first_excursion_reversion } from "../../lib/strategies/lib/first_excursion_reversion";
import { intrabar_carry_drift } from "../../lib/strategies/lib/intrabar_carry_drift";
import { post_spike_stabilization } from "../../lib/strategies/lib/post_spike_stabilization";
import { rejection_confirmed_depth_fade } from "../../lib/strategies/lib/rejection_confirmed_depth_fade";
import { volume_dryup_trend_pullback } from "../../lib/strategies/lib/volume_dryup_trend_pullback";
import { zscore_turn_confirmation } from "../../lib/strategies/lib/zscore_turn_confirmation";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Bars with close = high and a small oscillation around `base`, giving a stable
// non-zero dispersion for z-scores while keeping a real ATR/range.
function oscBars(count: number, base: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = i % 2 === 0 ? base : base + 0.5;
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

const NEW_CONFIRMATION_KEYS = [
    "zscore_turn_confirmation",
    "first_excursion_reversion",
    "post_spike_stabilization",
    "dual_anchor_discount",
    "intrabar_carry_drift",
    "cmf_persistent_accumulation",
    "volume_dryup_trend_pullback",
    "rejection_confirmed_depth_fade",
    "breakout_retest_entry",
    "capitulation_streak_fade",
];

describe("confirmation entry strategy family", () => {
    it("registers all new confirmation strategies in the built-in manifest", () => {
        for (const key of NEW_CONFIRMATION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(zscore_turn_confirmation.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(zscore_turn_confirmation.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });

        expect(first_excursion_reversion.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(post_spike_stabilization.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });

        expect(dual_anchor_discount.normalizeParams?.({ period: 5 })).to.deep.equal({ period: 10 });
        expect(dual_anchor_discount.normalizeParams?.({ period: 30 })).to.deep.equal({ period: 30 });

        expect(intrabar_carry_drift.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(cmf_persistent_accumulation.normalizeParams?.({ period: 3 })).to.deep.equal({ period: 5 });

        expect(volume_dryup_trend_pullback.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });

        expect(rejection_confirmed_depth_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(breakout_retest_entry.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });

        expect(capitulation_streak_fade.normalizeParams?.({ streakLength: 1 })).to.deep.equal({ streakLength: 2 });
        expect(capitulation_streak_fade.normalizeParams?.({ streakLength: 3 })).to.deep.equal({ streakLength: 3 });
    });

    it("zscore_turn_confirmation buys only after the extreme z crosses back inside the band", () => {
        const data = [
            ...oscBars(60, 100),
            bar(60, 94.5, 96, 94, 95),   // robust z well below -2
            bar(61, 100, 101, 99, 100.2), // z back inside the band -> buy
            bar(62, 100, 101, 99, 100.4),
        ];
        const signals = zscore_turn_confirmation.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(61);
    });

    it("first_excursion_reversion sells only the window's first band excursion", () => {
        const data = [
            ...oscBars(119, 100),
            bar(119, 109, 111, 108, 110), // first crossing to z >= 2 -> sell
            bar(120, 108, 110, 107, 109),
        ];
        const signals = first_excursion_reversion.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("sell");
        expect(signals[0].barIndex).to.equal(119);
    });

    it("post_spike_stabilization buys a panic bar only when the next open does not gap down", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 60; i++) {
            const close = 100 + Math.sin(i / 4) * 0.5;
            data.push(bar(i, close - 0.2, close + 1, close - 1, close));
        }
        data.push(bar(60, 89, 91, 88, 90));      // panic bar (return z <= -2)
        data.push(bar(61, 90, 91, 89, 90.5));    // flat open -> stabilizing -> buy
        const signals = post_spike_stabilization.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(61);
    });

    it("dual_anchor_discount buys when both the median and VWAP anchors agree the ratio is discounted", () => {
        const data = [
            ...oscBars(30, 100),
            bar(30, 89.5, 91, 89, 90), // deep discount below median and VWAP
        ];
        const signals = dual_anchor_discount.execute(data, { period: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("intrabar_carry_drift buys exactly on the band-entry edge of the carry mean", () => {
        // 12 negative intrabar bars then +0.0025: the 20-bar mean sits at 0.0004
        // before the edge bar and 0.000575 after it, clear of the 0.0005 band.
        const data: OHLCVData[] = [];
        for (let i = 0; i < 12; i++) {
            data.push(bar(i, 100, 100.5, 99.4, 99.9));   // intrabar -0.001
        }
        for (let i = 12; i < 41; i++) {
            data.push(bar(i, 100, 100.7, 99.7, 100.25)); // intrabar +0.0025
        }
        const signals = intrabar_carry_drift.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });

    it("cmf_persistent_accumulation buys on state entry when the whole-window CMF min clears the floor", () => {
        const data = oscBars(60, 100).map((b) => ({ ...b, close: 101, high: 101 }));
        const signals = cmf_persistent_accumulation.execute(data, { period: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(38);
    });

    it("volume_dryup_trend_pullback buys a shallow pullback inside an uptrend on dry volume", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 120; i++) {
            const close = 100 + 0.5 * i;
            data.push(bar(i, close - 0.25, close + 1, close - 1, close));
        }
        data.push(bar(120, 159, 159.5, 149, 150)); // pullback inside the uptrend
        const signals = volume_dryup_trend_pullback.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(120);
    });

    it("rejection_confirmed_depth_fade buys a deep discount only when the extreme bar shows lower-wick rejection", () => {
        const data = [
            ...oscBars(60, 100),
            bar(60, 100, 100.5, 93, 99), // deep drop with dominant lower wick
        ];
        const signals = rejection_confirmed_depth_fade.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });

    it("breakout_retest_entry buys the first retest of a broken prior high", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 55; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(55, 101, 102, 99.5, 102));   // break above prior high 101
        data.push(bar(56, 101, 102, 100.5, 101.5)); // retest holds -> buy
        const signals = breakout_retest_entry.execute(data, { lookback: 55 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(56);
    });

    it("capitulation_streak_fade buys exactly when a down streak hits the threshold on a volume surge", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 60; i++) {
            data.push(bar(i, 99.5, 101, 99, 100));
        }
        data.push(bar(60, 98.5, 100, 98, 99, 5000));
        data.push(bar(61, 97.5, 99, 97, 98, 5000));
        data.push(bar(62, 96.5, 98, 96, 97, 5000));
        const signals = capitulation_streak_fade.execute(data, { streakLength: 3 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(62);
    });
});
