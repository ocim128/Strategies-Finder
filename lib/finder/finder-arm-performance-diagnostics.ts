import type { TopMeanStatusResponse } from "../batch-backtest/sp500-top-mean-coordinator-engine";
import type { TopMeanPerformanceDiagnostic, TopMeanWorkerPoolPerformance } from "../batch-backtest/sp500-top-mean-performance";
import type { FinderArmPerformanceRunContext } from "../types/finder";
import { fnv1a64Hex } from "../batch-backtest/max-active-research-contract";

type CompactWorkerPerformance = Pick<TopMeanWorkerPoolPerformance,
    "workers" | "spawnedWorkers" | "shards" | "workerBundleMs" | "workerStartupMs"
    | "loadMs" | "prepareMs" | "backtestMs" | "artifactMs" | "wallMs" | "cache"
    | "signalGenerationMs" | "exitProcessingMs" | "engineMs" | "engineDiagnosticPairs"
    | "engineDiagnostics" | "pendingShards" | "shardSize">;

export interface FinderArmPerformanceCandidateDiagnostic {
    candidateId: string;
    childRunId: string;
    candidateOrdinal: number;
    strategyKey: string;
    outcome: "completed" | "failed" | "cancelled" | "running";
    error?: string;
    requestedPairs: number;
    completedPairs: number;
    failedPairs: number;
    requestedEngineMode: string;
    actualEngineMode: string;
    typescriptRequirementReasons?: string[];
    performance?: Pick<TopMeanPerformanceDiagnostic,
        "totalMs" | "pairsPerSecond" | "workerCount" | "phases" | "replay" | "runtime">
        & { worker?: CompactWorkerPerformance };
}

/** Fixed-size projection: no trades, candle arrays, results, or event rows. */
export function buildFinderArmPerformanceCandidateDiagnostic(
    identity: Pick<FinderArmPerformanceCandidateDiagnostic,
        "candidateId" | "childRunId" | "candidateOrdinal" | "strategyKey" | "outcome" | "error">,
    status: TopMeanStatusResponse,
): FinderArmPerformanceCandidateDiagnostic {
    const performance = status.performance;
    const worker = performance?.worker;
    return {
        ...identity,
        requestedPairs: status.pairTotals,
        completedPairs: status.completedPairs,
        failedPairs: status.failedPairs,
        requestedEngineMode: status.requestedEngineMode,
        actualEngineMode: status.actualEngineMode,
        ...(performance?.engine ? { typescriptRequirementReasons: performance.engine.typescriptRequirementReasons.slice(0, 4) } : {}),
        ...(performance ? {
            performance: {
                ...(performance.runtime ? { runtime: { ...performance.runtime } } : {}),
                totalMs: performance.totalMs,
                pairsPerSecond: performance.pairsPerSecond,
                workerCount: performance.workerCount,
                phases: { ...performance.phases },
                replay: { ...performance.replay },
                ...(worker ? {
                    worker: {
                        workers: worker.workers,
                        spawnedWorkers: worker.spawnedWorkers,
                        shards: worker.shards,
                        workerBundleMs: worker.workerBundleMs,
                        workerStartupMs: worker.workerStartupMs,
                        loadMs: worker.loadMs,
                        prepareMs: worker.prepareMs,
                        backtestMs: worker.backtestMs,
                        artifactMs: worker.artifactMs,
                        wallMs: worker.wallMs,
                        cache: { ...worker.cache },
                        signalGenerationMs: worker.signalGenerationMs,
                        exitProcessingMs: worker.exitProcessingMs,
                        engineMs: worker.engineMs,
                        engineDiagnosticPairs: worker.engineDiagnosticPairs,
                        engineDiagnostics: { ...worker.engineDiagnostics },
                        pendingShards: worker.pendingShards,
                        shardSize: worker.shardSize,
                    },
                } : {}),
            },
        } : {}),
    };
}

/** One fixed-size accumulator per sweep; live child measurements are never added twice. */
export class FinderArmDiagnosticSummary {
    evaluatedCandidates = 0;
    measuredCandidates = 0;
    failedCandidates = 0;
    cancelledCandidates = 0;
    completedPairs = 0;
    measuredCompletedPairs = 0;
    failedPairs = 0;
    candidateMs = 0;
    phasesMs: Record<string, number> = {};
    replay: Record<string, number> = {};
    worker: Record<string, number> = {};
    cache: Record<string, number> = {};
    enginePhasesMs: Record<string, number> = {};
    slowest: FinderArmPerformanceCandidateDiagnostic[] = [];
    last: FinderArmPerformanceCandidateDiagnostic | null = null;

    record(diagnostic: FinderArmPerformanceCandidateDiagnostic): void {
        this.evaluatedCandidates++;
        this.failedCandidates += Number(diagnostic.outcome === "failed");
        this.cancelledCandidates += Number(diagnostic.outcome === "cancelled");
        this.completedPairs += diagnostic.completedPairs;
        this.failedPairs += diagnostic.failedPairs;
        this.last = diagnostic;
        const p = diagnostic.performance;
        if (!p) return;
        this.measuredCandidates++;
        this.measuredCompletedPairs += diagnostic.completedPairs;
        this.candidateMs += p.totalMs;
        addNumbers(this.phasesMs, p.phases);
        addNumbers(this.replay, p.replay, ["targetCachePeakEntries", "switchSeriesCachePeakPoints"]);
        if (p.worker) {
            const { cache, engineDiagnostics, workers, ...timings } = p.worker;
            addNumbers(this.worker, timings, ["shardSize", "pendingShards"]);
            this.worker.workers = Math.max(this.worker.workers ?? 0, workers);
            addNumbers(this.cache, cache);
            addNumbers(this.enginePhasesMs, engineDiagnostics);
        }
        this.slowest = [...this.slowest, diagnostic]
            .sort((a, b) => (b.performance?.totalMs ?? 0) - (a.performance?.totalMs ?? 0))
            .slice(0, 5);
    }
}

