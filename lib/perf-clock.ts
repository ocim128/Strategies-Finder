/**
 * Clock for duration measurements: the high-resolution `performance` clock
 * when the runtime provides one, `Date.now()` otherwise. Values are only
 * meaningful as `end - start` durations; the two sources are not comparable
 * as absolute timestamps.
 */
export function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
