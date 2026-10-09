import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBacktestResultUiSteps } from "../lib/handlers/backtest-result-ui-steps";

describe("backtest result UI sync", () => {
    it("continues later result UI steps when an earlier chart step fails", () => {
        const calls: string[] = [];

        assert.doesNotThrow(() => runBacktestResultUiSteps([
            {
                step: "strategy_indicators",
                run: () => {
                    calls.push("strategy_indicators");
                    throw new Error("indicator render failed");
                },
            },
            {
                step: "results_panel",
                run: () => {
                    calls.push("results_panel");
                },
            },
            {
                step: "trade_markers",
                run: () => {
                    calls.push("trade_markers");
                },
            },
        ]));

        assert.deepEqual(calls, [
            "strategy_indicators",
            "results_panel",
            "trade_markers",
        ]);
    });
});
