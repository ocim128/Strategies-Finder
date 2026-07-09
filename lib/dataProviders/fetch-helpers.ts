import { getIntervalSeconds } from "./utils";

export const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_STATUSES = new Set([418, 429, 500, 502, 503, 504]);

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

export function formatProviderError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
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

export async function fetchWithTimeoutAndRetry(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: {
        timeoutMs?: number;
        maxAttempts?: number;
        retryStatuses?: Iterable<number>;
        baseDelayMs?: number;
        signal?: AbortSignal;
    } = {}
): Promise<Response> {
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
                return response;
            }

            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            const backoffMs = retryAfterMs ?? baseDelayMs * attempt;
            await delayWithAbort(backoffMs, sourceSignal ?? undefined);
        } catch (error) {
            lastError = error;
            if (isAbortError(error) || attempt >= maxAttempts) {
                throw error;
            }
            await delayWithAbort(baseDelayMs * attempt, sourceSignal ?? undefined);
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
 * `{ ok: false, error: "..." }` shape used across the local API, alert
 * worker, and Execution Lab), falling back to `fallback` when the payload has
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
