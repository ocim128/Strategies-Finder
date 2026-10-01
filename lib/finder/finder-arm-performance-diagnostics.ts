import type { TopMeanStatusResponse } from "../batch-backtest/sp500-top-mean-coordinator-engine";
import type { TopMeanPerformanceDiagnostic, TopMeanWorkerPoolPerformance } from "../batch-backtest/sp500-top-mean-performance";

type CompactWorkerPerformance = Pick<TopMeanWorkerPoolPerformance,
    "workers" | "spawnedWorkers" | "shards" | "workerBundleMs" | "workerStartupMs"
    | "loadMs" | "prepareMs" | "backtestMs" | "artifactMs" | "wallMs" | "cache">;

export interface FinderArmPerformanceCandidateDiagnostic {
    candidateId: string;
    childRunId: string;
    candidateOrdinal: number;
    strategyKey: string;
    outcome: "completed" | "failed" | "cancelled";
    error?: string;
    requestedPairs: number;
    completedPairs: number;
    failedPairs: number;
    requestedEngineMode: string;
    actualEngineMode: string;
    performance?: Pick<TopMeanPerformanceDiagnostic,
        "totalMs" | "pairsPerSecond" | "workerCount" | "phases" | "replay">
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
        ...(performance ? {
            performance: {
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
                    },
                } : {}),
            },
        } : {}),
    };
}
