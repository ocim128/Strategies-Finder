import { toScalarRow } from "./batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

export const BATCH_RESULT_SNAPSHOT_LIMIT = 2_000;

export interface BatchBacktestResultsSnapshot {
    savedAt: number;
    interval: string;
    fingerprint: string | null;
    serverHasArtifacts: boolean;
    results: BatchBacktestSymbolResult[];
}

export function compactBatchBacktestResultsSnapshot(
    snapshot: BatchBacktestResultsSnapshot,
): BatchBacktestResultsSnapshot {
    return {
        savedAt: Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : Date.now(),
        interval: snapshot.interval,
        fingerprint: typeof snapshot.fingerprint === "string" ? snapshot.fingerprint : null,
        serverHasArtifacts: snapshot.serverHasArtifacts === true,
        results: snapshot.results
            .slice(0, BATCH_RESULT_SNAPSHOT_LIMIT)
            .map(toScalarRow),
    };
}

export function normalizeBatchBacktestResultsSnapshot(value: unknown): BatchBacktestResultsSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Partial<BatchBacktestResultsSnapshot>;
    if (!Array.isArray(candidate.results) || candidate.results.length === 0) {
        return null;
    }
    return compactBatchBacktestResultsSnapshot({
        savedAt: typeof candidate.savedAt === "number" ? candidate.savedAt : 0,
        interval: typeof candidate.interval === "string" ? candidate.interval : "",
        fingerprint: typeof candidate.fingerprint === "string" ? candidate.fingerprint : null,
        serverHasArtifacts: candidate.serverHasArtifacts === true,
        results: candidate.results as BatchBacktestSymbolResult[],
    });
}
