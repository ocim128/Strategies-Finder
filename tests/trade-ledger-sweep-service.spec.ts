import { expect } from "chai";
import { describe, it } from "node:test";
import {
    TRADE_LEDGER_SWEEP_ACTIVE_RUN_STORAGE,
    TRADE_LEDGER_SWEEP_LAST_RUN_STORAGE,
    createTradeLedgerSweepRunId,
    formatTradeLedgerSweepDiagnostics,
    isTradeLedgerSweepRunCurrent,
    sortTradeLedgerSweepResults,
    tradeLedgerSweepTerminalEventFromLastRun,
    upsertTradeLedgerSweepResult,
} from "../lib/batch-backtest/trade-ledger-sweep-service";
import type { LedgerSweepRuleResult, LedgerSweepStatusRun } from "../lib/batch-backtest/trade-ledger-sweep-stream-types";

function result(ruleId: string, verdict: LedgerSweepRuleResult["verdict"], holdout: number | null): LedgerSweepRuleResult {
    return {
        ruleId,
        ruleName: ruleId,
        sourceHash: "hash",
        verdict,
        weak: false,
        note: null,
        candidates: 2,
        kept: 2,
        keptPct: 100,
        isMeanPnlDeltaPp: 1,
        isMedianPnlDeltaPp: 1,
        holdoutMeanPnlDeltaPp: holdout,
        holdoutMedianPnlDeltaPp: holdout,
        ruleReplayMs: 1,
        controlReplayMs: 1,
        totalMs: 2,
        reportPath: `reports/${ruleId}.txt`,
        error: null,
    };
}

describe("trade ledger sweep service", () => {
    it("generates run ids accepted by the server ownership guard", () => {
        const runId = createTradeLedgerSweepRunId(1_754_000_000_000, 0.5);
        expect(runId).to.match(/^[A-Za-z0-9_-]{1,64}$/);
    });

    it("rejects stale stream/status events and accepts only the active generation", () => {
        expect(isTradeLedgerSweepRunCurrent("run-new", "run-old")).to.equal(false);
        expect(isTradeLedgerSweepRunCurrent("run-new", "run-new")).to.equal(true);
        expect(isTradeLedgerSweepRunCurrent(null, "run-new")).to.equal(false);
    });

    it("upserts recovered results and keeps canonical verdict ordering", () => {
        const first = result("q-no-edge", "NO-EDGE", 0);
        const edge = result("q-edge", "EDGE-CANDIDATE", 2);
        const updated = result("q-no-edge", "HOLDOUT-NEG", -1);
        const values = upsertTradeLedgerSweepResult([first, edge], updated);
        expect(values.map((item) => item.ruleId)).to.deep.equal(["q-edge", "q-no-edge"]);
        expect(sortTradeLedgerSweepResults(values)[1].verdict).to.equal("HOLDOUT-NEG");
    });

    it("uses the documented persistence envelope and diagnostic copy format", () => {
        expect(TRADE_LEDGER_SWEEP_ACTIVE_RUN_STORAGE).to.deep.equal({
            key: "playground_trade_ledger_sweep_active_server_run",
            schema: "trade_ledger_sweep.active_server_run",
            version: 1,
        });
        expect(TRADE_LEDGER_SWEEP_LAST_RUN_STORAGE).to.deep.equal({
            key: "playground_trade_ledger_sweep_last_server_run",
            schema: "trade_ledger_sweep.last_server_run",
            version: 1,
        });
        expect(formatTradeLedgerSweepDiagnostics({ phase: "replay", peakRssBytes: 4 })).to.equal("{\n  \"phase\": \"replay\",\n  \"peakRssBytes\": 4\n}");
    });

    it("maps a retained last-run snapshot onto the matching terminal event so results survive a refresh", () => {
        const base = {
            runId: "run-1",
            folderId: "folder",
            folderName: "folder",
            mode: "load_once",
            modeReason: "fits",
            startedAt: 1,
            finishedAt: 9,
            totalRules: 2,
            completedRules: 2,
            currentRuleId: null,
            elapsedMs: 8,
            percent: 100,
            results: [result("q-edge", "EDGE-CANDIDATE", 1)],
            diagnostics: { runId: "run-1" },
            outputDir: "archive/sweeps/run-1",
        } as unknown as LedgerSweepStatusRun;
        const done = tradeLedgerSweepTerminalEventFromLastRun("run-1", { ...base, phase: "done", summary: "summary", error: null });
        expect(done).to.include({ type: "done", ok: true, cancelled: false, finishedAt: 9, summary: "summary", outputDir: "archive/sweeps/run-1" });
        const cancelled = tradeLedgerSweepTerminalEventFromLastRun("run-1", { ...base, phase: "cancelled", summary: null });
        expect(cancelled).to.include({ type: "cancelled", ok: false, cancelled: true, summary: "" });
        const fatal = tradeLedgerSweepTerminalEventFromLastRun("run-1", { ...base, phase: "fatal", finishedAt: null, summary: null, error: null });
        expect(fatal).to.include({ type: "fatal", ok: false, cancelled: false, error: "Ledger Sweep failed." });
        expect(fatal.finishedAt).to.be.at.least(1);
    });
});