function addNumbers(target: Record<string, number>, source: object, peaks: string[] = []): void {
    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        target[key] = peaks.includes(key) ? Math.max(target[key] ?? 0, value) : (target[key] ?? 0) + value;
    }
}

export function buildFinderArmSpeedReport(args: {
    context: FinderArmPerformanceRunContext;
    summary: FinderArmDiagnosticSummary;
    phase: string;
    finishedAt: number | null;
    progressPercent: number;
    completedCandidates: number;
    current: FinderArmPerformanceCandidateDiagnostic | null;
    childPhase: string | null;
    memory: { rssMb: number; heapUsedMb: number; heapLimitMb: number; systemRamMb: number; cpuCount: number };
    error: string | null;
    now?: number;
}) {
    const { context: c, summary: s } = args;
    const elapsedMs = Math.max(0, (args.finishedAt ?? args.now ?? Date.now()) - c.startedAt);
    const averageMs = s.measuredCandidates ? s.candidateMs / s.measuredCandidates : null;
    const topPhases = Object.entries(s.phasesMs).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([phase, ms]) => ({ phase, ms, candidateTimePct: s.candidateMs > 0 ? ms / s.candidateMs * 100 : 0 }));
    return {
        schema: "finder.arm-speed.v1",
        scope: "arm_performance",
        run: { id: c.runId, phase: args.phase, elapsedMs, progressPercent: args.progressPercent, error: args.error },
        runtime: args.current?.performance?.runtime ?? s.last?.performance?.runtime ?? null,
        config: {
            interval: c.interval, replayMode: c.replayMode ?? "horizon", measurement: c.measurement ?? "return",
            horizon: c.rankingHorizon ?? c.horizon, dateMode: c.dateMode, sampleFromSec: c.sampleFromSec, sampleToSec: c.sampleToSec,
            evaluationCutoffSec: c.evaluationCutoffSec, strategies: c.strategyKeys.length, pairs: c.pairs.length,
            pairListHash: `fnv1a64:${fnv1a64Hex(c.pairs.join("\n"))}`,
            plannedCandidates: c.plannedCandidateCount, requestedEngine: c.requestedEngineMode,
            actualEngines: c.actualEngineModes, mode: c.searchOptions.mode, runsPerStrategy: c.searchOptions.maxRuns,
            executionModel: c.backtestSettings.executionModel, direction: c.backtestSettings.tradeDirection,
            stopLossPercent: c.backtestSettings.stopLossPercent,
            exitOverride: c.searchOptions.exitStrategyOverrideEnabled, commission: c.capitalSettings.commission,
            sizingMode: c.capitalSettings.sizingMode, confirmationStrategies: c.backtestSettings.confirmationStrategies?.length ?? 0,
            selectionCooldown: c.searchOptions.armPerformance?.selectionCooldownEnabled ?? false,
        },
        progress: { completedCandidates: args.completedCandidates, evaluatedCandidates: s.evaluatedCandidates,
            measuredCandidates: s.measuredCandidates, failedCandidates: s.failedCandidates, cancelledCandidates: s.cancelledCandidates,
            completedPairEvaluations: s.completedPairs, failedPairEvaluations: s.failedPairs,
            averageCandidateMs: averageMs, measuredCompletedPairs: s.measuredCompletedPairs,
            measuredPairsPerSecond: s.candidateMs > 0 ? s.measuredCompletedPairs / (s.candidateMs / 1000) : null },
        memory: args.memory,
        timingNotes: ["Totals cover measured finished candidates; current is separate.",
            "Worker times sum concurrent work; replay phases overlap. Live phase times may update only on phase completion.",
            "Engine phases are sampled. RSS covers the server process including worker threads."],
        topPhases,
        phasesMs: s.phasesMs,
        replay: s.replay,
        worker: s.worker,
        cache: s.cache,
        enginePhasesMs: s.enginePhasesMs,
        current: args.current ? { childPhase: args.childPhase, ...args.current } : null,
        slowest: s.slowest,
        last: s.last,
        pairFailures: { preflightSkipped: c.skippedPairs?.length ?? 0, runtimeUnique: c.failedPairs?.length ?? 0,
            examples: c.failedPairs?.slice(0, 3) ?? [] },
    };
}

/** Readable JSON: one line per section/candidate, regardless of sweep size. */
export function formatFinderArmSpeedReport(report: object): string {
    return "{\n" + Object.entries(report).map(([key, value]) =>
        "  " + JSON.stringify(key) + ": " + JSON.stringify(value, (_key, item) =>
            typeof item === "number" && Number.isFinite(item) ? Math.round(item * 100) / 100 : item),
    ).join(",\n") + "\n}";
}
