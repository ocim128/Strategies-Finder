import assert from "node:assert/strict";
import { it } from "node:test";
import { backtestService } from "../lib/backtest-service";
import { MONTE_CARLO_REQUIRED_IDS } from "../lib/monte-carlo-dom";
import { initMonteCarloService, refreshMonteCarloFromState } from "../lib/monte-carlo-service";
import { state } from "../lib/state";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";
import { createFakeElement } from "./helpers/fake-element";
import { waitFor } from "./helpers/wait-for";

function createResult(pnl: number): BacktestResult {
    const trades: Trade[] = Array.from({ length: 5 }, (_, index) => ({
        id: index + 1, type: "long", entryTime: (1000 + index * 60) as Time,
        exitTime: (1030 + index * 60) as Time, entryPrice: 100, exitPrice: 100 + pnl,
        size: 1, fees: 0, pnl, pnlPercent: pnl, exitReason: "signal",
    }));
    return {
        trades, netProfit: pnl * 5, netProfitPercent: pnl / 20,
        winRate: 100, expectancy: pnl, avgTrade: pnl, profitFactor: Infinity,
        maxDrawdown: 0, maxDrawdownPercent: 0, totalTrades: 5,
        winningTrades: 5, losingTrades: 0, avgWin: pnl, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

it("Monte Carlo results belong to the current backtest, including replacement at the final yield", async () => {
    const globals = ["document", "window"] as const;
    const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const originalCapitalSettings = backtestService.getCapitalSettings;
    const originalResult = state.currentBacktestResult;
    const elements = new Map(MONTE_CARLO_REQUIRED_IDS.map(id => [
        id as string, { ...createFakeElement(), getContext: () => null },
    ]));
    const el = (id: string) => elements.get(id)!;
    const first = createResult(1);
    const replacement = createResult(2);
    let onProgress: (() => void) | null = null;
    let status = "Ready";
    Object.defineProperty(el("mc-status"), "textContent", {
        get: () => status,
        set: (value: string) => {
            status = value;
            if (value.startsWith("Running Sequence Only:") && onProgress) {
                const callback = onProgress;
                onProgress = null;
                callback();
            }
        },
    });
    Object.defineProperty(globalThis, "document", {
        configurable: true, value: { getElementById: (id: string) => elements.get(id) ?? null },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true, value: { addEventListener: () => {} },
    });
    backtestService.getCapitalSettings = () => ({
        initialCapital: 10000, positionSize: 10, commission: 0,
        sizingMode: "fixed", fixedTradeAmount: 100,
    });
    el("mc-simulations").value = "1";
    el("mc-seed").value = "1337";
    el("mc-sequence-toggle").checked = true;
    el("mc-ruin-threshold").value = "50";
    el("mc-initial-capital").value = "10000";

    const run = async () => {
        el("mc-run-btn").click();
        await waitFor(() => !el("mc-run-btn").disabled, 2000, "Monte Carlo run to settle");
    };
    try {
        state.set("currentBacktestResult", first);
        initMonteCarloService();
        await run();
        assert.match(status, /^Completed/);
        assert.equal(el("mc-results").style.display, "block");
        assert.equal(el("mc-median-profit").textContent, "+$5.00");

        refreshMonteCarloFromState();
        assert.equal(el("mc-results").style.display, "block", "reopening the same backtest preserves its results");
        state.set("currentBacktestResult", replacement);
        assert.equal(el("mc-results").style.display, "none", "a new backtest invalidates completed results immediately");
        assert.match(status, /backtest/i);
        await run();
        assert.equal(el("mc-median-profit").textContent, "+$10.00", "retry uses the replacement backtest");

        onProgress = () => state.set("currentBacktestResult", first);
        await run();
        assert.equal(el("mc-results").style.display, "none", "replacement during the final yield prevents stale publication");
        assert.match(status, /backtest/i);
        assert.equal(el("mc-spinner").style.display, "none");
        await run();
        assert.equal(el("mc-median-profit").textContent, "+$5.00");

        // A -> B -> A must invalidate the run even though object identity is
        // back to the original by the time the async simulation settles.
        el("mc-bootstrap-toggle").checked = true;
        onProgress = () => {
            state.set("currentBacktestResult", replacement);
            state.set("currentBacktestResult", first);
        };
        await run();
        assert.equal(el("mc-results").style.display, "none", "replacement prevents all later scenarios from publishing");
        assert.match(status, /backtest/i);
        el("mc-bootstrap-toggle").checked = false;

        // More than one chunk exercises an AbortError from the engine instead
        // of a successful return from its final yield.
        el("mc-simulations").value = "5001";
        onProgress = () => state.set("currentBacktestResult", replacement);
        await run();
        assert.equal(el("mc-results").style.display, "none");
        assert.match(status, /backtest/i, "the aborted run must preserve the replacement status");
        el("mc-simulations").value = "1";

        onProgress = () => state.set("currentBacktestResult", null);
        el("mc-run-btn").click();
        await waitFor(() => el("mc-spinner").style.display === "none", 2000, "cleared-backtest run to settle");
        assert.equal(el("mc-results").style.display, "none");
        assert.equal(el("mc-empty-state").style.display, "block");
        assert.equal(el("mc-run-btn").disabled, true);
        assert.equal(status, "Please run a backtest first");

        state.set("currentBacktestResult", replacement);
        onProgress = () => el("mc-cancel-btn").click();
        await run();
        assert.equal(el("mc-results").style.display, "none", "Cancel at the final yield prevents publication");
        assert.equal(status, "Monte Carlo run cancelled");
        await run();
        assert.match(status, /^Completed/);
        assert.equal(el("mc-results").style.display, "block");
    } finally {
        onProgress = null;
        el("mc-cancel-btn").click();
        await waitFor(() => el("mc-spinner").style.display === "none", 2000, "Monte Carlo cleanup");
        state.set("currentBacktestResult", originalResult);
        backtestService.getCapitalSettings = originalCapitalSettings;
        globals.forEach((key, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});
