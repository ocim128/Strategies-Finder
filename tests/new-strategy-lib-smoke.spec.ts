import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest";

const strategies = strategyManifest;

function buildSampleData(length: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;

    for (let i = 0; i < length; i++) {
        const drift = i < length / 2 ? 0.18 : -0.12;
        const wave = Math.sin(i / 6) * 0.75;
        const previousClose = close;
        close = Math.max(5, close + drift + wave * 0.2);
        const open = previousClose + Math.sin(i / 5) * 0.3;
        const high = Math.max(open, close) + 1 + Math.abs(Math.sin(i / 7));
        const low = Math.min(open, close) - 1 - Math.abs(Math.cos(i / 9));
        data.push({
            time: `2024-01-${String((i % 28) + 1).padStart(2, "0")}` as Time,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 11) * 125 + Math.round(Math.abs(wave) * 200),
        });
    }

    return data;
}

describe("new strategy lib smoke checks", () => {
    it("keeps default parameter contracts aligned", () => {
        for (const { key, strategy } of strategies) {
            const defaultParamKeys = Object.keys(strategy.defaultParams);
            expect(Object.keys(strategy.paramLabels), `${key} param label keys`).to.deep.equal(defaultParamKeys);
            for (const walkForwardParam of strategy.metadata?.walkForwardParams ?? []) {
                expect(defaultParamKeys, `${key} walk-forward param ${walkForwardParam}`).to.include(walkForwardParam);
            }
            expect(strategy.normalizeParams?.(strategy.defaultParams) ?? strategy.defaultParams, `${key} normalized defaults`)
                .to.deep.equal(strategy.defaultParams);
        }
    });

    it("executes each strategy with default params without throwing", () => {
        const data = buildSampleData(220);
        for (const { key, strategy } of strategies) {
            const signals = strategy.execute(data, strategy.defaultParams);
            expect(signals, `${key} signals`).to.be.an("array");
            for (const signal of signals) {
                expect(signal.type === "buy" || signal.type === "sell", `${key} signal type`).to.equal(true);
                expect(signal.barIndex, `${key} signal barIndex`).to.be.a("number");
            }
        }
    });
});
