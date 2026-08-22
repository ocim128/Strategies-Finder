import { expect } from "chai";
import { describe, it } from "node:test";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { vwap_deviation_reversion } from "../../lib/strategies/lib/vwap_deviation_reversion";
import { bar, oscillatingBars } from "../helpers/strategy-fixtures";

// Bars with a small oscillation around `base`, giving stable non-zero dispersion.
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
            ...oscillatingBars(30, 100),
            bar(30, 89.5, 91, 89, 90),
        ];
        const signals = vwap_deviation_reversion.execute(data, { period: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });
});
