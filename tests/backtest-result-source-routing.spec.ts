import { expect } from "chai";
import { after, describe, it } from "node:test";
import type { BacktestResultSource } from "../lib/state";
import { state } from "../lib/state";
import { clearBacktestResults, commitBacktestResult } from "../lib/state-actions";
import type { BacktestResult } from "../lib/strategies/index";

// AGENTS.md calls out that `walk_forward_oos` snapshots intentionally route
// through shared result state, and that the source marker
// (`currentBacktestResultSource`) is what distinguishes a user-initiated
// backtest from a finder selection / endpoint preview / ensemble preview /
// walk-forward snapshot. `commitBacktestResult` is the single chokepoint that
// sets both the result and the source; `clearBacktestResults` must reset the
// source so a stale finder/endpoint/ensemble/walk-forward marker cannot leak
// into the next manual backtest. These specs lock that routing contract.

const ALL_SOURCES: readonly BacktestResultSource[] = [
    "backtest",
    "endpoint_preview",
    "ensemble_preview",
    "finder_selection",
    "walk_forward_oos",
] as const;

function makeMinimalResult(): BacktestResult {
    // Minimal shape — the routing contract only cares that the object is stored
    // and that the source marker follows it. Field-level correctness is covered
    // by backtesting-engine.spec.ts.
    return {
        trades: [],
        totalTrades: 0,
        winRate: 0,
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        finalEquity: 0,
    } as unknown as BacktestResult;
}

describe("backtest result source routing", () => {
    // The shared singleton is mutated by these tests; snapshot and restore so the
    // suite stays isolated from other tests that may run in the same process.
    const originalResult = state.currentBacktestResult;
    const originalSource = state.currentBacktestResultSource;

    it("commitBacktestResult stamps the declared source onto shared state", () => {
        for (const source of ALL_SOURCES) {
            commitBacktestResult(makeMinimalResult(), source);
            expect(
                state.currentBacktestResultSource,
                `source after commit(${source})`
            ).to.equal(source);
            expect(state.currentBacktestResult, `result stored after commit(${source})`).to.not.equal(null);
        }
    });

    it("clearBacktestResults resets the source to the manual-backtest owner", () => {
        // Simulate a non-manual source (e.g. a finder selection) owning the state.
        commitBacktestResult(makeMinimalResult(), "finder_selection");
        expect(state.currentBacktestResultSource).to.equal("finder_selection");

        clearBacktestResults("test");
        expect(
            state.currentBacktestResultSource,
            "clear must hand ownership back to manual backtest"
        ).to.equal("backtest");
        expect(state.currentBacktestResult).to.equal(null);
    });

    it("a manual backtest commit overwrites a prior walk_forward_oos marker", () => {
        // The documented risk: walk_forward_oos snapshots route through shared
        // state; a subsequent manual run must reclaim the source so UI cues
        // (e.g. "this is an OOS snapshot") do not persist incorrectly.
        commitBacktestResult(makeMinimalResult(), "walk_forward_oos");
        expect(state.currentBacktestResultSource).to.equal("walk_forward_oos");

        commitBacktestResult(makeMinimalResult(), "backtest");
        expect(
            state.currentBacktestResultSource,
            "manual backtest must overwrite walk_forward_oos marker"
        ).to.equal("backtest");
    });

    // Restore so this suite does not leak state into siblings.
    after(() => {
        state.set("currentBacktestResult", originalResult);
        state.set("currentBacktestResultSource", originalSource);
    });
});
