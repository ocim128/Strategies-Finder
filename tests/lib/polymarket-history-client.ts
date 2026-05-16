export interface PolymarketHistoryPoint {
    t: number;
    p: number;
}

export interface PolymarketHistoryResponse {
    history?: Array<{ t?: unknown; p?: unknown }>;
}

export interface PolymarketHistoryFetchOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function resolveFetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (signal && typeof AbortSignal.any === "function") {
        return AbortSignal.any([signal, timeoutSignal]);
    }
    return signal ?? timeoutSignal;
}

function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

export function normalizePolymarketHistoryPoints(
    response: PolymarketHistoryResponse | null
): PolymarketHistoryPoint[] {
    const rows = Array.isArray(response?.history) ? response.history : [];
    const dedup = new Map<number, number>();

    for (const row of rows) {
        const t = Math.floor(Number(row?.t));
        const p = Number(row?.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }

    return Array.from(dedup.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([t, p]) => ({ t, p }));
}

export async function fetchPolymarketHistoryWithFallback(
    urls: readonly string[],
    options: PolymarketHistoryFetchOptions = {}
): Promise<PolymarketHistoryResponse> {
    const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
    const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    let lastError: unknown = null;

    for (const url of urls) {
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const response = await fetch(url, {
                    headers: { Accept: "application/json" },
                    signal: resolveFetchSignal(options.signal, timeoutMs),
                });
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status} for ${url}`);
                    if (!isRetryableStatus(response.status) || attempt === retries) {
                        throw error;
                    }
                    lastError = error;
                    await sleep((attempt + 1) * retryDelayMs);
                    continue;
                }
                return await response.json() as PolymarketHistoryResponse;
            } catch (error) {
                if (isAbortLikeError(error) && options.signal?.aborted) {
                    throw error;
                }
                lastError = error;
                if (isAbortLikeError(error)) {
                    break;
                }
                if (attempt === retries) {
                    break;
                }
                await sleep((attempt + 1) * retryDelayMs);
            }
        }
    }

    throw lastError ?? new Error("Failed to load Polymarket history.");
}
