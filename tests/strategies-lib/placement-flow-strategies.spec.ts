import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { placement_band_breakout } from "../../lib/strategies/lib/placement_band_breakout";
import { gap_autocorrelation_persistence } from "../../lib/strategies/lib/gap_autocorrelation_persistence";
import { volatility_cascade_streak } from "../../lib/strategies/lib/volatility_cascade_streak";
import { robust_placement_extreme_continuation } from "../../lib/strategies/lib/robust_placement_extreme_continuation";
import { cmf_flow_flip_confirmation } from "../../lib/strategies/lib/cmf_flow_flip_confirmation";
import { positional_streak_persistence } from "../../lib/strategies/lib/positional_streak_persistence";
import { body_size_acceleration } from "../../lib/strategies/lib/body_size_acceleration";
import { open_close_sweep_momentum } from "../../lib/strategies/lib/open_close_sweep_momentum";
import { initiative_pressure_flip_continuation } from "../../lib/strategies/lib/initiative_pressure_flip_continuation";
import { decayed_body_direction_balance } from "../../lib/strategies/lib/decayed_body_direction_balance";

const NEW_KEYS = [
    "placement_band_breakout",
    "gap_autocorrelation_persistence",
    "volatility_cascade_streak",
    "robust_placement_extreme_continuation",
    "cmf_flow_flip_confirmation",
    "positional_streak_persistence",
    "body_size_acceleration",
    "open_close_sweep_momentum",
    "initiative_pressure_flip_continuation",
    "decayed_body_direction_balance",
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

describe("placement and flow strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(placement_band_breakout.normalizeParams?.({ lookback: 0 })).to.deep.equal({ lookback: 1 });
        expect(gap_autocorrelation_persistence.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(volatility_cascade_streak.normalizeParams?.({ lookback: 0 })).to.deep.equal({ lookback: 1 });
        expect(robust_placement_extreme_continuation.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
        expect(cmf_flow_flip_confirmation.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
        expect(decayed_body_direction_balance.normalizeParams?.({ decay: 0.0001 })).to.deep.equal({ decay: 0.01 });
        expect(decayed_body_direction_balance.normalizeParams?.({ decay: 1 })).to.deep.equal({ decay: 0.999 });
    });

    it("placement_band_breakout buys acceptance printing beyond its prior-only band", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            data.push(bar(i, 100, 101, 99, 100)); // doji -> acceptance 0
        }
        data.push(bar(40, 100.5, 102.5, 99.5, 102)); // strong earned up bar -> acceptance ~0.58
        const signals = placement_band_breakout.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("gap_autocorrelation_persistence follows persistent gap directions", () => {
        const data: OHLCVData[] = [];
        let open = 100;
        for (let i = 0; i < 50; i++) {
            if (i > 0) {
                const block = Math.floor((i - 1) / 4);
                const sign = block % 2 === 0 ? 1 : -1;
                open = open * (1 + sign * 0.01);
            }
            data.push(bar(i, open, open + 0.5, open - 0.5, open));
        }
        const signals = gap_autocorrelation_persistence.execute(data, { lookback: 30 });
        expect(signals.some((s) => s.type === "buy")).to.equal(true);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
        for (const signal of signals) {
            const b = data[signal.barIndex!];
            if (signal.type === "buy") {
                expect(b.open, "gap-persistence buy needs an up gap").to.be.greaterThan(data[signal.barIndex! - 1].close);
                expect(b.close, "gap-persistence buy needs close at/above open").to.be.greaterThanOrEqual(b.open);
            } else {
                expect(b.open, "gap-persistence sell needs a down gap").to.be.lessThan(data[signal.barIndex! - 1].close);
                expect(b.close, "gap-persistence sell needs close at/below open").to.be.lessThanOrEqual(b.open);
            }
        }
    });

    it("volatility_cascade_streak buys expanding-range cascades resolving up", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            data.push(bar(i, 100, 100.1, 99.9, 100));
        }
        let prevClose = 100;
        const widths = [0.4, 0.65, 0.9, 1.15, 1.4, 1.65];
        for (let i = 0; i < widths.length; i++) {
            const open = prevClose;
            const close = open + 0.3;
            data.push(bar(30 + i, open, close + widths[i], open - widths[i], close));
            prevClose = close;
        }
        const signals = volatility_cascade_streak.execute(data, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("robust_placement_extreme_continuation buys robustly extreme high placement with an up bar", () => {
        const data: OHLCVData[] = [];
        const locations = [0.45, 0.5, 0.55];
        for (let i = 0; i < 25; i++) {
            const loc = locations[i % 3];
            data.push(bar(i, 100, 101, 99, 99 + 2 * loc));
        }
        let prevClose = data[24].close;
        for (let i = 25; i < 31; i++) {
            const open = prevClose;
            const close = open + 1;
            data.push(bar(i, open, close, open - 0.1, close));
            prevClose = close;
        }
        const signals = robust_placement_extreme_continuation.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("cmf_flow_flip_confirmation buys a flip into accumulation and sells a flip into distribution", () => {
        const distributionThenAccumulation: OHLCVData[] = [];
        const accumulationThenDistribution: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            distributionThenAccumulation.push(bar(i, 100, 100.5, 98.5, 99)); // multiplier -0.5
            accumulationThenDistribution.push(bar(i, 100, 101.5, 99.5, 101)); // multiplier +0.5
        }
        for (let i = 20; i < 32; i++) {
            distributionThenAccumulation.push(bar(i, 100, 101.5, 99.5, 101));
            accumulationThenDistribution.push(bar(i, 100, 100.5, 98.5, 99));
        }
        const buySignals = cmf_flow_flip_confirmation.execute(distributionThenAccumulation, { lookback: 20 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(30);
        const sellSignals = cmf_flow_flip_confirmation.execute(accumulationThenDistribution, { lookback: 20 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(30);
    });

    it("positional_streak_persistence buys a positional streak above the median", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            data.push(bar(i, 100, 100, 100, 100));
        }
        for (let i = 30; i < 38; i++) {
            data.push(bar(i, 101.5, 102.1, 101.4, 102));
        }
        const signals = positional_streak_persistence.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
        expect(signals[0].barIndex).to.equal(32);
    });

    it("body_size_acceleration buys when body conviction grows sharply and the current body is large", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 25; i++) {
            const target = Math.min(0.8, 0.05 + 0.05 * i);
            const body = target / (1 - target);
            const open = prevClose;
            const close = open + body;
            data.push(bar(i, open, close + 0.5, open - 0.5, close));
            prevClose = close;
        }
        const signals = body_size_acceleration.execute(data, { lookback: 12 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("open_close_sweep_momentum buys a rare full-range upward sweep", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(40, 99.1, 101, 99, 100.9));
        const signals = open_close_sweep_momentum.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("initiative_pressure_flip_continuation trades the pressure zero-crossing with bar confirmation", () => {
        const negativeThenPositive: OHLCVData[] = [];
        const positiveThenNegative: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            negativeThenPositive.push(bar(i, 100, 101, 99, 99.2)); // acceptance -0.6
            positiveThenNegative.push(bar(i, 100, 101, 99, 100.8)); // acceptance +0.6
        }
        negativeThenPositive.push(bar(30, 100, 101, 99, 100.8));
        positiveThenNegative.push(bar(30, 100, 101, 99, 99.2));
        const buySignals = initiative_pressure_flip_continuation.execute(negativeThenPositive, { lookback: 24 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(30);
        const sellSignals = initiative_pressure_flip_continuation.execute(positiveThenNegative, { lookback: 24 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(30);
    });

    it("decayed_body_direction_balance follows the recent directional vote", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 15; i++) {
            const open = prevClose;
            const close = open + 0.5;
            data.push(bar(i, open, close + 0.2, open - 0.2, close));
            prevClose = close;
        }
        for (let i = 15; i < 30; i++) {
            const open = prevClose;
            const close = open - 0.5;
            data.push(bar(i, open, open + 0.2, close - 0.2, close));
            prevClose = close;
        }
        const signals = decayed_body_direction_balance.execute(data, { decay: 0.9 });
        expect(signals.some((s) => s.type === "buy")).to.equal(true);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
    });
});
