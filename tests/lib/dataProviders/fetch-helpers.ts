import { getIntervalSeconds } from "./utils";

export const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 15_000;

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
