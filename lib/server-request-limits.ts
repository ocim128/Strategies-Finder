/**
 * Shared server-side request validation for the Finder and Batch Vite plugins.
 *
 * Both plugins previously inherited the generic 80 MB JSON-body limit and cast
 * control fields without upper clamps, so a typed/persisted/direct-API value
 * could request a 1000× workload or a multi-hour run. These helpers enforce the
 * SAME limits the UI declares (`topN` 1..100, `maxRuns` 1..1000) and a much
 * smaller body cap appropriate for control payloads (normally measured in KB).
 *
 * Leaf module: safe for both plugins to import (no browser-bound deps).
 */

/**
 * Body cap for Finder/Batch control requests. The payloads are symbols lists +
 * options + settings (KB-scale). The generic 80 MB limit is intended for
 * candle-upload routes; control routes do not need it, and a smaller cap turns
 * an oversized request into an actionable 413 instead of a late allocation.
 */
export const FINDER_BATCH_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB

/** UI-declared Finder limits (see `html-partials/tab-finder.html`). */
export const FINDER_TOP_N_MIN = 1;
export const FINDER_TOP_N_MAX = 100;
export const FINDER_MAX_RUNS_MIN = 1;
export const FINDER_MAX_RUNS_MAX = 1000;

/**
 * Clamp a finite numeric option to `[min, max]`. Returns `min` for non-finite
 * or non-number input (defensive — the browser serializes the FinderOptions
 * object and a corrupted persistence blob could land NaN/Infinity here). The
 * clamp is silent so a stale persisted value can't hard-fail a run; the
 * UI-declared range is still enforced.
 */
export function clampFiniteNumber(
    value: unknown,
    min: number,
    max: number,
): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

/**
 * Validate and clamp Finder `options.topN` and `options.maxRuns` to the
 * UI-declared range. Mutates a clone of the options object so the caller's
 * object is not changed. Throws 400 if `options` is not an object.
 */
export function clampFinderOptions<T extends { topN?: unknown; maxRuns?: unknown }>(
    options: T,
): T {
    const clamped = { ...options };
    clamped.topN = clampFiniteNumber(clamped.topN, FINDER_TOP_N_MIN, FINDER_TOP_N_MAX);
    clamped.maxRuns = clampFiniteNumber(clamped.maxRuns, FINDER_MAX_RUNS_MIN, FINDER_MAX_RUNS_MAX);
    return clamped;
}
