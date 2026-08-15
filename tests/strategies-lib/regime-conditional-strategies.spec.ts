import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_flip_expansion_reversal } from "../../lib/strategies/lib/acceptance_flip_expansion_reversal";
import { atr_scaled_decisive_breakout } from "../../lib/strategies/lib/atr_scaled_decisive_breakout";
import { efficiency_gated_pullback_recovery } from "../../lib/strategies/lib/efficiency_gated_pullback_recovery";
import { efficiency_regime_adaptive_router } from "../../lib/strategies/lib/efficiency_regime_adaptive_router";
import { flush_recovery_reversal } from "../../lib/strategies/lib/flush_recovery_reversal";
import { quiet_stretch_median_reversion } from "../../lib/strategies/lib/quiet_stretch_median_reversion";
import { trend_freshness_momentum } from "../../lib/strategies/lib/trend_freshness_momentum";
import { volatility_pulse_directional_continuation } from "../../lib/strategies/lib/volatility_pulse_directional_continuation";
import { volume_confirmed_breakout } from "../../lib/strategies/lib/volume_confirmed_breakout";
import { wick_absorption_placement_fade } from "../../lib/strategies/lib/wick_absorption_placement_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

function barsFromCloses(closes: number[], volume: number | ((i: number) => number) = 1000): OHLCVData[] {
    return closes.map((close, i) => {
        const open = i === 0 ? close - 0.5 : closes[i - 1];
        const vol = typeof volume === "function" ? volume(i) : volume;
        return bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, vol);
    });
}

// Bars oscillating between `lowClose`/`highClose` with a fixed range, giving a
// stable robust center and uniform ranges (quiet-stretch / flush tests).
function altBars(count: number, lowClose: number, highClose: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = i % 2 === 0 ? lowClose : highClose;
        const open = i % 2 === 0 ? highClose : lowClose;
        bars.push(bar(i, open, highClose + 0.5, lowClose - 0.5, close));
    }
    return bars;
}

const NEW_REGIME_CONDITIONAL_KEYS = [
    "quiet_stretch_median_reversion",
    "efficiency_regime_adaptive_router",
    "wick_absorption_placement_fade",
    "volatility_pulse_directional_continuation",
    "acceptance_flip_expansion_reversal",
    "trend_freshness_momentum",
    "volume_confirmed_breakout",
    "efficiency_gated_pullback_recovery",
    "atr_scaled_decisive_breakout",
    "flush_recovery_reversal",
];

