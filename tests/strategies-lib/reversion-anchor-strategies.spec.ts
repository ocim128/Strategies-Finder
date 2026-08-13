import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { ar1_residual_reversion } from "../../lib/strategies/lib/ar1_residual_reversion";
import { adaptive_threshold_reversion } from "../../lib/strategies/lib/adaptive_threshold_reversion";
import { confirmed_reversion_fade } from "../../lib/strategies/lib/confirmed_reversion_fade";
import { stationary_center_fade } from "../../lib/strategies/lib/stationary_center_fade";
import { quiet_regime_reversion } from "../../lib/strategies/lib/quiet_regime_reversion";
import { window_open_anchor_reversion } from "../../lib/strategies/lib/window_open_anchor_reversion";
import { dislocation_extreme_fade } from "../../lib/strategies/lib/dislocation_extreme_fade";
import { double_stretch_exhaustion_fade } from "../../lib/strategies/lib/double_stretch_exhaustion_fade";
import { stretch_percentile_fade } from "../../lib/strategies/lib/stretch_percentile_fade";
import { climax_volume_reversion } from "../../lib/strategies/lib/climax_volume_reversion";

const NEW_KEYS = [
    "ar1_residual_reversion",
    "adaptive_threshold_reversion",
    "confirmed_reversion_fade",
    "stationary_center_fade",
    "quiet_regime_reversion",
    "window_open_anchor_reversion",
    "dislocation_extreme_fade",
    "double_stretch_exhaustion_fade",
    "stretch_percentile_fade",
    "climax_volume_reversion",
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

function flat(count: number, close: number, halfRange = 0.1, volume = 1000): OHLCVData[] {
    const data: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        data.push(bar(i, close, close + halfRange, close - halfRange, close, volume));
    }
    return data;
}

