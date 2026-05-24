import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData } from "../../lib/types/strategies";
import { strategyManifest } from "../../lib/strategies/manifest-eager";

const POLYMARKET_1S_ENTRIES = strategyManifest.filter((entry) => entry.strategy.polymarket1sConfig?.required);

function sampleBars(length: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < length; i++) {
        const close = 100 + i * 0.05 + Math.sin(i / 4);
        const open = close - Math.cos(i / 5) * 0.4;
        bars.push({
            time: i + 1,
            open,
            high: Math.max(open, close) + 0.8,
            low: Math.min(open, close) - 0.8,
            close,
            volume: 1000 + (i % 9) * 75,
        });
    }
    return bars;
}

describe("generated Polymarket 1s strategies", () => {
    it("require 1s context and fail closed when it is missing", () => {
        const bars = sampleBars(180);

        expect(POLYMARKET_1S_ENTRIES.length, "manifest has required Polymarket 1s strategies").to.be.greaterThan(0);
        for (const entry of POLYMARKET_1S_ENTRIES) {
            expect(entry.strategy.execute(bars, entry.strategy.defaultParams), `${entry.key} no-context signals`).to.deep.equal([]);
        }
    });

    it("keeps default params canonical and walk-forward params real", () => {
        expect(POLYMARKET_1S_ENTRIES.length, "manifest has required Polymarket 1s strategies").to.be.greaterThan(0);
        for (const entry of POLYMARKET_1S_ENTRIES) {
            const strategy = entry.strategy;
            expect(strategy.normalizeParams?.(strategy.defaultParams), `${entry.key} normalized defaults`).to.deep.equal(strategy.defaultParams);

            const defaultKeys = Object.keys(strategy.defaultParams);
            expect(Object.keys(strategy.paramLabels), `${entry.key} param labels`).to.deep.equal(defaultKeys);
            for (const param of strategy.metadata?.walkForwardParams ?? []) {
                expect(defaultKeys, `${entry.key} walk-forward param ${param}`).to.include(param);
            }
        }
    });
});
