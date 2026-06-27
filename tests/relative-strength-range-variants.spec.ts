import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, Time } from "../lib/types/strategies";
import { atr_regime_shift_confirmation } from "../lib/strategies/lib/atr_regime_shift_confirmation";
import { base_quote_momentum_divergence } from "../lib/strategies/lib/base_quote_momentum_divergence";
import { directional_body_acceptance } from "../lib/strategies/lib/directional_body_acceptance";
import { pullback_after_relative_expansion } from "../lib/strategies/lib/pullback_after_relative_expansion";
import { range_expansion_follow_through } from "../lib/strategies/lib/range_expansion_follow_through";
import { relative_acceptance_breakout } from "../lib/strategies/lib/relative_acceptance_breakout";

const variants: Array<{ key: string; strategy: Strategy }> = [
    { key: "range_expansion_follow_through", strategy: range_expansion_follow_through },
    { key: "directional_body_acceptance", strategy: directional_body_acceptance },
    { key: "atr_regime_shift_confirmation", strategy: atr_regime_shift_confirmation },
    { key: "base_quote_momentum_divergence", strategy: base_quote_momentum_divergence },
    { key: "pullback_after_relative_expansion", strategy: pullback_after_relative_expansion },
    { key: "relative_acceptance_breakout", strategy: relative_acceptance_breakout },
];

function buildSyntheticRatioBars(length: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;

    for (let i = 0; i < length; i++) {
        const previousClose = close;
        let move = Math.sin(i / 5) * 0.08;
        if (i > 40 && i < 75) move += 0.35;
        if (i >= 75 && i < 88) move -= 0.12;
        if (i >= 88 && i < 120) move += 0.22;
        if (i >= 120 && i < 145) move -= 0.32;
        if (i === 55) move += 1.8;
        if (i === 104) move += 1.2;
        if (i === 132) move -= 1.6;

        close = Math.max(20, close + move);
        const open = previousClose;
        let high = Math.max(open, close) + 0.35 + (i % 7) * 0.03;
        let low = Math.min(open, close) - 0.35 - (i % 5) * 0.03;

        if (i === 130) {
            low -= 2.1;
            close = open + 0.35;
            high = Math.max(high, close + 0.2);
        }
        if (i === 150) {
            high += 2.1;
            close = open - 0.35;
            low = Math.min(low, close - 0.2);
        }

        data.push({
            time: i as Time,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 13) * 25,
        });
    }

    return data;
}

describe("relative strength range variants", () => {
    it("keeps each variant's default parameter contract optimizer-safe", () => {
        for (const { key, strategy } of variants) {
            expect(strategy.normalizeParams?.(strategy.defaultParams) ?? strategy.defaultParams, `${key} normalized defaults`)
                .to.deep.equal(strategy.defaultParams);
            expect(Object.keys(strategy.paramLabels), `${key} param labels`).to.deep.equal(Object.keys(strategy.defaultParams));
            for (const param of strategy.metadata?.walkForwardParams ?? []) {
                expect(Object.keys(strategy.defaultParams), `${key} walk-forward param ${param}`).to.include(param);
            }
        }
    });

    it("emits only closed-bar signals inside the supplied synthetic-ratio data", () => {
        const data = buildSyntheticRatioBars(180);

        for (const { key, strategy } of variants) {
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals, `${key} signals`).to.be.an("array");
            for (const signal of signals) {
                expect(signal.barIndex, `${key} barIndex`).to.be.at.least(1);
                expect(signal.barIndex, `${key} barIndex`).to.be.lessThan(data.length);
                expect(signal.time, `${key} signal time`).to.equal(data[signal.barIndex!].time);
                expect(signal.type === "buy" || signal.type === "sell", `${key} type`).to.equal(true);
            }
        }
    });

    it("does not trade when the minimum bar history is unavailable", () => {
        const shortData = buildSyntheticRatioBars(5);

        for (const { key, strategy } of variants) {
            expect(strategy.execute(shortData, strategy.defaultParams), `${key} short history`).to.deep.equal([]);
        }
    });
});
