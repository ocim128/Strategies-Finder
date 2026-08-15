import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_decay_momentum_continuation } from "../../lib/strategies/lib/acceptance_decay_momentum_continuation";
import { autocorrelation_regime_trend_switch } from "../../lib/strategies/lib/autocorrelation_regime_trend_switch";
import { body_direction_streak_continuation } from "../../lib/strategies/lib/body_direction_streak_continuation";
import { efficiency_failed_expansion_fade } from "../../lib/strategies/lib/efficiency_failed_expansion_fade";
import { initiative_pressure_thrust_continuation } from "../../lib/strategies/lib/initiative_pressure_thrust_continuation";
import { open_gap_percentile_fade } from "../../lib/strategies/lib/open_gap_percentile_fade";
import { range_compression_breakout } from "../../lib/strategies/lib/range_compression_breakout";
import { return_crossing_persistence_continuation } from "../../lib/strategies/lib/return_crossing_persistence_continuation";
import { trailing_boundary_probe_rejection } from "../../lib/strategies/lib/trailing_boundary_probe_rejection";
import { volume_return_correlation_regime } from "../../lib/strategies/lib/volume_return_correlation_regime";

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

const NEW_STRUCTURAL_KEYS = [
    "autocorrelation_regime_trend_switch",
    "open_gap_percentile_fade",
    "return_crossing_persistence_continuation",
    "initiative_pressure_thrust_continuation",
    "body_direction_streak_continuation",
    "range_compression_breakout",
    "acceptance_decay_momentum_continuation",
    "volume_return_correlation_regime",
    "efficiency_failed_expansion_fade",
    "trailing_boundary_probe_rejection",
];

