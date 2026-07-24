/**
 * Stream event + snapshot contract for the IBKR data sync plugin.
 *
 * Shared by the server plugin (`ibkr-data-vite-plugin.ts`) and the browser
 * service (`ibkr-data-service.ts`) so the NDJSON wire protocol and the
 * `GET /api/ibkr/sync/status` reattach snapshot are declared in exactly one
 * place. This mirrors the existing `lib/batch-backtest/batch-backtest-stream-types.ts`
 * leaf-module pattern: a type-only module imported by both sides, so a field
 * rename becomes a compile-time failure on both sides instead of a silent
 * reattach-polling drift.
 *
 * The browser consumes these events via `consumeNdjsonStream`
 * (lib/ndjson-stream.ts), which dispatches by mapping `event.type` to a
 * camelCase handler key (e.g. `symbol_failed` -> `onSymbolFailed`,
 * `symbol_warning` -> `onSymbolWarning`).
 */

/**
 * Per-interval catalog metadata. Extends the on-disk catalog shape with
 * optional `complete` / `stopReason` so a partial max backfill is not
 * reported as a complete dataset. Older catalog JSON on disk loads fine —
 * these fields are `undefined` until a re-sync writes them.
 */
export type IbkrIntervalMeta = {
    firstTime: string | null;
    lastTime: string | null;
    bars: number;
    lastSyncAt: string;
    /**
     * True only when the fetch covered the full requested window without
     * hitting the retry/chunk ceiling or being cancelled. Absent on catalog
     * entries written by older versions.
     */
    complete?: boolean;
    /**
     * Why the fetch stopped. Absent on entries written by older versions.
     * - `covered`: bounded period fully covered
     * - `no_more_data`: backward walk reached available history
     * - `retry_exhausted`: late retries failed after some bars landed
     * - `chunk_limit`: hit the max-chunk ceiling
     * - `cancelled`: aborted mid-fetch (Stop / newer sync)
     */
    stopReason?: "covered" | "no_more_data" | "retry_exhausted" | "chunk_limit" | "cancelled";
    /**
     * Which data source wrote this interval. Absent on catalog entries
     * written before Alpaca support landed — treated as `"ibkr"` for backward
     * compatibility, EXCEPT a same-source Alpaca sync requires `source ===
     * "alpaca"`; an absent source is treated as unknown and the Alpaca sync
     * handler rejects it (Alpaca Download must establish the source first).
     *
     * `"mixed"` is recorded when a Download merges bars from a different
     * source into an interval that already has bars from another source
     * (e.g. Alpaca Download onto an IBKR-sourced interval). It is an honest
     * label that the file now contains bars from multiple providers — the
     * user can decide whether to trust it. `"mixed"` intervals are NOT
     * eligible for Alpaca sync (the source guard still requires `"alpaca"`
     * for sync); re-running Alpaca Download on a `"mixed"` interval keeps it
     * `"mixed"`.
     */
    source?: "ibkr" | "alpaca" | "mixed";
};

/**
 * Shape of the in-progress run snapshot returned by
 * `GET /api/ibkr/sync/status`. The browser polls this to reattach to a sync
 * that started before page reload. The server populates every field; the
 * browser reads them as `IbkrSyncRunSnapshot`.
 */
export type IbkrSyncRunSnapshot = {
    startedAt: string;
    mode: "sync" | "download";
    interval: string;
    period: string | null;
    /**
     * Data source for this run. Absent on snapshots written before Alpaca
     * support landed — treated as `"ibkr"` for backward compatibility during
     * reattach, so a pre-Alpaca in-flight run still renders as IBKR.
     */
    source?: "ibkr" | "alpaca";
    total: number;
    /** Index of the next symbol to process. */
    index: number;
    /** Successful symbols so far. */
    completed: number;
    failed: number;
    currentSymbol: string | null;
    failedSymbols: Array<{ symbol: string; error: string }>;
    cancelled: boolean;
    /**
     * Successfully-completed symbol keys (marked form) so a reattached tab can
     * invalidate caches for exactly the symbols the server wrote, even if the
     * NDJSON stream was lost. Populated as the run progresses.
     */
    completedSymbols?: string[];
    /** Wall-clock ISO of the last snapshot mutation; drives the reattach watchdog. */
    updatedAt?: string;
};

/**
 * NDJSON stream events emitted by the IBKR sync/resolve/download routes. The
 * server writes one `symbol` (or `symbol_failed` / `symbol_warning`) event
 * per item plus a terminal `done` or `fatal`.
 */
export type IbkrStreamEvent =
    | { type: "start"; total: number; interval?: string; mode?: string; source?: "ibkr" | "alpaca"; period?: string | null }
    | { type: "symbol"; index: number; total: number; symbol: string; markedSymbol?: string; bars?: number; fetchedBars?: number }
    | { type: "symbol_failed"; index: number; total: number; symbol: string; error: string }
    | { type: "symbol_warning"; index: number; total: number; symbol: string; reason: string; complete: false }
    | { type: "done"; ok: boolean; cancelled?: boolean; interval?: string; source?: "ibkr" | "alpaca"; totals?: { bars: number; fetchedBars: number }; results?: unknown[]; failed?: unknown[] }
    | { type: "fatal"; error: string };
