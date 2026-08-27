import { getHeapStatistics } from "node:v8";

const HEAP_MB = 1024 * 1024;
const LARGE_SYMBOL_THRESHOLD = 400;
const VERY_LARGE_SYMBOL_THRESHOLD = 800;
const LARGE_MIN_HEAP_MB = 8192;
const VERY_LARGE_MIN_HEAP_MB = 12288;

export function getV8HeapLimitMb(): number {
    return Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB);
}

/** Return an actionable warning when a server run exceeds the safe heap floor. */
export function resolveServerHeapWarning(
    symbolCount: number,
    heapLimitMb: number = getV8HeapLimitMb(),
    scopeLabel: string,
    restartInstruction: string,
): string | null {
    const normalizedCount = Math.max(0, Math.floor(Number.isFinite(symbolCount) ? symbolCount : 0));
    const normalizedHeap = Math.max(0, Math.floor(Number.isFinite(heapLimitMb) ? heapLimitMb : 0));
    const requiredHeapMb = normalizedCount >= VERY_LARGE_SYMBOL_THRESHOLD
        ? VERY_LARGE_MIN_HEAP_MB
        : normalizedCount >= LARGE_SYMBOL_THRESHOLD
            ? LARGE_MIN_HEAP_MB
            : 0;

    if (requiredHeapMb === 0 || normalizedHeap >= requiredHeapMb) {
        return null;
    }

    return [
        `Server-side ${scopeLabel} needs more Node heap for ${normalizedCount} symbols.`,
        `Current V8 heap limit is ~${normalizedHeap} MB; this run needs at least ${requiredHeapMb} MB.`,
        restartInstruction,
    ].join(" ");
}
