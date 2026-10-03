import { expect } from "chai";
import { describe, it, afterEach } from "node:test";
import {
    FinderArmDiagnosticSummary, buildFinderArmSpeedReport, formatFinderArmSpeedReport,
    type FinderArmPerformanceCandidateDiagnostic,
} from "../lib/finder/finder-arm-performance-diagnostics";
import { __testInternals } from "../lib/finder/server/finder-vite-plugin";
import type { FinderArmPerformanceRunContext } from "../lib/types/finder";

function candidate(ordinal: number): FinderArmPerformanceCandidateDiagnostic {
    return {
        candidateId: `speed:candidate-${ordinal}`, candidateOrdinal: ordinal, childRunId: `child-${ordinal}`,
        strategyKey: `strategy-${ordinal}`, outcome: "completed", requestedPairs: 5000,
        completedPairs: 4990, failedPairs: 10, requestedEngineMode: "typescript", actualEngineMode: "typescript",
        performance: { totalMs: 100 + ordinal, pairsPerSecond: 100, workerCount: 4,
            phases: { preflightMs: 5, backtestingMs: 60, snapshotMs: 5, replayMs: 30, resultWriteMs: 0 },
            replay: { scanMs: 1, eventsMs: 2, targetsMs: 3, outcomesMs: 4, aggregateMs: 20,
                targetLoadMs: 2, targetDatasets: 8, targetCacheHits: 4, targetCacheMisses: 8, targetCachePeakEntries: 3 } },
    };
}
function context(): FinderArmPerformanceRunContext {
    return {
        runId: "speed", startedAt: 1000, strategyKeys: Array(41).fill("strategy"), pairs: Array(5000).fill("AAA+BBB"),
        interval: "1d", replayMode: "asset_switch", measurement: "ranking_consistency", rankingHorizon: 6,
        dateMode: "full", evaluationCutoffSec: 1, plannedCandidateCount: 41, actualEngineModes: ["typescript"],
        capTiltWeight: "off", searchOptions: { mode: "random", maxRuns: 1 },
        backtestSettings: { executionModel: "next_open" }, capitalSettings: { commission: 0 }, requestedEngineMode: "typescript",
    } as FinderArmPerformanceRunContext;
}

afterEach(() => __testInternals.resetRunStateForTests());
describe("Arm speed diagnostics", () => {
    it("aggregates the whole sweep and retains only five slow candidates", () => {
        const summary = new FinderArmDiagnosticSummary();
        for (let i = 0; i < 100; i++) summary.record(candidate(i));
        const active = { ...candidate(100), outcome: "running" as const };
        const report = buildFinderArmSpeedReport({
            context: context(), summary, phase: "evaluating", finishedAt: null, now: 11000,
            progressPercent: 20, completedCandidates: 100, current: active, childPhase: "aggregate", error: null,
            memory: { rssMb: 200, heapUsedMb: 100, heapLimitMb: 16000, systemRamMb: 32000, cpuCount: 8 },
        });
        expect(summary.slowest.map((c) => c.candidateOrdinal)).to.deep.equal([99, 98, 97, 96, 95]);
        expect(report.phasesMs.backtestingMs).to.equal(6000);
        expect(report.replay.targetCachePeakEntries).to.equal(3);
        expect(report.progress.completedPairEvaluations).to.equal(499000);
        expect(report.progress.measuredCandidates).to.equal(100);
        expect(report.run.elapsedMs).to.equal(10000);
        expect(report.runtime).to.equal(null);
        expect(report.current!.performance!.totalMs).to.equal(200);
        expect(report.topPhases[0]!.phase).to.equal("backtestingMs");
        const text = formatFinderArmSpeedReport(report);
        expect(JSON.parse(text).config.pairs).to.equal(5000);
        expect(text.split("\n").length).to.be.lessThan(35);
        expect(text.length).to.be.lessThan(12000);
        expect(text).not.to.contain("AAA+BBB");
    });

    it("retains failure and cancellation counts even without phase measurements", () => {
        const summary = new FinderArmDiagnosticSummary();
        summary.record({ ...candidate(0), outcome: "failed", error: "load failed", performance: undefined });
        summary.record({ ...candidate(1), outcome: "cancelled" });
        expect(summary.evaluatedCandidates).to.equal(2);
        expect(summary.measuredCandidates).to.equal(1);
        expect(summary.failedCandidates).to.equal(1);
        expect(summary.cancelledCandidates).to.equal(1);
    });

    it("reports the executing child's runtime and prefers the current child over the last result", () => {
        const summary = new FinderArmDiagnosticSummary();
        const completed = candidate(0);
        completed.performance!.runtime = { processId: 10, nodeVersion: "v22.0.0", processStartedAt: "2026-10-03T01:00:00Z", replayImplementation: "previous" };
        summary.record(completed);
        const args = { context: context(), summary, phase: "done", finishedAt: 11000,
            progressPercent: 100, completedCandidates: 1, current: null, childPhase: null, error: null,
            memory: { rssMb: 200, heapUsedMb: 100, heapLimitMb: 16000, systemRamMb: 32000, cpuCount: 8 } };
        expect(buildFinderArmSpeedReport(args).runtime).to.deep.equal(completed.performance!.runtime);
        const first = buildFinderArmSpeedReport(args).config.pairListHash;
        const changedContext = { ...args.context, pairs: args.context.pairs.map((pair, index) => index === 0 ? "CCC+DDD" : pair) };
        expect(buildFinderArmSpeedReport({ ...args, context: changedContext }).config.pairListHash).not.to.equal(first);
        expect(buildFinderArmSpeedReport(args).config.pairListHash).to.equal(first);
        const active = candidate(1);
        active.performance!.runtime = { ...completed.performance!.runtime, processId: 20, replayImplementation: "current" };
        expect(buildFinderArmSpeedReport({ ...args, current: active }).runtime).to.deep.equal(active.performance!.runtime);
    });

    it("requires a matching Arm run id and returns bounded diagnostics before results exist", () => {
        __testInternals.setRunStateForTests({
            runId: "speed", jobKind: "arm_performance", startedAt: 1000, finishedAt: null,
            interval: "1d", strategyKeys: [], strategyIndex: 0, strategyCount: 41, phase: "evaluating",
            totalSymbols: 5000, progressPercent: 0, statusText: "starting", loadedSymbols: 0, failedSymbols: 0,
            candidates: [], diagnostics: null, cancelled: false, summary: null, error: null, totals: null,
            armPerformanceRunContext: context(), armDiagnosticSummary: new FinderArmDiagnosticSummary(),
        });
        for (const id of [null, "", "other"]) {
            expect(__testInternals.handleArmDiagnosticsRequest(id)).to.have.property("ok", false);
        }
        const report = __testInternals.handleArmDiagnosticsRequest("speed");
        expect(report).to.have.property("schema", "finder.arm-speed.v1");
        expect(report).not.to.have.property("terminalArmPerformanceResults");
        expect(JSON.stringify(report).length).to.be.lessThan(4000);
    });
});