describe("structural regime strategy candidates", () => {
    it("registers all new structural strategies in the built-in manifest", () => {
        for (const key of NEW_STRUCTURAL_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(autocorrelation_regime_trend_switch.normalizeParams?.({ lookback: 2.6 })).to.deep.equal({ lookback: 3 });
        expect(autocorrelation_regime_trend_switch.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });
        expect(open_gap_percentile_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(open_gap_percentile_fade.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(return_crossing_persistence_continuation.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(return_crossing_persistence_continuation.normalizeParams?.({ lookback: 25 })).to.deep.equal({ lookback: 25 });
        expect(initiative_pressure_thrust_continuation.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(initiative_pressure_thrust_continuation.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(body_direction_streak_continuation.normalizeParams?.({ streakMin: 1.6 })).to.deep.equal({ streakMin: 2 });
        expect(body_direction_streak_continuation.normalizeParams?.({ streakMin: 4 })).to.deep.equal({ streakMin: 4 });
        expect(range_compression_breakout.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(range_compression_breakout.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(acceptance_decay_momentum_continuation.normalizeParams?.({ decay: -0.5 })).to.deep.equal({ decay: 0.01 });
        expect(acceptance_decay_momentum_continuation.normalizeParams?.({ decay: 1.5 })).to.deep.equal({ decay: 1 });
        expect(acceptance_decay_momentum_continuation.normalizeParams?.({ decay: 0.95 })).to.deep.equal({ decay: 0.95 });
        expect(volume_return_correlation_regime.normalizeParams?.({ lookback: 2.6 })).to.deep.equal({ lookback: 3 });
        expect(volume_return_correlation_regime.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(efficiency_failed_expansion_fade.normalizeParams?.({ lookback: 1.4 })).to.deep.equal({ lookback: 2 });
        expect(efficiency_failed_expansion_fade.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
        expect(trailing_boundary_probe_rejection.normalizeParams?.({ lookback: 0.6 })).to.deep.equal({ lookback: 1 });
        expect(trailing_boundary_probe_rejection.normalizeParams?.({ lookback: 30 })).to.deep.equal({ lookback: 30 });
    });

    it("autocorrelation_regime_trend_switch buys when lag-1 autocorrelation flips up with a positive net move", () => {
        const closes: number[] = [100];
        for (let i = 0; i < 20; i++) {
            closes.push(closes[i] * (i % 2 === 0 ? 1.01 : 0.995));
        }
        for (let i = 0; i < 30; i++) {
            closes.push(closes[closes.length - 1] * (1 + 0.008 + (i % 3) * 0.004));
        }
        const signals = autocorrelation_regime_trend_switch.execute(barsFromCloses(closes), { lookback: 8 });
        expect(signals.length, "expected at least one regime-flip entry").to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
            expect(signal.barIndex).to.be.greaterThanOrEqual(8);
        }
    });

    it("open_gap_percentile_fade buys extreme gap-downs and sells extreme gap-ups", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 14; i++) {
            const gap = i % 2 === 0 ? 0.002 : -0.0015;
            const open = prevClose * (1 + gap);
            data.push(bar(i, open, open + 0.5, open - 0.5, open));
            prevClose = open;
        }
        data.push(bar(14, prevClose * 0.96, prevClose * 0.965, prevClose * 0.955, prevClose * 0.96));
        prevClose = data[14].close;
        for (let i = 15; i < 29; i++) {
            const gap = i % 2 === 0 ? 0.002 : -0.0015;
            const open = prevClose * (1 + gap);
            data.push(bar(i, open, open + 0.5, open - 0.5, open));
            prevClose = open;
        }
        data.push(bar(29, prevClose * 1.05, prevClose * 1.055, prevClose * 1.045, prevClose * 1.05));

        const signals = open_gap_percentile_fade.execute(data, { lookback: 8 });
        expect(signals.some((s) => s.barIndex === 14 && s.type === "buy"), "extreme gap down should fade long").to.equal(true);
        expect(signals.some((s) => s.barIndex === 29 && s.type === "sell"), "extreme gap up should fade short").to.equal(true);
    });

    it("return_crossing_persistence_continuation buys persistent one-sided drift", () => {
        const closes: number[] = [];
        for (let i = 0; i < 30; i++) {
            closes.push(100 + i * 1.5 + (i % 3) * 0.3);
        }
        const signals = return_crossing_persistence_continuation.execute(barsFromCloses(closes), { lookback: 8 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(8);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("initiative_pressure_thrust_continuation buys a volume-relative bullish thrust bar", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 20; i++) {
            const c = i % 2 === 0 ? close : close + 0.4;
            data.push(bar(i, c - 0.2, c + 1, c - 1, c, 1000));
            close = c;
        }
        data.push(bar(20, 100.8, 108, 99.8, 106.5, 20000));
        for (let i = 21; i < 30; i++) {
            data.push(bar(i, 106.5 - 0.2, 107.5, 105.5, 106.5, 20000));
        }
        const signals = initiative_pressure_thrust_continuation.execute(data, { lookback: 8 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });

    it("body_direction_streak_continuation extends streaks of same-direction bodies", () => {
        const data = [
            bar(0, 100, 102, 99, 101),
            bar(1, 101, 103, 100, 102.5),
            bar(2, 102.5, 104, 101, 103.5),
            bar(3, 103.5, 105, 102, 104.5),
            bar(4, 104.5, 106, 103, 104),
            bar(5, 104, 104.5, 101, 101.5),
            bar(6, 101.5, 102, 99, 99.5),
            bar(7, 99.5, 100, 97, 97.5),
        ];
        const signals = body_direction_streak_continuation.execute(data, { streakMin: 4 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 3 },
            { type: "sell", barIndex: 7 },
        ]);
    });

    it("range_compression_breakout buys a close above the trailing high after compression", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 100.2, 99.8, 100));
        }
        data.push(bar(14, 100, 103.5, 99.8, 103));
        for (let i = 15; i < 29; i++) {
            data.push(bar(i, 103, 103.2, 102.8, 103));
        }
        data.push(bar(29, 103, 103.2, 100, 100.4));
        const signals = range_compression_breakout.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
            { type: "sell", barIndex: 29 },
        ]);
    });

    it("acceptance_decay_momentum_continuation buys once memory-weighted acceptance crosses the fixed threshold", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 15; i++) {
            data.push(bar(i, 100 + i * 3, 104 + i * 3, 99 + i * 3, 103 + i * 3));
        }
        const signals = acceptance_decay_momentum_continuation.execute(data, { decay: 0.95 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(1);
    });

    it("volume_return_correlation_regime buys when return-volume correlation is strongly positive on up bars", () => {
        const closes: number[] = [100];
        const volumes: number[] = [1000];
        for (let i = 0; i < 39; i++) {
            closes.push(closes[i] * (1 + 0.01 + (i % 3) * 0.005));
            volumes.push(1000 + (i % 3) * 500);
        }
        const data = barsFromCloses(closes, (i) => volumes[i]);
        const signals = volume_return_correlation_regime.execute(data, { lookback: 8 });
        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0].barIndex).to.equal(8);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("efficiency_failed_expansion_fade buys a high-efficiency down attempt that closes upper-half", () => {
        // Choppy section with irregular step sizes (varied, non-zero efficiency)
        // followed by a steady decline whose efficiency is the window max.
        const closes: number[] = [100];
        const chopSteps = [1.2, -0.8, 1.5, -0.6, 0.9, -1.1, 1.3, -0.7, 1.1, -0.9, 1.4, -0.8, 1.0];
        for (const step of chopSteps) {
            closes.push(closes[closes.length - 1] + step);
        }
        for (let i = 14; i < 21; i++) {
            closes.push(closes[closes.length - 1] - 0.5);
        }
        const data = barsFromCloses(closes);
        // Override bar 21: closes slightly up (97.7) but lands in the upper half of its range.
        data.push(bar(21, 97.4, 98, 96.8, 97.7));
        const signals = efficiency_failed_expansion_fade.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 21 },
        ]);
    });

    it("trailing_boundary_probe_rejection fades rejected probes through the trailing high/low", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(14, 100, 101, 98.5, 99.5));
        for (let i = 15; i < 21; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(21, 100, 101.5, 99, 100.4));
        const signals = trailing_boundary_probe_rejection.execute(data, { lookback: 8 });
        expect(signals.map((s) => ({ type: s.type, barIndex: s.barIndex }))).to.deep.equal([
            { type: "buy", barIndex: 14 },
            { type: "sell", barIndex: 21 },
        ]);
    });
});
