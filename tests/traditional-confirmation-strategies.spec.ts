import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest-eager";
import { mergeExitStrategySignals } from "../lib/exit-strategy-merge";

const keys = [
    "rsi_midline_confirmation",
    "cci_zero_line_confirmation",
    "williams_r_midline_confirmation",
    "stochastic_midline_confirmation",
    "bollinger_reentry",
    "parabolic_sar_confirmation",
    "supertrend_confirmation",
    "aroon_direction_confirmation",
    "dmi_direction_confirmation",
    "mfi_midline_confirmation",
    "obv_signal_line_confirmation",
    "trix_zero_line_confirmation",
] as const;

function buildData(length: number, direction: 1 | -1 = 1): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < length; i++) {
        const previousClose = close;
        close += direction * (0.15 + (i % 7) * 0.03) + Math.sin(i / 4) * 0.12;
        const open = previousClose + Math.sin(i / 3) * 0.08;
        data.push({
            time: `2024-01-${String((i % 28) + 1).padStart(2, "0")}` as Time,
            open,
            high: Math.max(open, close) + 0.8,
            low: Math.min(open, close) - 0.8,
            close,
            volume: 1000 + (i % 9) * 100,
        });
    }
    return data;
}

function getStrategy(key: string) {
    const found = strategyManifest.find((entry) => entry.key === key);
    expect(found, `${key} is in the generated manifest`).to.exist;
    return found!.strategy;
}

describe("traditional confirmation strategies", () => {
    it("exposes exactly one optimizable parameter and remains entry-capable", () => {
        for (const key of keys) {
            const strategy = getStrategy(key);
            expect(Object.keys(strategy.defaultParams), `${key} default params`).to.have.length(1);
            expect(Object.keys(strategy.paramLabels), `${key} labels`).to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.metadata?.role, `${key} role`).to.equal("entry");
            expect(strategy.metadata?.direction, `${key} direction`).to.equal("both");
            expect(strategy.metadata?.walkForwardParams, `${key} walk-forward params`)
                .to.deep.equal(Object.keys(strategy.defaultParams));
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${key} normalized defaults`)
                .to.deep.equal(strategy.defaultParams);
        }
    });

    it("executes all twelve strategies on a sufficiently long dataset", () => {
        const data = buildData(320);
        for (const key of keys) {
            const strategy = getStrategy(key);
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals, `${key} signals`).to.be.an("array");
            for (const signal of signals) {
                expect(["buy", "sell"]).to.include(signal.type);
                expect(signal.barIndex).to.be.a("number");
            }
        }
    });

    it("keeps RSI direction useful as both an entry and an exit signal source", () => {
        const strategy = getStrategy("rsi_midline_confirmation");
        const risingSignals = strategy.execute(buildData(80, 1), strategy.defaultParams);
        const fallingSignals = strategy.execute(buildData(80, -1), strategy.defaultParams);

        expect(risingSignals.some((signal) => signal.type === "buy")).to.equal(true);
        expect(fallingSignals.some((signal) => signal.type === "sell")).to.equal(true);

        const merged = mergeExitStrategySignals(
            [{ time: "2024-01-01" as Time, type: "buy", price: 100 }],
            [{ time: "2024-01-02" as Time, type: "sell", price: 99 }]
        );
        expect(merged[1].exitOnly).to.equal(true);
    });
});