describe("reversion and anchor-fade strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(ar1_residual_reversion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(adaptive_threshold_reversion.normalizeParams?.({ decay: 0.1 })).to.deep.equal({ decay: 0.5 });
        expect(adaptive_threshold_reversion.normalizeParams?.({ decay: 0.9999 })).to.deep.equal({ decay: 0.999 });
        expect(confirmed_reversion_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(stationary_center_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(quiet_regime_reversion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(window_open_anchor_reversion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(dislocation_extreme_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(double_stretch_exhaustion_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(stretch_percentile_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(climax_volume_reversion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
    });

    it("ar1_residual_reversion buys a close shock below its own AR(1) forecast", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 35; i++) {
            const close = 100 + 0.1 * i;
            data.push(bar(i, close - 0.1, close + 0.05, close - 0.1, close));
        }
        data.push(bar(35, 103.4, 103.4, 99, 99));
        data.push(bar(36, 99, 99.1, 98.9, 99));
        data.push(bar(37, 99, 99.1, 98.9, 99));
        const signals = ar1_residual_reversion.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(35);
    });

    it("adaptive_threshold_reversion buys a crash far below the decay center", () => {
        const data = [...flat(60, 100), bar(60, 100, 100.1, 84.9, 85)];
        const signals = adaptive_threshold_reversion.execute(data, { decay: 0.95 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(60);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("confirmed_reversion_fade buys only once the dislocation starts collapsing", () => {
        const flat40 = flat(40, 100);
        const recovery = [
            ...flat40,
            bar(40, 100, 100.1, 91.9, 92),
            bar(41, 92, 93.1, 91.9, 93),
            bar(42, 93, 94.6, 92.9, 94.5),
            bar(43, 94.5, 96.6, 94.4, 96.5),
            bar(44, 96.5, 97.6, 96.4, 97.5),
            bar(45, 97.5, 98.6, 97.4, 98.5),
            bar(46, 98.5, 99.4, 98.4, 99.3),
        ];
        const signals = confirmed_reversion_fade.execute(recovery, { lookback: 40 });
        expect(signals).to.have.length(3);
        expect(signals[0].barIndex).to.equal(43);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }

        // A continued crash never shows a positive stretch ROC, so no signals.
        const continued = [
            ...flat40,
            bar(40, 100, 100.1, 94.9, 95),
            bar(41, 95, 95.1, 92.9, 93),
            bar(42, 93, 93.1, 90.9, 91),
            bar(43, 91, 91.1, 88.9, 89),
        ];
        expect(confirmed_reversion_fade.execute(continued, { lookback: 40 })).to.have.length(0);
    });

    it("stationary_center_fade fades stretches only around a stationary median", () => {
        const flat80 = flat(80, 100);
        const down = [...flat80, bar(80, 100, 100.1, 95.9, 96)];
        const buySignals = stationary_center_fade.execute(down, { lookback: 40 });
        expect(buySignals.length).to.be.greaterThan(0);
        expect(buySignals[0].barIndex).to.equal(80);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
        const up = [...flat80, bar(80, 100, 104.1, 99.9, 104)];
        const sellSignals = stationary_center_fade.execute(up, { lookback: 40 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("quiet_regime_reversion fades only when ATR percentile is low", () => {
        // Loud start (TR 1.0) makes ATR fall monotonically once the drift begins,
        // so the drift bars sit at percentile 0 while the median still lags.
        const loud = flat(50, 100, 0.5);
        const drift: OHLCVData[] = [];
        for (let i = 50; i < 60; i++) {
            const open = 100 - 0.3 * (i - 50);
            const close = open - 0.3;
            drift.push(bar(i, open, open + 0.05, close - 0.05, close));
        }
        const hold = flat(25, 97, 0.05);
        const quietData = [...loud, ...drift, ...hold];
        const signals = quiet_regime_reversion.execute(quietData, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(54);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }

        // Quiet start then loud drift: ATR percentile stays high, so no fades.
        const quiet = flat(50, 100, 0.05);
        const loudDrift: OHLCVData[] = [];
        for (let i = 50; i < 60; i++) {
            const open = 100 - 0.3 * (i - 50);
            const close = open - 0.3;
            loudDrift.push(bar(i, open, open + 1.0, close - 1.0, close));
        }
        expect(quiet_regime_reversion.execute([...quiet, ...loudDrift], { lookback: 30 })).to.have.length(0);
    });

    it("window_open_anchor_reversion fades stretches from the fixed window open", () => {
        const flat25 = flat(25, 100);
        const down = [...flat25, bar(25, 100, 100.1, 89.9, 90)];
        const buySignals = window_open_anchor_reversion.execute(down, { lookback: 20 });
        expect(buySignals.length).to.be.greaterThan(0);
        expect(buySignals[0].barIndex).to.equal(25);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
        const up = [...flat25, bar(25, 100, 110.1, 99.9, 110)];
        const sellSignals = window_open_anchor_reversion.execute(up, { lookback: 20 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("dislocation_extreme_fade buys the bar that sets a new prior-only stretch record", () => {
        const flat35 = flat(35, 100);
        const data = [...flat35, bar(35, 100, 100.1, 94.9, 95)];
        const signals = dislocation_extreme_fade.execute(data, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(35);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("double_stretch_exhaustion_fade buys the second consecutive stretched bar only", () => {
        const flat35 = flat(35, 100);
        const data = [...flat35, bar(35, 100, 100.1, 96.9, 97), bar(36, 97, 97.1, 96.9, 97)];
        const signals = double_stretch_exhaustion_fade.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(36);
    });

    it("stretch_percentile_fade fades the extremes of each pair's own stretch distribution", () => {
        const flat40 = flat(40, 100);
        const down = [...flat40, bar(40, 100, 100.1, 94.9, 95)];
        const buySignals = stretch_percentile_fade.execute(down, { lookback: 40 });
        expect(buySignals.length).to.be.greaterThan(0);
        expect(buySignals[0].barIndex).to.equal(40);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
        const up = [...flat40, bar(40, 100, 105.1, 99.9, 105)];
        const sellSignals = stretch_percentile_fade.execute(up, { lookback: 40 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("climax_volume_reversion fades stretched bars printed on climax relative volume", () => {
        const flat35 = flat(35, 100);
        const down = [...flat35, bar(35, 100, 100.1, 94.9, 95, 5000)];
        const buySignals = climax_volume_reversion.execute(down, { lookback: 30 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(35);
        const up = [...flat35, bar(35, 100, 105.1, 99.9, 105, 5000)];
        const sellSignals = climax_volume_reversion.execute(up, { lookback: 30 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(35);
    });
});
