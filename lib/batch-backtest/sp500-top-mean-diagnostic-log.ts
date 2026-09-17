/**
 * Durable TOP_MEAN diagnostic log (browser localStorage).
 *
 * The in-memory diagnostic ring (`BatchBacktestService.topMeanDiagnosticEntries`)
 * dies with the tab — exactly when it is needed most, because the failure mode
 * under investigation is a tab-killing OOM. This leaf persists the ring so a
 * reload (or a crash + reopen) can restore the log and Copy Diagnostic still
 * hands over the evidence: the event timeline, each NDJSON event's approximate
 * byte size, and (Chrome) a JS-heap sample per entry.
 *
 * One size rule everywhere: payloads are compacted at RECORD time
 * (`compactTopMeanDiagnosticData`) — small payloads pass through verbatim,
 * oversized ones become a shape summary (array lengths, string lengths,
 * previews). The ring, the copied diagnostic, and the persisted log therefore
 * all stay small; full payloads remain available through Copy Result /
 * Copy OPEN_SCORE / the details panel.
 *
 * Budgets: localStorage is typically ~5 MB per origin. Per-entry data is
 * capped and the whole persisted log is capped by dropping the oldest half
 * until it fits.
 *
 * Leaf-safe: imports only the persisted-json helper. No DOM, no service state.
 */
import { readPersistedJson, writePersistedJson } from "../persisted-json";

export interface TopMeanDiagnosticHeapSample {
    usedJsHeapSize: number;
    jsHeapSizeLimit: number;
}

export interface TopMeanDiagnosticEntry {
    at: string;
    type: string;
    data?: unknown;
    /** Approximate JSON character length of the NDJSON event, at receipt. */
    bytes?: number;
    /** Chrome-only JS heap sample at record time (OOM evidence). */
    heap?: TopMeanDiagnosticHeapSample;
}

const TOP_MEAN_DIAGNOSTIC_LOG_STORAGE = {
    key: "playground_sp500_top_mean_diagnostic_log",
    schema: "sp500_top_mean.diagnostic_log",
    version: 1,
} as const;

/** Total persisted-log budget (well under the ~5 MB localStorage quota). */
const TOP_MEAN_DIAGNOSTIC_PERSIST_MAX_BYTES = 1_500_000;
/** Per-entry `data` budget before the shape-summary truncation kicks in. */
const TOP_MEAN_DIAGNOSTIC_ENTRY_DATA_MAX_BYTES = 16_000;

/** Chrome-only `performance.memory` sample; undefined elsewhere. */
export function sampleTopMeanHeap(): TopMeanDiagnosticHeapSample | undefined {
    const memory = (performance as { memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } }).memory;
    const used = memory?.usedJSHeapSize;
    const limit = memory?.jsHeapSizeLimit;
    if (typeof used !== "number" || !Number.isFinite(used)
        || typeof limit !== "number" || !Number.isFinite(limit)) {
        return undefined;
    }
    return { usedJsHeapSize: used, jsHeapSizeLimit: limit };
}

/** Approximate JSON length in characters; undefined when not serializable. */
export function approxJsonByteLength(value: unknown): number | undefined {
    try {
        const text = JSON.stringify(value);
        return typeof text === "string" ? text.length : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Replaces an oversized payload with the shape evidence worth keeping.
 * Two levels deep, so a wire event like `{type, result: {runId, openScoreEventDetails…}}`
 * still surfaces the run id and the critical array lengths.
 */
function summarizeForPersist(data: unknown): unknown {
    const shape = data !== null && typeof data === "object"
        ? shapeOf(data, 2) as Record<string, unknown>
        : {};
    return { diagnosticDataTruncated: true, ...shape };
}

function shapeOf(value: unknown, depth: number): unknown {
    if (Array.isArray(value)) {
        const out: Record<string, unknown> = { arrayLength: value.length };
        if (depth > 0 && value.length > 0) out.firstItem = shapeOf(value[0], depth - 1);
        return out;
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== null && typeof v === "object") out[key] = depth > 0 ? shapeOf(v, depth - 1) : { object: true };
            else if (typeof v === "string" && v.length > 200) out[key] = { stringLength: v.length, preview: v.slice(0, 200) };
            else out[key] = v;
        }
        return out;
    }
    if (typeof value === "string" && value.length > 200) {
        return { stringLength: value.length, preview: value.slice(0, 200) };
    }
    return value;
}

