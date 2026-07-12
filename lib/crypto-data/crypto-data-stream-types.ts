/**
 * Stream event + snapshot contract for the Crypto data sync plugin.
 *
 * Shared by the server plugin (`crypto-data-vite-plugin.ts`) and the browser
 * service (`crypto-data-service.ts`) so the NDJSON wire protocol and the
 * `GET /api/crypto/sync/status` reattach snapshot are declared in exactly one
 * place. This mirrors the established `lib/ibkr-data/ibkr-data-stream-types.ts`
 * leaf-module pattern: a type-only module imported by both sides, so a field
 * rename becomes a compile-time failure on both sides instead of a silent
 * reattach-polling drift (audit Finding 6 — the server previously emitted
 * events through `Record<string, unknown> & { type: string }` and the browser
 * declared its own copy of the union).
 *
 * The browser consumes these events via `consumeNdjsonStream`
 * (lib/ndjson-stream.ts), which dispatches by mapping `event.type` to a
 * camelCase handler key (e.g. `symbol_failed` -> `onSymbolFailed`).
 */

/**
 * A symbol/interval pair that the server successfully wrote to SQLite + CSV.
 * Used by the reattach path to invalidate exactly the caches the server
 * refreshed after a tab reload (audit Finding 1 — previously a reattached sync
 * reported only "finished" and never invalidated anything, so data loaded in
 * the new tab could remain stale while the server kept writing).
 */
export type CryptoCompletedTarget = {
    symbol: string;
    interval: string;
};

/**
 * Shape of the in-progress run snapshot returned by
 * `GET /api/crypto/sync/status`. The browser polls this to reattach to a sync
 * that started before page reload. The server populates every field; the
 * browser reads them as `CryptoSyncRunSnapshot`.
 */
export type CryptoSyncRunSnapshot = {
    startedAt: string;
    mode: "sync" | "download";
    /** Single interval, or the literal `"mixed"` when targets span more than one. */
    interval: string;
    marketType: string;
    total: number;
    /** Index of the next target to process. */
    index: number;
    /** Successful targets so far. */
    completed: number;
    failed: number;
    currentSymbol: string | null;
    currentInterval: string | null;
    failedSymbols: Array<{ symbol: string; error: string }>;
    cancelled: boolean;
    /**
     * Successfully-completed symbol/interval pairs so a reattached tab can
     * invalidate caches for exactly the targets the server wrote, grouped by
     * interval (audit Finding 1). Populated as the run progresses. Optional
     * because older servers did not emit it; the browser treats absence as
     * "no targeted invalidation" and falls back to its own streamed tally
     * when it owns the original request.
     */
    completedTargets?: CryptoCompletedTarget[];
    /** Wall-clock ISO of the last snapshot mutation; drives the reattach watchdog. */
    updatedAt?: string;
};

/**
 * NDJSON stream events emitted by the Crypto sync/download routes. The server
 * writes one `symbol` (or `symbol_failed`) event per item plus a terminal
 * `done` or `fatal`. Shape mirrors the IBKR stream union.
 */
export type CryptoStreamEvent =
    | { type: "start"; total: number; interval?: string; marketType?: string; mode?: string }
    | { type: "symbol"; index: number; total: number; symbol: string; interval: string; bars?: number; fetchedBars?: number; lastTime?: number | null }
    | { type: "symbol_failed"; index: number; total: number; symbol: string; interval: string; error: string }
    | { type: "done"; ok: boolean; cancelled?: boolean; interval?: string; marketType?: string; totals?: { bars: number; fetchedBars: number }; results?: unknown[]; failed?: unknown[] }
    | { type: "fatal"; error: string };
