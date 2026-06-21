import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSharedSyntheticApplyPlan } from "../lib/handlers/settings-handlers-shared";

describe("settings handlers shared helpers", () => {
    it("suppresses both auto reloads for shared synthetic configs when symbol and interval change", () => {
        const plan = buildSharedSyntheticApplyPlan({
            config: {
                syntheticPair: {
                    baseSymbol: "BTCUSDT",
                    quoteSymbol: "ETHUSDT",
                },
            },
            currentSymbol: "ETHUSDT",
            currentInterval: "1h",
            context: {
                symbol: "BTCETH",
                interval: "4h",
            },
        });

        assert.equal(plan.suppressCount, 2);
        assert.equal(plan.nextSymbol, "BTCETH");
        assert.equal(plan.nextInterval, "4h");
        assert.deepEqual(plan.syntheticPair, {
            baseSymbol: "BTCUSDT",
            quoteSymbol: "ETHUSDT",
        });
    });

    it("does not suppress reloads for non-synthetic shared configs", () => {
        const plan = buildSharedSyntheticApplyPlan({
            config: {
                syntheticPair: undefined,
            },
            currentSymbol: "ETHUSDT",
            currentInterval: "1h",
            context: {
                symbol: "SOLUSDT",
                interval: "2h",
            },
        });

        assert.equal(plan.suppressCount, 0);
        assert.equal(plan.syntheticPair, null);
    });
});
