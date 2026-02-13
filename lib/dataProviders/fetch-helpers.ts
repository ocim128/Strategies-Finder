import { getIntervalSeconds } from "./utils";

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
    if (error instanceof DOMException) {
        return error.name === 'AbortError';
    }
    return (error as { name?: string }).name === 'AbortError';
}

export function formatProviderError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
