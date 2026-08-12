import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { robust_zscore_typical_fade } from "../../lib/strategies/lib/robust_zscore_typical_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_ABSORPTION_KEYS = [
    "robust_zscore_typical_fade",
];

describe("absorption pressure strategy family", () => {
    it("registers all new absorption strategies in the built-in manifest", () => {
        for (const key of NEW_ABSORPTION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(robust_zscore_typical_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
    });

    it("robust_zscore_typical_fade buys a typical-price extreme under robust scaling", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            // Tiny alternating baseline so MAD is small but nonzero.
            data.push(bar(i, 100, 101, 99, i % 2 === 0 ? 99.9 : 100.1));
        }
        data.push(bar(40, 94.5, 96, 94, 95));
        const signals = robust_zscore_typical_fade.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });
});
