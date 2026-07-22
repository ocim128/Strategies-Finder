import { toScalarRow } from "./batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { BATCH_MAX_SYMBOLS } from "./batch-run-contract";

export const BATCH_RESULT_SNAPSHOT_LIMIT = BATCH_MAX_SYMBOLS;

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
        // Skip the per-row clone for rows that already satisfy the scalar
        // invariant (no `data` and no `trades`/`equityCurve`). Every
        // server-streamed row already meets this — re-cloning with
        // `{ ...row.result, trades: [], equityCurve: [] }` per row allocated a
        // fresh object graph per row for no behavioral change. Rows that still
        // carry array artifacts (browser-side rows that have not been pruned)
        // keep going through `toScalarRow` exactly as before.
        results: snapshot.results
            .slice(0, BATCH_RESULT_SNAPSHOT_LIMIT)
            .map((row) => (row.data === undefined && (row.result?.trades?.length ?? 0) === 0 ? row : toScalarRow(row))),
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
        strategyKey: typeof candidate.strategyKey === "string" && candidate.strategyKey ? candidate.strategyKey : null,
        serverHasArtifacts: candidate.serverHasArtifacts === true,
        results: candidate.results as BatchBacktestSymbolResult[],
    });
}
