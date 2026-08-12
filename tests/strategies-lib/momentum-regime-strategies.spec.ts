import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { vwap_deviation_reversion } from "../../lib/strategies/lib/vwap_deviation_reversion";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Bars with a small oscillation around `base`, giving stable non-zero dispersion.
function oscBars(count: number, base: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const close = i % 2 === 0 ? base : base + 0.5;
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

const NEW_MOMENTUM_KEYS = [
    "vwap_deviation_reversion",
];

describe("momentum regime strategy family", () => {
    it("registers all new momentum strategies in the built-in manifest", () => {
        for (const key of NEW_MOMENTUM_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(vwap_deviation_reversion.normalizeParams?.({ period: 3 })).to.deep.equal({ period: 5 });
        expect(vwap_deviation_reversion.normalizeParams?.({ period: 30 })).to.deep.equal({ period: 30 });
    });

    it("vwap_deviation_reversion buys when close sits two ATRs below the VWAP anchor", () => {
        const data = [
            ...oscBars(30, 100),
            bar(30, 89.5, 91, 89, 90),
        ];
        const signals = vwap_deviation_reversion.execute(data, { period: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });
});