describe("regime conditional strategy candidates", () => {
    it("registers all new regime-conditional strategies in the built-in manifest", () => {
        for (const key of NEW_REGIME_CONDITIONAL_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(quiet_stretch_median_reversion.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(quiet_stretch_median_reversion.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(efficiency_regime_adaptive_router.normalizeParams?.({ lookback: 2.6 })).to.deep.equal({ lookback: 3 });
        expect(efficiency_regime_adaptive_router.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(wick_absorption_placement_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(wick_absorption_placement_fade.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(volatility_pulse_directional_continuation.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(volatility_pulse_directional_continuation.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(acceptance_flip_expansion_reversal.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(acceptance_flip_expansion_reversal.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(trend_freshness_momentum.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(trend_freshness_momentum.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(volume_confirmed_breakout.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(volume_confirmed_breakout.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(efficiency_gated_pullback_recovery.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(efficiency_gated_pullback_recovery.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(atr_scaled_decisive_breakout.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(atr_scaled_decisive_breakout.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(flush_recovery_reversal.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(flush_recovery_reversal.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
    });

    it("quiet_stretch_median_reversion buys only quiet, stretched closes", () => {
        const data = altBars(30, 98, 102);
        data[20] = bar(20, 91, 91.5, 89.5, 90);
        const signals = quiet_stretch_median_reversion.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 20 },
        ]);
    });

    it("efficiency_regime_adaptive_router buys median-cross momentum in efficient trends", () => {
        const closes: number[] = [];
        for (let i = 0; i < 21; i++) {
            closes.push(100 + i * 2);
        }
        closes.push(134); // pullback below the rolling median
        closes.push(141); // recovery back above the rolling median
        const signals = efficiency_regime_adaptive_router.execute(barsFromCloses(closes), { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 22 },
        ]);
    });

    it("wick_absorption_placement_fade fades absorbed placements on extreme same-side wicks", () => {
        const sellData: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            sellData.push(bar(i, 99, 100.25, 98, 100));
        }
        sellData.push(bar(14, 98, 103, 97.5, 102));
        const sellSignals = wick_absorption_placement_fade.execute(sellData, { lookback: 8 });
        expect(sellSignals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "sell", barIndex: 14 },
        ]);

        const buyData: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            buyData.push(bar(i, 100, 100.5, 98.75, 99));
        }
        buyData.push(bar(14, 101, 101.5, 95, 96));
        const buySignals = wick_absorption_placement_fade.execute(buyData, { lookback: 8 });
        expect(buySignals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("volatility_pulse_directional_continuation buys the expansion out of a contraction", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 100, 101.5, 98.5, 100));
        }
        data.push(bar(13, 100, 100.4, 99.6, 100)); // contracted
        data.push(bar(14, 100, 106.5, 99, 106)); // pulse up
        for (let i = 15; i < 22; i++) {
            data.push(bar(i, 100, 101.5, 98.5, 100));
        }
        const signals = volatility_pulse_directional_continuation.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("acceptance_flip_expansion_reversal buys a bearish-to-bullish flip on an expanding bar", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 13; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(13, 100, 100.2, 96.8, 97)); // strong bearish acceptance
        data.push(bar(14, 97, 103.5, 96.8, 103)); // strong bullish acceptance, expanding
        const signals = acceptance_flip_expansion_reversal.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("trend_freshness_momentum buys fresh highs and sells fresh lows", () => {
        const upCloses: number[] = [];
        const downCloses: number[] = [];
        for (let i = 0; i < 30; i++) {
            upCloses.push(100 + i * 1.5);
            downCloses.push(200 - i * 1.5);
        }
        const upSignals = trend_freshness_momentum.execute(barsFromCloses(upCloses), { lookback: 8 });
        expect(upSignals.length).to.be.greaterThan(0);
        expect(upSignals[0].barIndex).to.equal(9);
        for (const signal of upSignals) {
            expect(signal.type).to.equal("buy");
        }
        const downSignals = trend_freshness_momentum.execute(barsFromCloses(downCloses), { lookback: 8 });
        expect(downSignals.length).to.be.greaterThan(0);
        expect(downSignals[0].barIndex).to.equal(9);
        for (const signal of downSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("volume_confirmed_breakout follows volume-confirmed boundary breaks only", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100, 1000));
        }
        data.push(bar(14, 100, 103, 99.5, 102.5, 5000));
        for (let i = 15; i < 30; i++) {
            data.push(bar(i, 100, 101, 99, 100, 1000));
        }
        const signals = volume_confirmed_breakout.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("efficiency_gated_pullback_recovery buys the recovery out of an efficient pullback", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 21; i++) {
            const close = 100 + i * 2;
            data.push(bar(i, i === 0 ? close - 0.5 : data[i - 1].close, close + 1, close - 3, close));
        }
        // Pullback bar: low close location, below the rolling median.
        data.push(bar(21, 138, 138.5, 133.5, 134));
        // Recovery bar: close back above the rolling median.
        data.push(bar(22, 134, 142, 133, 141));
        const signals = efficiency_gated_pullback_recovery.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 22 },
        ]);
    });

    it("atr_scaled_decisive_breakout requires an ATR-scaled clearance of the boundary", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 100, 103, 99.5, 102.3));
        const signals = atr_scaled_decisive_breakout.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
        ]);
    });

    it("flush_recovery_reversal buys the flush bar's immediate recovery through its midpoint", () => {
        const data = altBars(30, 98, 102);
        data[20] = bar(20, 91, 91.5, 89.5, 90); // flush bar
        data[21] = bar(21, 90.5, 92, 90, 91.5); // recovery above the flush midpoint
        const signals = flush_recovery_reversal.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 21 },
        ]);
    });
});
