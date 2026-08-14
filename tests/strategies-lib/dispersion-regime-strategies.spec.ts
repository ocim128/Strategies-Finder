import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { cmf_extreme_fade } from "../../lib/strategies/lib/cmf_extreme_fade";

const NEW_KEYS = [
    "cmf_extreme_fade",
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

describe("dispersion and regime strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("cmf_extreme_fade sells persistent accumulation and buys persistent distribution", () => {
        const accumulation: OHLCVData[] = [];
        const distribution: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            accumulation.push(bar(i, 100, 101.5, 99.5, 101)); // close near high -> +0.5 multiplier
            distribution.push(bar(i, 100, 100.5, 98.5, 99)); // close near low -> -0.5 multiplier
        }
        const sellSignals = cmf_extreme_fade.execute(accumulation, { lookback: 30 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
        const buySignals = cmf_extreme_fade.execute(distribution, { lookback: 30 });
        expect(buySignals.length).to.be.greaterThan(0);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
    });
});
