/**
 * Heap-budget guard for the server-side Finder Symbol Universe plugin.
 * Rejects a universe run up front when the V8 heap limit is too low for the
 * requested symbol count, so a user gets a clear actionable message instead
 * of an OOM mid-run.
 *
 * The Finder universe retains N full OHLCV datasets (~5–10 MB each at the 100k
 * cap) for the whole evaluation loop (the dominant retention, per AGENTS.md
 * §"Memory budget"). The thresholds are conservative because the server also
 * holds prepared closed-candle data per symbol plus the candidate survivor
 * set; they match the Batch plugin's floor so a user who already runs Batch
 * server-side at the same heap has a consistent experience.
 */

import { getV8HeapLimitMb, resolveServerHeapWarning } from "../../server-heap-guard";

/**
 * Returns a human-readable warning string when the run is too large for the
 * current Node heap, or `null` when the run is safe to start. Pure: the heap
 * limit is injected so the function is unit-testable without monkey-patching
 * v8. `scopeLabel` names the job kind in the message (Asset Opportunity
 * reuses the Universe thresholds; only the wording differs).
 */
export function resolveFinderUniverseHeapWarning(
    symbolCount: number,
    heapLimitMb: number = getV8HeapLimitMb(),
    scopeLabel: string = "Finder Universe",
): string | null {
    return resolveServerHeapWarning(
        symbolCount,
        heapLimitMb,
        scopeLabel,
        "Restart with run_playground.bat, or run: set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev",
    );
}
