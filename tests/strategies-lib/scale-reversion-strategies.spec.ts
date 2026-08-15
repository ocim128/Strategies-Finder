import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_extreme_reversion } from "../../lib/strategies/lib/acceptance_extreme_reversion";
import { channel_edge_reversion } from "../../lib/strategies/lib/channel_edge_reversion";
import { efficiency_collapse_reversion } from "../../lib/strategies/lib/efficiency_collapse_reversion";
import { entropy_chop_gated_reversion } from "../../lib/strategies/lib/entropy_chop_gated_reversion";
import { expansion_failure_reversion } from "../../lib/strategies/lib/expansion_failure_reversion";
import { median_atr_stretch_reversion } from "../../lib/strategies/lib/median_atr_stretch_reversion";
import { roc_threshold_reversion } from "../../lib/strategies/lib/roc_threshold_reversion";
import { weighted_close_z_reversion } from "../../lib/strategies/lib/weighted_close_z_reversion";
import { wick_defended_extreme_fade } from "../../lib/strategies/lib/wick_defended_extreme_fade";
import { wick_ratio_extreme_fade } from "../../lib/strategies/lib/wick_ratio_extreme_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

function barsFromCloses(closes: number[]): OHLCVData[] {
    return closes.map((close, i) => {
        const open = i === 0 ? close - 0.5 : closes[i - 1];
        return bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close);
    });
}

const NEW_SCALE_REVERSION_KEYS = [
    "median_atr_stretch_reversion",
    "roc_threshold_reversion",
    "acceptance_extreme_reversion",
    "channel_edge_reversion",
    "entropy_chop_gated_reversion",
    "weighted_close_z_reversion",
    "wick_ratio_extreme_fade",
    "efficiency_collapse_reversion",
    "expansion_failure_reversion",
    "wick_defended_extreme_fade",
];

