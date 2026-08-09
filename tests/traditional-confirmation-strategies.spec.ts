import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest-eager";

const retainedKeys = [
    "parabolic_sar_confirmation",
    "dmi_direction_confirmation",
] as const;

function buildData(length: number, direction: 1 | -1 = 1): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < length; i++) {
        const previousClose = close;
        const regimeDirection = i < length / 2 ? direction : -direction;
        close += regimeDirection * (0.15 + (i % 7) * 0.03) + Math.sin(i / 4) * 0.12;
        const open = previousClose - regimeDirection * 0.05 + Math.sin(i / 3) * 0.08;
        data.push({
            time: (1_700_000_000 + i * 60) as Time,
            open,
            high: Math.max(open, close) + 0.7 + (i % 5) * 0.04,
            low: Math.min(open, close) - 0.6 - (i % 3) * 0.05,
            close: Math.max(1, close),
            volume: 1000 + (i % 9) * 100 + Math.round(150 * Math.sin(i / 5)),
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
        for (const key of retainedKeys) {
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

    it("executes every retained strategy on a sufficiently long dataset", () => {
        const data = buildData(480);
        for (const key of retainedKeys) {
            const strategy = getStrategy(key);
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals, `${key} signals`).to.be.an("array");
            expect(signals.length, `${key} emits directional state`).to.be.greaterThan(0);
            for (const signal of signals) {
                expect(["buy", "sell"]).to.include(signal.type);
                expect(signal.barIndex).to.be.a("number");
            }
        }
    });
});
