/**
 * Stream event contract for the Batch Backtest server-side plugin.
 *
 * The browser consumes these via `consumeNdjsonStream` (lib/ndjson-stream.ts),
 * which dispatches by mapping `event.type` to a camelCase handler key
 * (e.g. `symbol` -> `onSymbol`).
 *
 * CRITICAL CONTRACT: the `row` sent in `symbol` events must contain ONLY
 * scalars. The `data`, `signals`, and `result.trades` arrays stay in Node so
 * the browser tab's memory stays bounded regardless of pair count. The
 * browser reconstructs a `BatchBacktestSymbolResult` with those array fields
 * left `undefined`.
 *
 * Copy parity is preserved by adding tiny derived scalars (`buyHoldPct` and
 * `openTradeAssetScores`) before stripping the heavy arrays.
 *
 * Failures (load_failed / run_failed) are transported as ordinary `symbol`
 * events with the failing `status` set on the row; there is no separate
 * failure event in this contract.
 */

import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
import type { BatchRunPairListProvenanceMeta, BatchUniverseCounts } from "./batch-run-contract";
import { computeBuyAndHoldPct, computeOpenTradeAssetScores } from "./batch-row-scalars";
import type { BacktestResult } from "../types/strategies";

/**
 * Explicit scalar-only projection of {@link BacktestResult} for Batch transport.
 *
 * Only fields consumed by batch-backtest-summary, buildResultRowGrid, Copy
 * Results, and status recovery. Nested analytics arrays (postEntryPath,
 * tradeTimingQuality, equityCurve, trades, …) are intentionally omitted so a
 * future engine option cannot silently reintroduce multi-MB payloads.
 */
export type BatchScalarBacktestResult = Pick<
    BacktestResult,
    | "netProfit"
    | "netProfitPercent"
    | "winRate"
    | "expectancy"
    | "avgTrade"
    | "profitFactor"
    | "maxDrawdown"
    | "maxDrawdownPercent"
    | "totalTrades"
    | "winningTrades"
    | "losingTrades"
    | "avgWin"
    | "avgLoss"
    | "sharpeRatio"
> & {
    trades: [];
    equityCurve: [];
};

/**
 * Project a full engine result into the scalar transport shape.
 * Returns undefined when the input row had no result.
 */
export function toScalarBacktestResult(
    result: BacktestResult | undefined,
): BatchScalarBacktestResult | undefined {
    if (!result) return undefined;
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        winRate: result.winRate,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        profitFactor: result.profitFactor,
        maxDrawdown: result.maxDrawdown,
        maxDrawdownPercent: result.maxDrawdownPercent,
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
        trades: [],
        equityCurve: [],
    };
}

/**
 * Recursive scan used by tests: true when any non-empty nested array remains
 * under a value. Intended for `toScalarRow(...).result` so empty
 * trades/equityCurve placeholders pass and large analytics arrays fail.
 */
export function containsNonEmptyNestedArrays(value: unknown, depth = 0): boolean {
    if (depth > 8 || value === null || value === undefined) return false;
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
            if (containsNonEmptyNestedArrays(child, depth + 1)) return true;
        }
    }
    return false;
}

export type BatchStreamEvent =
    | { type: "start"; total: number; interval: string; strategyKey: string; runId?: string }
    | { type: "progress"; percent: number; text: string; status: string }
    | { type: "symbol"; index: number; total: number; row: BatchBacktestSymbolResult }
    | {
        type: "done";
        ok: boolean;
        cancelled: boolean;
        interval: string;
        totals: { loadedSymbols: number; failedSymbols: number };
        summary: string;
        /** True when the server retains per-row artifacts (data/signals/trades) for OPEN_SCORE USD Replay. */
        serverHasArtifacts: boolean;
        /** Fingerprint of the run settings; OPEN_SCORE USD must match it before starting. */
        fingerprint: string | null;
        /** Server-side loader cache counters captured at run completion. */
        cacheStats?: BatchDatasetCacheStats;
        /** Browser-generated run id (audit Finding 5). Optional for backward
         *  compat with stale browser bundles that predate the runId contract;
         *  the server still scopes Stop by runId once the browser sends one. */
        runId?: string;
        /**
         * Audit artifact-stats finding: partial-write outcomes. Present so the
         * browser can surface "artifacts X/Y; OPEN_SCORE USD will omit Z failed writes"
         * without polling `/status`. Null when the run produced no artifacts.
         */
        artifactStats?: { eligible: number; stored: number; failed: number; bytesWritten: number } | null;
        /**
         * Audit parse-cache finding: parsed-artifact LRU counters. Diagnostics-
         * only; lets the benchmark surface cache hit rate and eviction counts.
         */
        parsedCacheStats?: { size: number; max: number; hits: number; misses: number; evictions: number; peak: number } | null;
        /**
         * Phase 3 MAX_ACTIVE: optional verified pair-list provenance metadata.
         * Present on the `done` event when the run carried provenance. The
         * browser surfaces this in the OPEN_SCORE USD report so a forward
         * holdout can be linked back to the generator output.
         */
        pairListProvenanceMeta?: BatchRunPairListProvenanceMeta | null;
        /**
         * Phase 3 MAX_ACTIVE: optional universe counts (submitted /
         * canonical / artifact-eligible / stored / failed / degree map).
         * Bounded scalars only — no OHLCV arrays.
         */
        universeCounts?: BatchUniverseCounts | null;
        /**
         * Phase 3 MAX_ACTIVE: optional verified pair-list provenance, carried
         * when status === "verified". Older clients ignore this; the OPEN_SCORE
         * USD engine reads it to label the report HOLDOUT vs EXPLORATORY.
         */
        verifiedPairListProvenance?: PairListProvenanceV1 | null;
    }
    | { type: "fatal"; error: string; runId?: string };

/**
 * Strip the heavy array fields from a per-symbol result so it is safe to send
 * over the wire. The browser tab keeps only the rendered scalars; the heavy
 * arrays stay server-side for OPEN_SCORE USD Replay.
 *
 * Projection is an explicit allowlist (not a spread + override) so optional
 * nested analytics on {@link BacktestResult} cannot leak into browser/status
 * localStorage paths.
 */
export function toScalarRow(row: BatchBacktestSymbolResult): BatchBacktestSymbolResult {
    return {
        symbol: row.symbol,
        status: row.status,
        barCount: row.barCount,
        firstTime: row.firstTime,
        lastTime: row.lastTime,
        result: toScalarBacktestResult(row.result) as BatchBacktestSymbolResult["result"],
        // Intentionally omit `data` and `signals`; keep only derived scalars
        // needed by Copy Results.
        tradeSummary: row.tradeSummary,
        buyHoldPct: row.buyHoldPct ?? computeBuyAndHoldPct(row.data),
        openTradeAssetScores: row.openTradeAssetScores ?? computeOpenTradeAssetScores([row]),
        error: row.error,
    };
}

