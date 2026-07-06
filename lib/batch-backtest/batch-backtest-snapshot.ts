import { toScalarRow } from "./batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import type { BatchStabilityMineResult } from "./batch-stability-mine";

export const BATCH_RESULT_SNAPSHOT_LIMIT = 2_000;

export interface BatchBacktestResultsSnapshot {
    savedAt: number;
    interval: string;
    fingerprint: string | null;
    serverHasArtifacts: boolean;
    results: BatchBacktestSymbolResult[];
    stabilityResult?: BatchStabilityMineResult | null;
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
        ...(snapshot.stabilityResult ? { stabilityResult: compactStabilityResult(snapshot.stabilityResult) } : {}),
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
        stabilityResult: normalizeStabilityResult(candidate.stabilityResult),
    });
}

function compactStabilityResult(result: BatchStabilityMineResult): BatchStabilityMineResult {
    return {
        reruns: Math.max(0, Math.floor(Number(result.reruns) || 0)),
        subsetSize: Math.max(0, Math.floor(Number(result.subsetSize) || 0)),
        seed: Math.max(0, Math.floor(Number(result.seed) || 0)),
        totalPairs: Math.max(0, Math.floor(Number(result.totalPairs) || 0)),
        hitEvents: Math.max(0, Math.floor(Number(result.hitEvents) || 0)),
        rows: Array.isArray(result.rows)
            ? result.rows.map((row): BatchStabilityMineResult["rows"][number] => ({
                    asset: String(row.asset ?? "").trim().toUpperCase(),
                    direction: row.direction === "SHORT" ? "SHORT" : "LONG",
                    hits: Math.max(0, Math.floor(Number(row.hits) || 0)),
                    high: Math.max(0, Math.floor(Number(row.high) || 0)),
                    medium: Math.max(0, Math.floor(Number(row.medium) || 0)),
                    low: Math.max(0, Math.floor(Number(row.low) || 0)),
                    medianRetPct: finiteOrNull(row.medianRetPct),
                    medianLiftPct: finiteOrNull(row.medianLiftPct),
                    medianRr: finiteOrNull(row.medianRr),
                    medianDist: finiteOrNull(row.medianDist),
                    medianHmaxLiftPct: finiteOrNull(row.medianHmaxLiftPct),
                    pairWarnings: Math.max(0, Math.floor(Number(row.pairWarnings) || 0)),
                }))
                .filter((row) => row.asset)
            : [],
    };
}

function normalizeStabilityResult(value: unknown): BatchStabilityMineResult | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const compact = compactStabilityResult(value as BatchStabilityMineResult);
    return compact.rows.length > 0 ? compact : null;
}

function finiteOrNull(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}
