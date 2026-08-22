import { expect } from "chai";
import { describe, it } from "node:test";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { short_return_streak_fade_chop } from "../../lib/strategies/lib/short_return_streak_fade_chop";
import { barsFromCloses } from "../helpers/strategy-fixtures";

// Only the strategies that survived the 89-candidate cull (43caa6d "new lib")
// remain; culled candidates were removed from the manifest and their tests
// deleted with them.
const CHOP_STRATEGY_KEYS = [
    "short_return_streak_fade_chop",
];

describe("chop fade strategy family", () => {
    it("registers the surviving chop strategies in the built-in manifest", () => {
        for (const key of CHOP_STRATEGY_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("short_return_streak_fade_chop buys after three consecutive negative returns", () => {
        const data = barsFromCloses([100, 99, 98, 97, 96, 97]);
        const signals = short_return_streak_fade_chop.execute(data, {});
        expect(signals).to.have.length(2);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
        expect(signals.map((s) => s.barIndex)).to.deep.equal([3, 4]);
    });
});
