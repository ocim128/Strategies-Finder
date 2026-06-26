import { describe, it } from "node:test";
import { expect } from "chai";
import {
    clearActiveBacktestRerunContext,
    getActiveBacktestRerunContext,
    setActiveBacktestRerunContext,
} from "../lib/backtest-rerun-context";

describe("Backtest rerun context", () => {
    it("stores and clears the active rerun handler", async () => {
        let rerunCount = 0;

        setActiveBacktestRerunContext({
            source: "ensemble_preview",
            label: "Conflict preview",
            rerun: async () => {
                rerunCount += 1;
            },
        });

        const active = getActiveBacktestRerunContext();
        expect(active?.source).to.equal("ensemble_preview");
        expect(active?.label).to.equal("Conflict preview");

        await active?.rerun();
        expect(rerunCount).to.equal(1);

        clearActiveBacktestRerunContext();
        expect(getActiveBacktestRerunContext()).to.equal(null);
    });
});
