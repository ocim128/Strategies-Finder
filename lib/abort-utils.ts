/**
 * Shared abort helpers for the finder and Monte Carlo cancellation paths.
 *
 * {@link isAbortError} is the *narrow* check: it requires a real `Error` whose
 * name is exactly `"AbortError"`. It is deliberately stricter than the
 * fetch-layer `dataProviders/fetch-helpers.isAbortError`, which also treats
 * `TimeoutError` (and DOMException-shaped objects) as aborts. Callers here must
 * not swallow a genuine timeout as a user cancellation, so the two are kept
 * separate on purpose — do not merge them.
 */

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

export function throwAbortError(): never {
    const error = new Error("Asset Opportunity cancelled");
    error.name = "AbortError";
    throw error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throwAbortError();
}
