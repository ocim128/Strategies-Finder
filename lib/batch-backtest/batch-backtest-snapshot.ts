import { toScalarRow } from "./batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { BATCH_MAX_SYMBOLS } from "./batch-run-contract";

export const BATCH_RESULT_SNAPSHOT_LIMIT = BATCH_MAX_SYMBOLS;

/**
 * Truncated-snapshot row cap used as the tier-2 fallback when the full snapshot
 * exceeds the localStorage quota (audit Finding 5). Keeps the first rows so a
 * reload preserves the same absolute-index prefix used by status recovery.
 */
export const BATCH_RESULT_SNAPSHOT_TRUNCATED_LIMIT = 250;

export interface BatchBacktestResultsSnapshotMeta {
    /**
     * Set when the snapshot was truncated to fit the localStorage quota (audit
     * Finding 5). `totalRows` is the true row count before truncation so the
     * restore path can label the table "restored N of M pairs".
     */
    truncated: true;
    totalRows: number;
}

export interface BatchBacktestResultsSnapshot {
    savedAt: number;
    interval: string;
    fingerprint: string | null;
    // The strategy that governed the Run that produced these results. Used to
    // label the persisted snapshot; if it is lost (older snapshots predate the
    // field) it normalizes to `null`.
    strategyKey: string | null;
    serverHasArtifacts: boolean;
    results: BatchBacktestSymbolResult[];
    /**
     * Optional truncation marker (audit Finding 5). Absent on a full snapshot;
     * present when the snapshot was truncated to fit the localStorage quota.
     * Older snapshots normalize to `undefined`.
     */
    meta?: BatchBacktestResultsSnapshotMeta;
}

export function compactBatchBacktestResultsSnapshot(
    snapshot: BatchBacktestResultsSnapshot,
): BatchBacktestResultsSnapshot {
    return {
        savedAt: Number.isFinite(snapshot.savedAt) ? snapshot.savedAt : Date.now(),
        interval: snapshot.interval,
        fingerprint: typeof snapshot.fingerprint === "string" ? snapshot.fingerprint : null,
        strategyKey: typeof snapshot.strategyKey === "string" && snapshot.strategyKey ? snapshot.strategyKey : null,
        serverHasArtifacts: snapshot.serverHasArtifacts === true,
        // Always project through the scalar allowlist so heavy row artifacts
        // cannot enter localStorage, including rows with no trades.
        results: snapshot.results
            .slice(0, BATCH_RESULT_SNAPSHOT_LIMIT)
            .map((row) => toScalarRow(row)),
        ...(snapshot.meta ? { meta: snapshot.meta } : {}),
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
    const normalized = compactBatchBacktestResultsSnapshot({
        savedAt: typeof candidate.savedAt === "number" ? candidate.savedAt : 0,
        interval: typeof candidate.interval === "string" ? candidate.interval : "",
        fingerprint: typeof candidate.fingerprint === "string" ? candidate.fingerprint : null,
        strategyKey: typeof candidate.strategyKey === "string" && candidate.strategyKey ? candidate.strategyKey : null,
        serverHasArtifacts: candidate.serverHasArtifacts === true,
        results: candidate.results as BatchBacktestSymbolResult[],
    });
    // Preserve the truncation marker across a normalize round-trip so a reload
    // after a quota-constrained save still labels the table correctly.
    if (candidate.meta?.truncated === true && typeof candidate.meta.totalRows === "number") {
        normalized.meta = { truncated: true, totalRows: candidate.meta.totalRows };
    }
    return normalized;
}
