/**
 * Stream event contract for the Batch Backtest server-side plugin.
 *
 * The browser consumes these via `consumeNdjsonStream` (lib/ndjson-stream.ts),
 * which dispatches by mapping `event.type` to a camelCase handler key
 * (e.g. `symbol_failed` -> `onSymbolFailed`).
 *
 * CRITICAL CONTRACT: the `row` sent in `symbol` events must contain ONLY
 * scalars. The `data`, `signals`, and `result.trades` arrays stay in Node so
 * the browser tab's memory stays bounded regardless of pair count. The
 * browser reconstructs a `BatchBacktestSymbolResult` with those array fields
 * left `undefined`.
 *
 * Consequence: in server-side mode, the browser-side Copy summary renders
 * WITHOUT the B&H rows block (reads `row.data` via `computeBuyAndHoldPct`) and
 * WITHOUT the OPEN_SCORE line (reads `row.result.trades` via
 * `computeOpenTradeAssetScores`). Both helpers gracefully no-op on
 * `undefined`. This graceful degradation mirrors the post-Mine prune (commit
 * 6401a53) and is documented in `docs/batch-backtest-server-side.md`.
 */

import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

export type BatchStreamEvent =
    | { type: "start"; total: number; interval: string; strategyKey: string }
    | { type: "progress"; percent: number; text: string; status: string }
    | { type: "symbol"; index: number; total: number; row: BatchBacktestSymbolResult }
    | { type: "symbol_failed"; index: number; total: number; symbol: string; error: string }
    | {
        type: "done";
        ok: boolean;
        cancelled: boolean;
        interval: string;
        totals: { loadedSymbols: number; failedSymbols: number };
        summary: string;
        /** True when the server retains per-row artifacts (data/signals/trades) for Mine. */
        serverHasArtifacts: boolean;
        /** Fingerprint of the run settings; Mine must match it before starting. */
        fingerprint: string | null;
    }
    | { type: "fatal"; error: string };

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
        result: row.result ? { ...row.result, trades: [] } : undefined,
        // Intentionally omit `data` and `signals`.
        tradeSummary: row.tradeSummary,
        error: row.error,
    };
}

// ---------------------------------------------------------------------------
// Miner stream events
// ---------------------------------------------------------------------------

import type { BatchSyntheticAssetVerdict } from "./batch-synthetic-state-miner";

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