export interface TopMeanDiagnosticLogSnapshot {
    runId: string | null;
    savedAt: string;
    entries: TopMeanDiagnosticEntry[];
}

/**
 * Compact an entry payload for DIAGNOSTIC purposes: small payloads pass
 * through verbatim; oversized ones become a shape summary. This is applied at
 * RECORD time so the in-memory ring never retains multi-MB payload
 * duplicates (a terminal reattach poll carries the whole wire-safe result —
 * retaining one per poll both bloated the copied diagnostic to millions of
 * lines and added real memory pressure in exactly the OOM scenario the
 * diagnostic exists to debug). Full payloads remain available through Copy
 * Result / Copy OPEN_SCORE / the details panel — the diagnostic only needs
 * the timeline, sizes, and shapes.
 */
export function compactTopMeanDiagnosticData(
    data: unknown,
    maxBytes = TOP_MEAN_DIAGNOSTIC_ENTRY_DATA_MAX_BYTES,
): unknown {
    if (data === undefined) return undefined;
    const size = approxJsonByteLength(data);
    if (size === undefined || size <= maxBytes) return data;
    return summarizeForPersist(data);
}

/**
 * Persist the diagnostic ring snapshot. Bounds per-entry data and the total
 * size; never mutates the input entries. The snapshot replaces the previous
 * log wholesale (the caller owns eviction semantics via its ring). Entries
 * are already compacted at record time; the per-entry guard here is
 * defense-in-depth for callers that bypass the record path.
 */
export function writeTopMeanDiagnosticLogSnapshot(
    runId: string | null,
    entries: readonly TopMeanDiagnosticEntry[],
    onError?: (error: unknown) => void,
): void {
    const bounded = entries.map((entry) => ({
        ...entry,
        data: entry.data === undefined ? undefined : compactTopMeanDiagnosticData(entry.data),
    }));
    let snapshot: TopMeanDiagnosticLogSnapshot = {
        runId,
        savedAt: new Date().toISOString(),
        entries: bounded,
    };
    for (;;) {
        const size = approxJsonByteLength(snapshot);
        if (size === undefined || size <= TOP_MEAN_DIAGNOSTIC_PERSIST_MAX_BYTES) break;
        if (snapshot.entries.length <= 1) break;
        // Drop the oldest half; the recent timeline is the OOM evidence.
        snapshot = {
            ...snapshot,
            entries: snapshot.entries.slice(Math.ceil(snapshot.entries.length / 2)),
        };
    }
    writePersistedJson({
        ...TOP_MEAN_DIAGNOSTIC_LOG_STORAGE,
        data: snapshot,
        onError,
    });
}

/** Validated read of the persisted log; null when absent or malformed. */
export function readTopMeanDiagnosticLogSnapshot(): TopMeanDiagnosticLogSnapshot | null {
    return readPersistedJson<TopMeanDiagnosticLogSnapshot | null>({
        ...TOP_MEAN_DIAGNOSTIC_LOG_STORAGE,
        fallback: null,
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const source = data as Partial<TopMeanDiagnosticLogSnapshot> & { entries?: unknown };
            if (!Array.isArray(source.entries)) return null;
            const entries = (source.entries as unknown[]).filter(
                (entry): entry is TopMeanDiagnosticEntry =>
                    !!entry && typeof entry === "object"
                    && typeof (entry as TopMeanDiagnosticEntry).at === "string"
                    && typeof (entry as TopMeanDiagnosticEntry).type === "string",
            );
            return {
                runId: typeof source.runId === "string" ? source.runId : null,
                savedAt: typeof source.savedAt === "string" ? source.savedAt : "",
                entries,
            };
        },
        onError: (error) => console.warn("sp500_top_mean.diagnostic_log_restore_failed", error),
    });
}

/** Remove the persisted log (called when a NEW run starts a fresh log). */
export function clearTopMeanDiagnosticLog(onError?: (error: unknown) => void): void {
    writePersistedJson({
        ...TOP_MEAN_DIAGNOSTIC_LOG_STORAGE,
        data: null,
        onError,
    });
}
