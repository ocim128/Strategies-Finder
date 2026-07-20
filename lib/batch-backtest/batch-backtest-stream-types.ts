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
        /** True when the server retains per-row artifacts (data/signals/trades) for Mine/Stability Mine. */
        serverHasArtifacts: boolean;
        /** Fingerprint of the run settings; Mine must match it before starting. */
        fingerprint: string | null;
        /** Server-side loader cache counters captured at run completion. */
        cacheStats?: BatchDatasetCacheStats;
        /** Browser-generated run id (audit Finding 5). Optional for backward
         *  compat with stale browser bundles that predate the runId contract;
         *  the server still scopes Stop by runId once the browser sends one. */
        runId?: string;
        /**
         * Audit artifact-stats finding: partial-write outcomes. Present so the
         * browser can surface "artifacts X/Y; Mine will omit Z failed writes"
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
 * arrays stay server-side for Mine Timing.
 */
export function toScalarRow(row: BatchBacktestSymbolResult): BatchBacktestSymbolResult {
    return {
        symbol: row.symbol,
        status: row.status,
        barCount: row.barCount,
        firstTime: row.firstTime,
        lastTime: row.lastTime,
        // `result` carries a `trades` array internally; that array can be large
        // for high-trade-count pairs, so drop the whole result trades slice.
        // Keep the scalar metrics so the verdict / Copy summary still render.
        result: row.result ? { ...row.result, trades: [], equityCurve: [] } : undefined,
        // Intentionally omit `data` and `signals`; keep only derived scalars
        // needed by Copy Results.
        tradeSummary: row.tradeSummary,
        buyHoldPct: row.buyHoldPct ?? computeBuyAndHoldPct(row.data),
        openTradeAssetScores: row.openTradeAssetScores ?? computeOpenTradeAssetScores([row]),
        error: row.error,
    };
}

// ---------------------------------------------------------------------------
// Miner stream events
// ---------------------------------------------------------------------------

import type { BatchSyntheticAssetVerdict } from "./batch-synthetic-state-miner";
import type { BatchStabilityMineResult } from "./batch-stability-mine";

export type BatchMinerStreamEvent =
    | { type: "start"; assets: number; pairs: number }
    | { type: "verdict"; verdict: BatchSyntheticAssetVerdict }
    | {
        type: "done";
        ok: boolean;
        cancelled: boolean;
        summary: string;
        totals: { verdicts: number };
      }
    | { type: "fatal"; error: string };

/**
 * Stream event contract for the Stability Mine server-side plugin
 * (`POST /api/batch-backtest/stability-mine`). Distinct from
 * {@link BatchMinerStreamEvent} because Stability Mine streams `progress`
 * (per-rerun hits) and a `done` carrying the full
 * {@link BatchStabilityMineResult} — no `start` / `verdict` events. The
 * consumer (`BatchBacktestService.runStabilityMineServer`) reads it via
 * `consumeNdjsonStream<BatchStabilityMineStreamEvent>`. Dispatch in
 * `consumeNdjsonStream` is by `event.type` → camelCase handler key and is
 * non-exhaustive, so this union exists for compiler coverage at the consumer,
 * not for runtime enforcement.
 */
export type BatchStabilityMineStreamEvent =
    | { type: "progress"; run: number; reruns: number; hits: number }
    | { type: "done"; ok: true; result: BatchStabilityMineResult }
    | { type: "done"; ok: false; cancelled: true; summary: string }
    | { type: "fatal"; error: string };