describe("scale reversion strategy candidates", () => {
    it("registers all new scale-reversion strategies in the built-in manifest", () => {
        for (const key of NEW_SCALE_REVERSION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(median_atr_stretch_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(median_atr_stretch_reversion.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(roc_threshold_reversion.normalizeParams?.({ lookback: 0.6 })).to.deep.equal({ lookback: 1 });
        expect(roc_threshold_reversion.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(acceptance_extreme_reversion.normalizeParams?.({ threshold: 0.05 })).to.deep.equal({ threshold: 0.1 });
        expect(acceptance_extreme_reversion.normalizeParams?.({ threshold: 0.95 })).to.deep.equal({ threshold: 0.9 });
        expect(acceptance_extreme_reversion.normalizeParams?.({ threshold: 0.5 })).to.deep.equal({ threshold: 0.5 });
        expect(channel_edge_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(channel_edge_reversion.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(entropy_chop_gated_reversion.normalizeParams?.({ lookback: 2.6 })).to.deep.equal({ lookback: 3 });
        expect(entropy_chop_gated_reversion.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(weighted_close_z_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(weighted_close_z_reversion.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(wick_ratio_extreme_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(wick_ratio_extreme_fade.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(efficiency_collapse_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(efficiency_collapse_reversion.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(expansion_failure_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(expansion_failure_reversion.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(wick_defended_extreme_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(wick_defended_extreme_fade.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
    });

    it("median_atr_stretch_reversion buys closes stretched at least 2 ATR below the rolling median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            const close = i % 2 === 0 ? 101 : 102;
            const open = i % 2 === 0 ? 102 : 101;
            data.push(bar(i, open, 102.4, 100, close));
        }
        data.push(bar(20, 102, 102.2, 94.8, 95)); // flush well below the median
        for (let i = 21; i < 30; i++) {
            const close = i % 2 === 0 ? 101 : 102;
            const open = i % 2 === 0 ? 102 : 101;
            data.push(bar(i, open, 102.4, 100, close));
        }
        const signals = median_atr_stretch_reversion.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 20 },
        ]);
    });

    it("roc_threshold_reversion fades lookback returns beyond the fixed fractional band", () => {
        const upCloses: number[] = [];
        const downCloses: number[] = [];
        for (let i = 0; i < 30; i++) {
            upCloses.push(100 + i);
            downCloses.push(200 - 2 * i);
        }
        const sellSignals = roc_threshold_reversion.execute(barsFromCloses(upCloses), { lookback: 8 });
        expect(sellSignals.length).to.be.greaterThan(0);
        expect(sellSignals[0].barIndex).to.equal(9);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
        const buySignals = roc_threshold_reversion.execute(barsFromCloses(downCloses), { lookback: 8 });
        expect(buySignals.length).to.be.greaterThan(0);
        expect(buySignals[0].barIndex).to.equal(9);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("acceptance_extreme_reversion fades extreme settlement scores on both sides", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 5; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(5, 100, 100.5, 93.5, 94)); // extreme bearish settlement
        for (let i = 6; i < 10; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(10, 100, 106.5, 99.5, 106)); // extreme bullish settlement
        const signals = acceptance_extreme_reversion.execute(data, { threshold: 0.5 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 5 },
            { type: "sell", barIndex: 10 },
        ]);
    });

    it("channel_edge_reversion buys/sells closes pinned at the trailing channel edges", () => {
        const closes: number[] = [];
        for (let i = 0; i < 9; i++) {
            closes.push(100);
        }
        closes.push(105); // pin at the channel high
        closes.push(99); // pin at the channel low
        for (let i = 11; i < 30; i++) {
            closes.push(100.5);
        }
        const signals = channel_edge_reversion.execute(barsFromCloses(closes), { lookback: 8 });
        expect(signals.some((s) => s.barIndex === 9 && s.type === "sell"), "channel high pin should fade short").to.equal(true);
        expect(signals.some((s) => s.barIndex === 10 && s.type === "buy"), "channel low pin should fade long").to.equal(true);
    });

    it("entropy_chop_gated_reversion buys stretched closes only in a high-entropy chop regime", () => {
        const closes: number[] = [];
        for (let i = 0; i < 15; i++) {
            closes.push(i % 2 === 0 ? 100 : 101);
        }
        closes.push(98); // sharp drop with balanced prior signs
        const signals = entropy_chop_gated_reversion.execute(barsFromCloses(closes), { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 15 },
        ]);
    });

    it("weighted_close_z_reversion fades weighted-close z-score extremes", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(20, 100, 100.5, 93.5, 94)); // weighted close far below the window
        const signals = weighted_close_z_reversion.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 20 },
        ]);
    });

    it("wick_ratio_extreme_fade buys when the lower-wick share of total wick sits at an extreme percentile", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 100, 100.5, 95.5, 99)); // lower-wick dominated
        const signals = wick_ratio_extreme_fade.execute(data, { lookback: 8 });
        expect(signals.some((s) => s.barIndex === 14 && s.type === "buy"), "lower-wick dominated bar should fade long").to.equal(true);
    });

    it("efficiency_collapse_reversion fades the stretched close when efficiency collapses", () => {
        const closes: number[] = [];
        for (let i = 0; i < 14; i++) {
            closes.push(100 + i);
        }
        const data = barsFromCloses(closes);
        data.push(bar(14, 113, 114, 104, 105)); // efficiency collapse with stretched close
        data.push(bar(15, 105, 105.5, 103.5, 104));
        const signals = efficiency_collapse_reversion.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("expansion_failure_reversion fades a high-percentile range bar closing against its body", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 102, 103, 95, 99.3)); // bearish expansion closing upper-half
        const signals = expansion_failure_reversion.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("wick_defended_extreme_fade buys an extreme low print with the lows defended by wick imbalance", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 100.5, 100.8, 95, 95.8)); // close pinned low, lower wick dominant
        const signals = wick_defended_extreme_fade.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });
});
