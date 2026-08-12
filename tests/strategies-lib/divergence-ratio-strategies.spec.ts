import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { open_location_zscore_reversion } from "../../lib/strategies/lib/open_location_zscore_reversion";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_DIVERGENCE_KEYS = [
    "open_location_zscore_reversion",
];

describe("divergence ratio strategy family", () => {
    it("registers all new divergence strategies in the built-in manifest", () => {
        for (const key of NEW_DIVERGENCE_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });


    it("open_location_zscore_reversion fades extreme open locations when the close reverses", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(20, 99, 101.5, 99, 101)); // opened at prior low, closed above midpoint
        data.push(bar(21, 101, 101.5, 99, 99)); // opened at prior high, closed below midpoint
        const signals = open_location_zscore_reversion.execute(data, { lookback: 20 });
        expect(signals.map((s) => s.barIndex)).to.deep.equal([20, 21]);
        expect(signals[0].type).to.equal("buy");
        expect(signals[1].type).to.equal("sell");
    });
});
