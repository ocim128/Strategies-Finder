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
 * Copy parity is preserved by adding tiny derived scalars (`buyHoldPct`,
 * `strategyComparisonPct`, and `openTradeAssetScores`) before stripping the
 * heavy arrays.
 *
 * Failures (load_failed / run_failed) are transported as ordinary `symbol`
 * events with the failing `status` set on the row; there is no separate
 * failure event in this contract.
 */

import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
import type { BatchRunPairListProvenanceMeta, BatchUniverseCounts } from "./batch-run-contract";
import type { MaxActiveResearchRegistrationV1 } from "./max-active-research-contract";
import { computeBuyAndHoldPct, computeOpenTradeAssetScores } from "./batch-row-scalars";
import type { BacktestResult } from "../types/strategies";
import type { TradeGateProvenance, TradeGateStats } from "./trade-gate";

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
    | "tradeGateStats"
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
        ...(result.tradeGateStats ? { tradeGateStats: result.tradeGateStats } : {}),
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
        totals: {
            loadedSymbols: number;
            failedSymbols: number;
            attemptedSymbols?: number;
            cancelledSymbols?: number;
        };
        summary: string;
        /** True when the server retains per-row artifacts (data/signals/trades) for OPEN_SCORE USD Replay. */
        serverHasArtifacts: boolean;
        /** Fingerprint of the run settings; OPEN_SCORE USD must match it before starting. */
        fingerprint: string | null;
        /** Server-side loader cache counters captured at run completion. */
        cacheStats?: BatchDatasetCacheStats;
        performance?: {
            datasetWaitMs: number;
            executeMs: number;
            resultProjectionMs: number;
            completionCallbackMs: number;
        };
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
        /** Selected EDGE-CANDIDATE rules and source hashes used by this run. */
        tradeGateProvenance?: TradeGateProvenance | null;
        /** Aggregate entry-gate counters across completed pair results. */
        tradeGateStats?: TradeGateStats | null;
    }
    | { type: "fatal"; error: string; runId?: string };

/**
 * Terminal phase of a Batch run, mirrored from the server plugin's
 * `BatchRunPhase`. Declared here (rather than imported from the plugin) so this
 * leaf stream-contract module stays free of a circular dependency on the plugin
 * that imports it. The plugin re-exports its own `BatchRunPhase`; the two must
 * stay in lockstep (audit Finding 7).
 */
export type BatchStatusRunPhase = "running" | "done" | "cancelled" | "fatal";

/**
 * Shared `/api/batch-backtest/status` response contract (audit Finding 7).
 *
 * The browser's reattach poll (`reattachToInProgressServerRun` in
 * batch-backtest-service.ts) previously re-declared this shape as an inline
 * anonymous type, while the server producer (`handleStatusRequest` in
 * batch-backtest-vite-plugin.ts) returned `unknown`. Drift between the two was a
 * known historical bug class — terminal-row pagination fields (`rowOffset` /
 * `nextOffset` / `rowCount`), `strategyKey`, and `cacheStats` were each dropped
 * on one side in past regressions. One shared type + the contract test in
 * batch-backtest-server-plugin.spec.ts makes the next field drop a compile
 * failure instead of a silent empty-table symptom.
 *
 * The producer always sets `ok: true`; the `ok: false` error shape lives on the
 * SP500 TOP_MEAN status route, not this one. `runMismatch` is the server's
 * signal that the retained run is no longer the one this tab asked about.
 */
export type BatchStatusResponse = {
    ok: true;
    /** True when the retained run is no longer the one this tab asked about. */
    runMismatch?: boolean;
    running: boolean;
    /** Present while a run owns the server (`running === true`). */
    run: BatchLiveRunStatus | null;
    /** Present when a run has finished and `runState` is still retained. */
    lastRun: BatchTerminalRunStatus | null;
};

/**
 * In-progress run branch of {@link BatchStatusResponse}. The `rows` slice is a
 * page (bounded by the status route's limit); `rowCount` is the TOTAL server
 * row count so the browser can reconcile absolute index across pages.
 */
export type BatchLiveRunStatus = {
    startedAt: number;
    total: number;
    completed: number;
    failed: number;
    currentSymbol: string | null;
    cancelled: boolean;
    interval: string;
    strategyKey: string;
    rows: BatchBacktestSymbolResult[];
    rowOffset: number;
    rowCount: number;
    nextOffset: number | null;
    runId: string;
    /** Terminal phase; `"running"` while the run owns the server. */
    phase: BatchStatusRunPhase;
    summary: string | null;
    tradeGateProvenance?: TradeGateProvenance | null;
    tradeGateStats?: TradeGateStats | null;
};

/**
 * Terminal run branch of {@link BatchStatusResponse}. Carries the terminal
 * summary / error plus the same row page + pagination contract as
 * {@link BatchLiveRunStatus} so a reloaded tab can recover the result table.
 */
export type BatchTerminalRunStatus = {
    interval: string;
    strategyKey: string;
    fingerprint: string | null;
    rowCount: number;
    hasArtifacts: boolean;
    cacheStats: BatchDatasetCacheStats | null;
    rows: BatchBacktestSymbolResult[];
    rowOffset: number;
    nextOffset: number | null;
    /** Terminal phase (`"done" | "cancelled" | "fatal"`). */
    phase: BatchStatusRunPhase;
    finishedAt: number | null;
    summary: string | null;
    error: string | null;
    startedAt: number;
    total: number;
    completed: number;
    failed: number;
    cancelled: boolean;
    runId: string;
    /** Producer-only diagnostic scalars; ignored by the reattach consumer. */
    artifactStats: { eligible: number; stored: number; failed: number; bytesWritten: number } | null;
    parsedCacheStats: { size: number; max: number; hits: number; misses: number; evictions: number; peak: number } | null;
    pairListProvenanceMeta: BatchRunPairListProvenanceMeta | null;
    universeCounts: BatchUniverseCounts | null;
    researchRegistrationMeta: { registration: MaxActiveResearchRegistrationV1 | null; status: "verified" | "manual/unverified"; reason?: string } | null;
    tradeGateProvenance: TradeGateProvenance | null;
    tradeGateStats: TradeGateStats | null;
};

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
        strategyComparisonPct: row.strategyComparisonPct,
        openTradeAssetScores: row.openTradeAssetScores ?? computeOpenTradeAssetScores([row]),
        error: row.error,
    };
}

