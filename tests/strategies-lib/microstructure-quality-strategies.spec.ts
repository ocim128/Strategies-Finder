import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_whipsaw_chop_fade } from "../../lib/strategies/lib/acceptance_whipsaw_chop_fade";
import { body_direction_streak_persistence_follow } from "../../lib/strategies/lib/body_direction_streak_persistence_follow";
import { close_location_skew_tail_follow } from "../../lib/strategies/lib/close_location_skew_tail_follow";
import { close_mean_median_cross_follow } from "../../lib/strategies/lib/close_mean_median_cross_follow";
import { initiative_pressure_climax_fade } from "../../lib/strategies/lib/initiative_pressure_climax_fade";
import { intrabar_rotation_persistence_follow } from "../../lib/strategies/lib/intrabar_rotation_persistence_follow";
import { open_location_continuation_follow } from "../../lib/strategies/lib/open_location_continuation_follow";
import { participation_squeeze_divergence } from "../../lib/strategies/lib/participation_squeeze_divergence";
import { range_autocorrelation_expansion_follow } from "../../lib/strategies/lib/range_autocorrelation_expansion_follow";
import { wick_return_correlation_quality_follow } from "../../lib/strategies/lib/wick_return_correlation_quality_follow";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_KEYS = [
    "close_mean_median_cross_follow",
    "range_autocorrelation_expansion_follow",
    "initiative_pressure_climax_fade",
    "participation_squeeze_divergence",
    "acceptance_whipsaw_chop_fade",
    "body_direction_streak_persistence_follow",
    "close_location_skew_tail_follow",
    "intrabar_rotation_persistence_follow",
    "wick_return_correlation_quality_follow",
    "open_location_continuation_follow",
];

describe("microstructure quality strategy family", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(close_mean_median_cross_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(range_autocorrelation_expansion_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(initiative_pressure_climax_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(participation_squeeze_divergence.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(acceptance_whipsaw_chop_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(body_direction_streak_persistence_follow.normalizeParams?.({ minStreak: 1 })).to.deep.equal({ minStreak: 2 });
        expect(body_direction_streak_persistence_follow.normalizeParams?.({ minStreak: 4 })).to.deep.equal({ minStreak: 4 });
        expect(close_location_skew_tail_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(intrabar_rotation_persistence_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(wick_return_correlation_quality_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(open_location_continuation_follow.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
    });

    it("close_mean_median_cross_follow buys when strong closes push the mean above the median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) {
            const close = i === 5 || i === 10 ? 95 : 100;
            data.push(bar(i, close, close + 0.5, close - 0.5, close));
        }
        for (let i = 24; i < 30; i++) data.push(bar(i, 100, 110.5, 99.5, 110));
        const signals = close_mean_median_cross_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(25);
    });

    it("range_autocorrelation_expansion_follow buys an expansion inside a volatility-clustering regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 12; i++) data.push(bar(i, 100, 100.5, 99.5, 100)); // quiet block
        for (let i = 12; i < 24; i++) data.push(bar(i, 100, 101.5, 98.5, 100)); // active block
        data.push(bar(24, 100, 103.5, 97.5, 103)); // expansion up bar
        data.push(bar(25, 103, 106.5, 100.5, 106));
        const signals = range_autocorrelation_expansion_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(25);
    });

    it("initiative_pressure_climax_fade buys a percentile-extreme selling climax", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100, 1000));
        data.push(bar(20, 101, 101, 99, 99, 2000)); // strong negative pressure on 2x volume
        const signals = initiative_pressure_climax_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });

    it("participation_squeeze_divergence buys a high-participation compressed up close", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            if (i % 2 === 0) data.push(bar(i, 100, 102, 98, 100, 1000));
            else data.push(bar(i, 100, 101, 99, 100, 1100));
        }
        data.push(bar(30, 100, 100.05, 99.95, 100.05, 5000));
        const signals = participation_squeeze_divergence.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("acceptance_whipsaw_chop_fade buys an extreme low close inside a whipsaw regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            if (i % 2 === 0) data.push(bar(i, 99, 101, 99, 101));
            else data.push(bar(i, 101, 101, 99, 99));
        }
        data.push(bar(30, 100.5, 101, 99, 99));
        const signals = acceptance_whipsaw_chop_fade.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("body_direction_streak_persistence_follow follows same-direction body runs, both sides", () => {
        const upData: OHLCVData[] = [];
        for (let i = 0; i < 4; i++) upData.push(bar(i, 100, 101, 100, 101));
        const upSignals = body_direction_streak_persistence_follow.execute(upData, { minStreak: 4 });
        expect(upSignals).to.have.length(1);
        expect(upSignals[0].type).to.equal("buy");
        expect(upSignals[0].barIndex).to.equal(3);

        const downData: OHLCVData[] = [];
        for (let i = 0; i < 4; i++) downData.push(bar(i, 101, 101, 100, 100));
        const downSignals = body_direction_streak_persistence_follow.execute(downData, { minStreak: 4 });
        expect(downSignals).to.have.length(1);
        expect(downSignals[0].type).to.equal("sell");
        expect(downSignals[0].barIndex).to.equal(3);
    });

    it("close_location_skew_tail_follow buys when close-placement skew crosses into the positive tail", () => {
        const data: OHLCVData[] = [];
        data.push(bar(0, 100, 101, 99, 100.7)); // close loc 0.85
        for (let i = 1; i <= 16; i++) data.push(bar(i, 100, 101, 99, 99.6)); // close loc 0.3
        for (let i = 17; i < 24; i++) data.push(bar(i, 100, 101, 99, 100.7)); // close loc 0.85
        data.push(bar(24, 100, 101, 99, 99.6)); // a low replaces a high: skew rises past +0.8
        const signals = close_location_skew_tail_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });

    it("intrabar_rotation_persistence_follow buys persistent bullish open-to-close rotation", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) data.push(bar(i, 100, 100.5, 99.5, 100));
        for (let i = 24; i < 28; i++) data.push(bar(i, 99, 101, 99, 101)); // open at low, close at high
        const signals = intrabar_rotation_persistence_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(27);
    });

    it("wick_return_correlation_quality_follow buys up bars aligned with functional wick absorption", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 26; i++) {
            if (i % 2 === 0) data.push(bar(i, 100, 100.5, 98.5, 100.4)); // lower-wick dominance, up
            else data.push(bar(i, 100, 101.5, 99.6, 99.6)); // upper-wick dominance, down
        }
        const signals = wick_return_correlation_quality_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });

    it("open_location_continuation_follow buys an extreme low open the close confirms upward", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            const open = i % 2 === 0 ? 99.9 : 100.05;
            data.push(bar(i, open, 101, 99, 100));
        }
        data.push(bar(20, 99, 101.5, 98.9, 101)); // open at prior low, close at high
        const signals = open_location_continuation_follow.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });
});
