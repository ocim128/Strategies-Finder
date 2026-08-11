import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_bias_drift } from "../../lib/strategies/lib/acceptance_bias_drift";
import { atr_normalized_spike_fade } from "../../lib/strategies/lib/atr_normalized_spike_fade";
import { cmf_pressure_regime_cross } from "../../lib/strategies/lib/cmf_pressure_regime_cross";
import { gap_streak_exhaustion } from "../../lib/strategies/lib/gap_streak_exhaustion";
import { intrabar_boundary_divergence } from "../../lib/strategies/lib/intrabar_boundary_divergence";
import { median_slope_thrust } from "../../lib/strategies/lib/median_slope_thrust";
import { midpoint_bias_persistence } from "../../lib/strategies/lib/midpoint_bias_persistence";
import { robust_zscore_typical_fade } from "../../lib/strategies/lib/robust_zscore_typical_fade";
import { volume_return_correlation_regime } from "../../lib/strategies/lib/volume_return_correlation_regime";
import { wick_absorption_reversal } from "../../lib/strategies/lib/wick_absorption_reversal";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Bars that close at their own midpoint (zero wick imbalance, close location 0.5).
function midpointBars(count: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        bars.push(bar(i, 100, 101, 99, 100));
    }
    return bars;
}

const NEW_ABSORPTION_KEYS = [
    "wick_absorption_reversal",
    "midpoint_bias_persistence",
    "robust_zscore_typical_fade",
    "volume_return_correlation_regime",
    "atr_normalized_spike_fade",
    "cmf_pressure_regime_cross",
    "acceptance_bias_drift",
    "median_slope_thrust",
    "intrabar_boundary_divergence",
    "gap_streak_exhaustion",
];

describe("absorption pressure strategy family", () => {
    it("registers all new absorption strategies in the built-in manifest", () => {
        for (const key of NEW_ABSORPTION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(wick_absorption_reversal.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(midpoint_bias_persistence.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 4 });
        expect(robust_zscore_typical_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });

        expect(volume_return_correlation_regime.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(atr_normalized_spike_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(cmf_pressure_regime_cross.normalizeParams?.({ period: 3 })).to.deep.equal({ period: 5 });

        expect(acceptance_bias_drift.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(median_slope_thrust.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(intrabar_boundary_divergence.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });

        expect(gap_streak_exhaustion.normalizeParams?.({ streakLength: 1 })).to.deep.equal({ streakLength: 2 });
        expect(gap_streak_exhaustion.normalizeParams?.({ streakLength: 3 })).to.deep.equal({ streakLength: 3 });
    });

    it("wick_absorption_reversal buys an extreme lower-wick bar whose close confirms the rejection", () => {
        const data = [
            ...midpointBars(40),
            bar(40, 100, 100.5, 95, 100.2), // dominant lower wick, close held high
        ];
        const signals = wick_absorption_reversal.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("midpoint_bias_persistence buys an unbroken run of closes above each bar's own midpoint", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 99.5, 101, 99, 101)); // close at high -> deviation +0.5
        }
        // One extra bar past the lookback so the crossing-count window is fully
        // real with a measurable predecessor (the signal loop requires it).
        const signals = midpoint_bias_persistence.execute(data, { lookback: 12 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(12);
    });

    it("robust_zscore_typical_fade buys a typical-price extreme under robust scaling", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            // Tiny alternating baseline so MAD is small but nonzero.
            data.push(bar(i, 100, 101, 99, i % 2 === 0 ? 99.9 : 100.1));
        }
        data.push(bar(40, 94.5, 96, 94, 95));
        const signals = robust_zscore_typical_fade.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("volume_return_correlation_regime buys when return-volume correlation crosses decisively positive", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        const volCycle = [2000, 1000, 1000, 2000];
        for (let i = 0; i < 90; i++) {
            const prev = close;
            close = i % 2 === 0 ? 101 : 100; // returns alternate +1%/-1% everywhere
            const volume = i < 60 ? volCycle[i % 4] : (i % 2 === 0 ? 2000 : 1000);
            // Before bar 60 volume is uncorrelated with return sign; after it, up
            // moves ride high volume and down moves low volume.
            data.push(bar(i, prev, Math.max(prev, close) + 0.5, Math.min(prev, close) - 0.5, close, volume));
        }
        const signals = volume_return_correlation_regime.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(73);
    });

    it("atr_normalized_spike_fade buys a down spike of at least two ATRs", () => {
        const data = [...midpointBars(14), bar(14, 99, 100, 94, 95)];
        const signals = atr_normalized_spike_fade.execute(data, { lookback: 14 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(14);
    });

    it("cmf_pressure_regime_cross buys when CMF pressure exits neutral upward", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            data.push(bar(i, 100, 101, 99, 99));  // close at low -> CMF -1
        }
        for (let i = 20; i < 40; i++) {
            data.push(bar(i, 100, 101, 99, 101)); // close at high -> CMF +1
        }
        const signals = cmf_pressure_regime_cross.execute(data, { period: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(31);
    });

    it("acceptance_bias_drift buys when the smoothed acceptance mean crosses the positive band", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 10; i++) {
            data.push(bar(i, 101, 101, 99, 99));  // full-bodied down -> acceptance -1
        }
        for (let i = 10; i < 22; i++) {
            data.push(bar(i, 99, 101, 99, 101));  // full-bodied up -> acceptance +1
        }
        const signals = acceptance_bias_drift.execute(data, { lookback: 10 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(16);
    });

    it("median_slope_thrust buys when the median slope z-score crosses above the band", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 45; i++) {
            data.push(bar(i, 99.5, 101, 99, 100)); // flat -> median frozen at 100
        }
        for (let i = 45; i < 61; i++) {
            const close = 100 + 10 * (i - 44);
            data.push(bar(i, close - 0.5, close + 1, close - 1, close));
        }
        // The 30-bar median only begins migrating once new values fill the
        // window (bar 59), so the first slope z-cross above the band lands at
        // bar 59 -- the median lags the price thrust by design.
        const signals = median_slope_thrust.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(59);
    });

    it("intrabar_boundary_divergence buys when intrabar recovery persistently offsets boundary mark-downs", () => {
        const data: OHLCVData[] = [];
        data.push(bar(0, 100, 100.5, 99.5, 100));
        let prevClose = 100;
        for (let i = 1; i < 25; i++) {
            const open = prevClose * 0.99;  // gap down 1%
            const close = open * 1.02;      // intrabar recovery +2%
            data.push(bar(i, open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close));
            prevClose = close;
        }
        const signals = intrabar_boundary_divergence.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(19);
    });

    it("gap_streak_exhaustion buys exactly when the down-gap run first reaches the threshold", () => {
        const data: OHLCVData[] = [];
        data.push(bar(0, 100, 100.5, 99.5, 100));
        let prevClose = 100;
        for (let i = 1; i < 10; i++) {
            const open = prevClose * 0.99;
            const close = open * 1.01;
            data.push(bar(i, open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close));
            prevClose = close;
        }
        const signals = gap_streak_exhaustion.execute(data, { streakLength: 3 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(3);
    });
});
