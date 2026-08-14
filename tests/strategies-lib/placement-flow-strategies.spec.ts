import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { robust_placement_extreme_continuation } from "../../lib/strategies/lib/robust_placement_extreme_continuation";

const NEW_KEYS = [
    "robust_placement_extreme_continuation",
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
        expect(robust_placement_extreme_continuation.normalizeParams?.({ lookback: 1 })).to.deep.equal({ lookback: 2 });
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
});
