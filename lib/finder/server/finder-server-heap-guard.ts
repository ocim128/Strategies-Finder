/**
 * Heap-budget guard for the server-side Finder Symbol Universe plugin.
 * Mirrors `resolveServerBatchHeapWarning` in
 * `lib/batch-backtest/batch-backtest-vite-plugin.ts`: reject a universe run
 * up front when the V8 heap limit is too low for the requested symbol count,
 * so a user gets a clear actionable message instead of an OOM mid-run.
 *
 * The Finder universe retains N full OHLCV datasets (~5–10 MB each at the 100k
 * cap) for the whole evaluation loop (the dominant retention, per AGENTS.md
 * §"Memory budget"). The thresholds are conservative because the server also
 * holds prepared closed-candle data per symbol plus the candidate survivor
 * set; they match the Batch plugin's floor so a user who already runs Batch
 * server-side at the same heap has a consistent experience.
 */

import { getHeapStatistics } from "node:v8";

const HEAP_MB = 1024 * 1024;

const LARGE_UNIVERSE_SYMBOL_THRESHOLD = 400;
const VERY_LARGE_UNIVERSE_SYMBOL_THRESHOLD = 800;
const LARGE_UNIVERSE_MIN_HEAP_MB = 8192;
const VERY_LARGE_UNIVERSE_MIN_HEAP_MB = 12288;

function getV8HeapLimitMb(): number {
    return Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB);
}

/**
 * Returns a human-readable warning string when the universe run is too large
 * for the current Node heap, or `null` when the run is safe to start. Pure:
 * the heap limit is injected so the function is unit-testable without monkey-
 * patching v8.
 */
export function resolveFinderUniverseHeapWarning(
    symbolCount: number,
    heapLimitMb: number = getV8HeapLimitMb(),
): string | null {
    const normalizedCount = Math.max(0, Math.floor(Number.isFinite(symbolCount) ? symbolCount : 0));
    const normalizedHeap = Math.max(0, Math.floor(Number.isFinite(heapLimitMb) ? heapLimitMb : 0));
    const requiredHeapMb = normalizedCount >= VERY_LARGE_UNIVERSE_SYMBOL_THRESHOLD
        ? VERY_LARGE_UNIVERSE_MIN_HEAP_MB
        : normalizedCount >= LARGE_UNIVERSE_SYMBOL_THRESHOLD
            ? LARGE_UNIVERSE_MIN_HEAP_MB
            : 0;

    if (requiredHeapMb === 0 || normalizedHeap >= requiredHeapMb) {
        return null;
    }

    return [
        `Server-side Finder Universe needs more Node heap for ${normalizedCount} symbols.`,
        `Current V8 heap limit is ~${normalizedHeap} MB; this run needs at least ${requiredHeapMb} MB.`,
        "Restart with run_playground.bat, or run: set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev",
    ].join(" ");
}
