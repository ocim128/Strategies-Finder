import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { rejection_confirmed_depth_fade } from "../../lib/strategies/lib/rejection_confirmed_depth_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Bars with close = high and a small oscillation around `base`, giving a stable
// non-zero dispersion for z-scores while keeping a real ATR/range.
function oscBars(count: number, base: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = i % 2 === 0 ? base : base + 0.5;
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

const NEW_CONFIRMATION_KEYS = [
    "rejection_confirmed_depth_fade",
];

describe("confirmation entry strategy family", () => {
    it("registers all new confirmation strategies in the built-in manifest", () => {
        for (const key of NEW_CONFIRMATION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(rejection_confirmed_depth_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
    });

    it("rejection_confirmed_depth_fade buys a deep discount only when the extreme bar shows lower-wick rejection", () => {
        const data = [
            ...oscBars(60, 100),
            bar(60, 100, 100.5, 93, 99), // deep drop with dominant lower wick
        ];
        const signals = rejection_confirmed_depth_fade.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });
});
