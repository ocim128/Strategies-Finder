import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { median_velocity_pullback } from "../../lib/strategies/lib/median_velocity_pullback";

const NEW_KEYS = [
    "median_velocity_pullback",
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
        expect(median_velocity_pullback.normalizeParams?.({ lookback: 0 })).to.deep.equal({ lookback: 1 });
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
});
