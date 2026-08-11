import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { climax_exhaustion_reversal } from "../../lib/strategies/lib/climax_exhaustion_reversal";
import { inefficient_spike_reversion } from "../../lib/strategies/lib/inefficient_spike_reversion";
import { multiscale_momentum_agreement } from "../../lib/strategies/lib/multiscale_momentum_agreement";
import { positive_skew_lottery_fade } from "../../lib/strategies/lib/positive_skew_lottery_fade";
import { quiet_drift_continuation } from "../../lib/strategies/lib/quiet_drift_continuation";
import { trailing_extreme_breakout } from "../../lib/strategies/lib/trailing_extreme_breakout";
import { trend_pullback_reentry } from "../../lib/strategies/lib/trend_pullback_reentry";
import { unsubstantiated_move_reversion } from "../../lib/strategies/lib/unsubstantiated_move_reversion";
import { vol_scaled_momentum } from "../../lib/strategies/lib/vol_scaled_momentum";
import { vwap_deviation_reversion } from "../../lib/strategies/lib/vwap_deviation_reversion";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Bars with a small oscillation around `base`, giving stable non-zero dispersion.
function oscBars(count: number, base: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = i % 2 === 0 ? base : base + 0.5;
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

// Flat closes (uniform range) so one-bar returns are exactly zero.
function flatCloses(count: number, close: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

const NEW_MOMENTUM_KEYS = [
    "vwap_deviation_reversion",
    "vol_scaled_momentum",
    "trend_pullback_reentry",
    "unsubstantiated_move_reversion",
    "climax_exhaustion_reversal",
    "trailing_extreme_breakout",
    "positive_skew_lottery_fade",
    "quiet_drift_continuation",
    "inefficient_spike_reversion",
    "multiscale_momentum_agreement",
];

describe("momentum regime strategy family", () => {
    it("registers all new momentum strategies in the built-in manifest", () => {
        for (const key of NEW_MOMENTUM_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(vwap_deviation_reversion.normalizeParams?.({ period: 3 })).to.deep.equal({ period: 5 });
        expect(vwap_deviation_reversion.normalizeParams?.({ period: 30 })).to.deep.equal({ period: 30 });

        expect(vol_scaled_momentum.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(vol_scaled_momentum.normalizeParams?.({ lookback: 45 })).to.deep.equal({ lookback: 45 });

        expect(trend_pullback_reentry.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(unsubstantiated_move_reversion.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(climax_exhaustion_reversal.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(trailing_extreme_breakout.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });

        expect(positive_skew_lottery_fade.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(quiet_drift_continuation.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(inefficient_spike_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(multiscale_momentum_agreement.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
    });

    it("vwap_deviation_reversion buys when close sits two ATRs below the VWAP anchor", () => {
        const data = [
            ...oscBars(30, 100),
            bar(30, 89.5, 91, 89, 90),
        ];
        const signals = vwap_deviation_reversion.execute(data, { period: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("vol_scaled_momentum buys exactly when the ATR-scaled move crosses the band", () => {
        const data = [...oscBars(45, 100)];
        let prevClose = data[data.length - 1].close;
        for (let k = 45; k <= 52; k++) {
            const open = prevClose + 0.25;
            const close = open + 1.5;
            const high = close + 0.25;
            const low = open - 0.25;
            data.push(bar(k, open, high, low, close)); // TR stays 2, ATR stays 2
            prevClose = close;
        }
        const signals = vol_scaled_momentum.execute(data, { lookback: 45 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(47);
    });

    it("trend_pullback_reentry buys a deep dip inside an uptrend", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 120; i++) {
            const close = 100 + 0.5 * i;
            data.push(bar(i, close - 0.25, close + 1, close - 1, close));
        }
        data.push(bar(120, 159, 159.5, 144, 145)); // pullback inside the uptrend
        const signals = trend_pullback_reentry.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(120);
    });

    it("unsubstantiated_move_reversion buys a large down move on bottom-third volume", () => {
        const data = [
            ...oscBars(60, 100),
            bar(60, 90, 92, 88, 90), // big drop, same low volume
        ];
        const signals = unsubstantiated_move_reversion.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });

    it("climax_exhaustion_reversal buys a range/volume climax bar pinned at its low", () => {
        const data = [
            ...oscBars(60, 100),
            bar(60, 90, 105, 90, 91, 5000), // huge range, volume surge, close at low
        ];
        const signals = climax_exhaustion_reversal.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });

    it("trailing_extreme_breakout buys exactly on the fresh close beyond the prior high", () => {
        const data = [
            ...flatCloses(56, 100),
            bar(56, 101, 102, 99.5, 102), // close beyond prior-only high 101
            bar(57, 101.5, 103, 101, 102.5),
        ];
        const signals = trailing_extreme_breakout.execute(data, { lookback: 55 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(56);
    });

    it("positive_skew_lottery_fade sells right-tail lottery regimes and buys left-tail crash regimes", () => {
        const upData = [...flatCloses(80, 100)];
        upData.push(bar(80, 99, 106, 99, 105));        // +5% returns
        upData.push(bar(81, 104, 111, 104, 110.25));
        upData.push(bar(82, 109.25, 116.25, 109.25, 115.7625));
        const upSignals = positive_skew_lottery_fade.execute(upData, { lookback: 60 });
        expect(upSignals).to.have.length(1);
        expect(upSignals[0].type).to.equal("sell");
        expect(upSignals[0].barIndex).to.equal(80);

        const downData = [...flatCloses(80, 100)];
        downData.push(bar(80, 101, 101, 95, 95));      // -5% returns
        downData.push(bar(81, 96, 96, 90.25, 90.25));
        downData.push(bar(82, 91.25, 91.25, 85.7375, 85.7375));
        const downSignals = positive_skew_lottery_fade.execute(downData, { lookback: 60 });
        expect(downSignals).to.have.length(1);
        expect(downSignals[0].type).to.equal("buy");
        expect(downSignals[0].barIndex).to.equal(80);
    });

    it("quiet_drift_continuation buys on entry into a high-efficiency, low-range up grind", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            const close = 100 + 1.5 * i;
            data.push(bar(i, close - 1.75, close + 0.25, close - 2, close));
        }
        const signals = quiet_drift_continuation.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("inefficient_spike_reversion buys a large drop whose path was disorderly", () => {
        const data = [
            ...oscBars(25, 100),
            bar(25, 97, 98.5, 96, 97), // drop on top of 25 choppy bars -> low efficiency
            bar(26, 96.5, 98, 96, 97), // stabilization at the low keeps the disorder certified
        ];
        const signals = inefficient_spike_reversion.execute(data, { lookback: 25 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(26);
    });

    it("multiscale_momentum_agreement buys on fresh fast and slow horizon agreement", () => {
        const data = [
            ...flatCloses(30, 100),
            bar(30, 100.5, 102, 100, 101),
            bar(31, 101.5, 103, 101, 102),
            bar(32, 102.5, 104, 102, 103),
        ];
        const signals = multiscale_momentum_agreement.execute(data, { lookback: 5 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });
});
