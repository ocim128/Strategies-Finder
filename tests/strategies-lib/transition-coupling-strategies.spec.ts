import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { efficiency_transition_momentum } from "../../lib/strategies/lib/efficiency_transition_momentum";
import { median_velocity_pullback } from "../../lib/strategies/lib/median_velocity_pullback";
import { body_mid_drift_continuation } from "../../lib/strategies/lib/body_mid_drift_continuation";
import { wick_imbalance_persistence_continuation } from "../../lib/strategies/lib/wick_imbalance_persistence_continuation";
import { gap_fill_intrabar_fade } from "../../lib/strategies/lib/gap_fill_intrabar_fade";
import { price_flow_divergence_fade } from "../../lib/strategies/lib/price_flow_divergence_fade";
import { placement_regime_flip } from "../../lib/strategies/lib/placement_regime_flip";
import { placement_skewness_anchor } from "../../lib/strategies/lib/placement_skewness_anchor";
import { acceptance_entropy_consistency } from "../../lib/strategies/lib/acceptance_entropy_consistency";
import { range_volume_coupling_fade } from "../../lib/strategies/lib/range_volume_coupling_fade";

const NEW_KEYS = [
    "efficiency_transition_momentum",
    "median_velocity_pullback",
    "body_mid_drift_continuation",
    "wick_imbalance_persistence_continuation",
    "gap_fill_intrabar_fade",
    "price_flow_divergence_fade",
    "placement_regime_flip",
    "placement_skewness_anchor",
    "acceptance_entropy_consistency",
    "range_volume_coupling_fade",
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

describe("transition and coupling strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(efficiency_transition_momentum.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
        expect(median_velocity_pullback.normalizeParams?.({ lookback: 0 })).to.deep.equal({ lookback: 1 });
        expect(body_mid_drift_continuation.normalizeParams?.({ lookback: 0 })).to.deep.equal({ lookback: 1 });
        expect(gap_fill_intrabar_fade.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
        expect(placement_skewness_anchor.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(acceptance_entropy_consistency.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
        expect(range_volume_coupling_fade.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
    });

    it("efficiency_transition_momentum buys the bar where the efficiency ratio jumps from chop to trend", () => {
        const data: OHLCVData[] = [];
        data.push(bar(0, 100, 100.5, 98, 98.5));
        data.push(bar(1, 98.5, 98.5, 71, 71)); // one huge drop, then a clean straight climb
        let prevClose = 71;
        for (let i = 2; i < 32; i++) {
            const open = prevClose;
            const close = open + 1;
            data.push(bar(i, open, close + 0.2, open - 0.2, close));
            prevClose = close;
        }
        const signals = efficiency_transition_momentum.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(31);
    });

    it("median_velocity_pullback buys a dip that crosses a rising median", () => {
        const data: OHLCVData[] = [];
        // A strongly convex close series makes the rolling median itself drift up; the
        // dip lands mid-window (position 14) so it moves the median while still
        // crossing below it.
        for (let j = 0; j < 30; j++) {
            const close = 100 + 0.1 * j + 0.05 * j * j;
            const open = j === 0 ? 100 : 100 + 0.1 * (j - 1) + 0.05 * (j - 1) * (j - 1);
            data.push(bar(j, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
        }
        data.push(bar(30, data[29].close, data[29].close + 0.2, 112.3, 112.5));
        const signals = median_velocity_pullback.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("body_mid_drift_continuation follows persistent upward body-mid drift", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 25; i++) {
            const open = prevClose;
            const close = open + 0.5;
            data.push(bar(i, open, close + 0.3, open - 0.3, close));
            prevClose = close;
        }
        const signals = body_mid_drift_continuation.execute(data, { lookback: 20 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("wick_imbalance_persistence_continuation continues the persistently defended side", () => {
        const lowerWick: OHLCVData[] = [];
        const upperWick: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) {
            lowerWick.push(bar(i, 100, 100.6, 98, 100.5)); // lower-wick dominant
            upperWick.push(bar(i, 100, 102, 99.4, 99.5)); // upper-wick dominant
        }
        const buySignals = wick_imbalance_persistence_continuation.execute(lowerWick, { lookback: 20 });
        expect(buySignals.length).to.be.greaterThan(0);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
        const sellSignals = wick_imbalance_persistence_continuation.execute(upperWick, { lookback: 20 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("gap_fill_intrabar_fade fades extreme gaps recovered intrabar", () => {
        const base: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            base.push(bar(i, 100, 100.5, 99.5, 100));
        }
        const downGap = [...base, bar(40, 98, 99.5, 97.8, 99)];
        const buySignals = gap_fill_intrabar_fade.execute(downGap, { lookback: 24 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(40);
        const upGap = [...base, bar(40, 102, 102.5, 100.5, 101)];
        const sellSignals = gap_fill_intrabar_fade.execute(upGap, { lookback: 24 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(40);
    });

    it("price_flow_divergence_fade fades range extremes printed without supporting flow", () => {
        const distributionThenAccumulation: OHLCVData[] = [];
        const accumulationThenDistribution: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            distributionThenAccumulation.push(bar(i, 100, 100.9, 99, 99.1)); // multiplier -0.895
            accumulationThenDistribution.push(bar(i, 100, 101, 99.1, 100.9)); // multiplier +0.895
        }
        for (let i = 20; i < 31; i++) {
            distributionThenAccumulation.push(bar(i, 100, 101, 99.1, 100.9));
            accumulationThenDistribution.push(bar(i, 100, 100.9, 99, 99.1));
        }
        // Range low printed while flow is still high-percentile, on negligible volume.
        distributionThenAccumulation.push(bar(31, 100, 100, 98.5, 98.6, 1));
        accumulationThenDistribution.push(bar(31, 100, 101.5, 100, 101.4, 1));
        const buySignals = price_flow_divergence_fade.execute(distributionThenAccumulation, { lookback: 30 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(31);
        const sellSignals = price_flow_divergence_fade.execute(accumulationThenDistribution, { lookback: 30 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(31);
    });

    it("placement_regime_flip trades the zero-cross of smoothed close acceptance", () => {
        const negativeThenPositive: OHLCVData[] = [];
        const positiveThenNegative: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            negativeThenPositive.push(bar(i, 100, 101, 99, 99.2)); // acceptance -0.6
            positiveThenNegative.push(bar(i, 100, 101, 99, 100.8)); // acceptance +0.6
        }
        for (let i = 20; i < 33; i++) {
            negativeThenPositive.push(bar(i, 100, 101, 99, 100.8));
            positiveThenNegative.push(bar(i, 100, 101, 99, 99.2));
        }
        const buySignals = placement_regime_flip.execute(negativeThenPositive, { lookback: 24 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(32);
        const sellSignals = placement_regime_flip.execute(positiveThenNegative, { lookback: 24 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(32);
    });

    it("placement_skewness_anchor trades with the tail of the close-location distribution", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            data.push(bar(i, 100, 101, 99, 100)); // location 0.5
        }
        let prevClose = 100;
        for (let i = 20; i < 32; i++) {
            const open = prevClose;
            const close = open + 0.9;
            data.push(bar(i, open, close, open - 0.9, close)); // location 1.0
            prevClose = close;
        }
        const signals = placement_skewness_anchor.execute(data, { lookback: 30 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("acceptance_entropy_consistency fires only when placement is consistent", () => {
        const consistent: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) {
            consistent.push(bar(i, 100, 101, 99, 100.8)); // acceptance +0.6 every bar
        }
        const consistentSignals = acceptance_entropy_consistency.execute(consistent, { lookback: 24 });
        expect(consistentSignals.length).to.be.greaterThan(0);
        for (const signal of consistentSignals) {
            expect(signal.type).to.equal("buy");
        }

        // Uniform 5-bin acceptance spread: entropy near log2(5) > 1.0, so no signal.
        const erratic: OHLCVData[] = [];
        const locations = [0.2, 0.35, 0.5, 0.65, 0.8];
        for (let i = 0; i < 40; i++) {
            const loc = locations[i % 5];
            erratic.push(bar(i, 100, 100 + (1 - loc), 100 - loc, 100));
        }
        const erraticSignals = acceptance_entropy_consistency.execute(erratic, { lookback: 24 });
        expect(erraticSignals).to.have.length(0);
    });

    it("range_volume_coupling_fade routes by the range-volume correlation", () => {
        const coupled: OHLCVData[] = [];
        const decoupled: OHLCVData[] = [];
        let upClose = 100;
        let downClose = 100;
        for (let i = 0; i < 75; i++) {
            // Sawtooth with period 8: range and volume follow the same phase (coupled)
            // or opposite phases (decoupled), keeping the volume percentile non-constant.
            const phase = (i % 8) / 7;
            const r = 0.2 + 0.3 * phase;
            const volume = 100 + 400 * phase;
            const upOpen = upClose;
            const upHigh = upOpen + 0.5 + r;
            const upLow = upOpen - r;
            upClose = upOpen + 0.5;
            coupled.push(bar(i, upOpen, upHigh, upLow, upClose, volume));
            const downOpen = downClose;
            const downHigh = downOpen + r;
            const downLow = downOpen - 0.5 - r;
            downClose = downOpen - 0.5;
            decoupled.push(bar(i, downOpen, downHigh, downLow, downClose, 500 - 400 * phase));
        }
        const sellSignals = range_volume_coupling_fade.execute(coupled, { lookback: 30 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
        const buySignals = range_volume_coupling_fade.execute(decoupled, { lookback: 30 });
        expect(buySignals.length).to.be.greaterThan(0);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
    });
});
