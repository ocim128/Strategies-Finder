import { formatError } from "../error-format";
import { getIntervalSeconds } from "./utils";

export const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_STATUSES = new Set([418, 429, 500, 502, 503, 504]);

/**
 * Retry pacing policy shared by every provider retry path.
 *
 * Two properties matter for this codebase and are easy to get wrong:
 *
 * 1. **Ceiling.** `Retry-After` is server-controlled. An upstream that answers
 *    `Retry-After: 3600` must not silently park a Finder/Batch arm for an hour
 *    with no log; the wait is clamped to {@link MAX_RETRY_WAIT_MS}.
 * 2. **Jitter.** Several workers (Finder arms, Batch pools, crypto sync,
 *    IBKR/Alpaca symbol dispatch) hit the same provider concurrently. A fixed
 *    `base * attempt` schedule makes every one of them retry in the same
 *    millisecond, reproducing the collision that caused the 429. Full jitter
 *    (`random in [0, ceiling)`) spreads them out.
 *
 * Exponential growth replaces the previous linear schedule so a burst-limited
 * provider recovers instead of being hammered at a constant cadence.
 */
export const MAX_RETRY_WAIT_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 6;

/** Upper bound for one retry wait, honoring a clamped `Retry-After`. */
export function resolveRetryWaitMs(args: {
    attempt: number;
    baseDelayMs: number;
    retryAfterMs?: number | null;
    random?: () => number;
}): number {
    const random = args.random ?? Math.random;
    const attempt = Math.max(1, Math.floor(args.attempt));
    const retryAfterMs = Number.isFinite(args.retryAfterMs) ? Math.max(0, args.retryAfterMs as number) : null;
    if (retryAfterMs !== null && retryAfterMs > 0) {
        // Respect the upstream hint, but never beyond the policy ceiling, and
        // still jitter so concurrent workers do not resume in lockstep.
        const ceiling = Math.min(retryAfterMs, MAX_RETRY_WAIT_MS);
        return Math.max(0, Math.floor(ceiling * (0.5 + random() * 0.5)));
    }
    const baseDelayMs = Math.max(0, Math.floor(args.baseDelayMs));
    const exponential = baseDelayMs * 2 ** Math.min(attempt - 1, MAX_BACKOFF_EXPONENT);
    const ceiling = Math.min(exponential, MAX_RETRY_WAIT_MS);
    // Spread the herd within the upper half of the window instead of the whole
    // window: a draw near zero would retry a 429'd provider immediately, which
    // is exactly the burst the jitter exists to avoid.
    return Math.max(0, Math.floor(ceiling / 2 + (random() * ceiling) / 2));
}

/**
 * One structured line per retry decision.
 *
 * Deliberately import-free: this module is reachable from the Vite config
 * bundle through `vite-http-utils`, so pulling `debug-logger` in here would
 * re-introduce the browser/Vite-runtime assumptions that utility avoids.
 * Logging must never throw into a provider retry path.
 */
function logProviderRetry(data: Record<string, unknown>): void {
    try {
        console.info(JSON.stringify({ event: "provider.retry", ...data }));
    } catch {
        // Logging is best effort.
    }
}

export function findBestDivisibleInterval(
    targetSeconds: number,
    candidates: Iterable<string>
): string | null {
    let bestInterval: string | null = null;
    let bestSeconds = 0;

    for (const candidate of candidates) {
        const seconds = getIntervalSeconds(candidate);
        if (!Number.isFinite(seconds) || seconds <= 0) continue;
        if (seconds > targetSeconds) continue;
        if (targetSeconds % seconds !== 0) continue;
        if (seconds > bestSeconds) {
            bestSeconds = seconds;
            bestInterval = candidate;
        }
    }

    return bestInterval;
}

export function resolveRawFetchLimit(
    targetBars: number,
    targetInterval: string,
    sourceInterval: string,
    needsResample: boolean
): { rawLimit: number; ratio: number } {
    if (!needsResample) {
        return { rawLimit: targetBars, ratio: 1 };
    }

    const targetSeconds = getIntervalSeconds(targetInterval);
    const sourceSeconds = getIntervalSeconds(sourceInterval);
    const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
        ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
        : 1;

    return { rawLimit: Math.max(targetBars, Math.ceil(targetBars * ratio)), ratio };
}

export function isAbortError(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
        return error.name === 'AbortError' || error.name === 'TimeoutError';
    }
    if (error === null || typeof error !== 'object') {
        return false;
    }
    const name = (error as { name?: string }).name;
    return name === 'AbortError' || name === 'TimeoutError';
}

export function isTimeoutError(error: unknown): boolean {
    return error !== null && typeof error === 'object'
        && (error as { name?: string }).name === 'TimeoutError';
}

export function formatProviderError(error: unknown): string {
    return formatError(error);
}

function parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.floor(seconds * 1000);
    }
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) return null;
    return Math.max(0, dateMs - Date.now());
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error('Aborted'));
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timeout);
            reject((signal as AbortSignal & { reason?: unknown } | undefined)?.reason ?? new Error('Aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

function createTimeoutAbortReason(): unknown {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Provider request timed out', 'TimeoutError');
    }
    const error = new Error('Provider request timed out');
    error.name = 'TimeoutError';
    return error;
}

export function createFetchTimeoutSignal(
    parentSignal?: AbortSignal,
    timeoutMs: number = DEFAULT_PROVIDER_FETCH_TIMEOUT_MS
): { signal?: AbortSignal; cleanup: () => void } {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController === 'undefined') {
        return { signal: parentSignal, cleanup: () => {} };
    }
    if (parentSignal?.aborted) {
        return { signal: parentSignal, cleanup: () => {} };
    }

    const controller = new AbortController();
    const abortFromParent = () => {
        const reason = (parentSignal as AbortSignal & { reason?: unknown } | undefined)?.reason;
        if (reason === undefined) {
            controller.abort();
        } else {
            controller.abort(reason);
        }
    };
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    const timeout = setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort(createTimeoutAbortReason());
        }
    }, timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', abortFromParent);
        },
    };
}

export type FetchRetryOptions = {
    timeoutMs?: number;
    maxAttempts?: number;
    retryStatuses?: Iterable<number>;
    baseDelayMs?: number;
    signal?: AbortSignal;
};

export function fetchWithTimeoutAndRetry(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: FetchRetryOptions = {}
): Promise<Response> {
    return fetchAndConsumeWithTimeoutAndRetry(input, init, async response => response, options);
}

/** Keep both the deadline and caller cancellation active until the body is consumed. */
export async function fetchAndConsumeWithTimeoutAndRetry<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    options: FetchRetryOptions = {}
): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
    const retryStatuses = new Set(options.retryStatuses ?? DEFAULT_RETRY_STATUSES);
    const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 250));
    const sourceSignal = options.signal ?? init.signal;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const timeout = createFetchTimeoutSignal(sourceSignal ?? undefined, options.timeoutMs);
        try {
            const response = await fetch(input, {
                ...init,
                signal: timeout.signal,
            });
            if (!retryStatuses.has(response.status) || attempt >= maxAttempts) {
                return await consume(response);
            }

            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            await response.body?.cancel();
            const backoffMs = resolveRetryWaitMs({ attempt, baseDelayMs, retryAfterMs });
            logProviderRetry({
                url: typeof input === "string" ? input : String((input as Request).url ?? input),
                status: response.status,
                attempt,
                maxAttempts,
                retryAfterMs,
                backoffMs,
                cappedRetryAfter: retryAfterMs !== null && retryAfterMs > MAX_RETRY_WAIT_MS,
            });
            await delayWithAbort(backoffMs, sourceSignal ?? undefined);
        } catch (error) {
            const timeoutReason: unknown = timeout.signal?.reason;
            const timedOut = isTimeoutError(error) || isTimeoutError(timeoutReason);
            // Some fetch implementations report AbortError for our deadline.
            // Preserve TimeoutError so provider failover can distinguish it.
            const failure = isTimeoutError(timeoutReason) ? timeoutReason : error;
            lastError = failure;
            if (sourceSignal?.aborted || (isAbortError(error) && !timedOut) || attempt >= maxAttempts) {
                throw sourceSignal?.aborted ? error : failure;
            }
            const backoffMs = resolveRetryWaitMs({ attempt, baseDelayMs });
            logProviderRetry({
                url: typeof input === "string" ? input : String((input as Request).url ?? input),
                attempt,
                maxAttempts,
                backoffMs,
                error: failure instanceof Error ? failure.message : String(failure),
            });
            await delayWithAbort(backoffMs, sourceSignal ?? undefined);
        } finally {
            timeout.cleanup();
        }
    }

    throw lastError ?? new Error('Fetch failed');
}

/**
 * Reads a response body as JSON if the content-type advertises it (or if the
 * text body parses as JSON), otherwise as raw text. Returns `{ json, text }`
 * where exactly one is non-null on success (text is also returned alongside a
 * JSON parse from a non-JSON content-type so callers can use it as a fallback
 * message). Browser- and Node-safe.
 *
 * Consolidates the per-module `readApiBody`/body-sniffing logic that was
 * duplicated across alert-service, execution-lab, local-api-transport, and
 * provider helpers. The shape matches alert-service's `readApiBody` exactly so
 * it is a drop-in for the largest existing caller.
 */
export async function readJsonOrText(response: Response): Promise<{ json: unknown | null; text: string | null }> {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.includes('application/json')) {
        try {
            return { json: await response.json(), text: null };
        } catch {
            return { json: null, text: null };
        }
    }

    try {
        const text = await response.text();
        if (!text.trim()) return { json: null, text: null };
        try {
            return { json: JSON.parse(text), text };
        } catch {
            return { json: null, text };
        }
    } catch {
        return { json: null, text: null };
    }
}

/**
 * Extracts a trimmed `.error` string from a parsed API error payload (the
 * `{ ok: false, error: "..." }` shape used across the local API and the
 * alert worker), falling back to `fallback` when the payload has
 * no usable error string. Returns `null` only when both the payload and the
 * fallback are empty, so callers can chain their own fallback (e.g. an HTTP
 * status line).
 */
export function extractApiError(payload: unknown, fallback: string | null = null): string | null {
    if (payload && typeof payload === 'object') {
        const message = (payload as Record<string, unknown>).error;
        if (typeof message === 'string' && message.trim()) {
            return message.trim();
        }
    }
    return fallback;
}
