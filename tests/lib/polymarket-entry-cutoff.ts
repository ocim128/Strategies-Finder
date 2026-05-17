export const DEFAULT_POLYMARKET_ENTRY_CUTOFF_SECONDS = 15;

export function clampPolymarketEntryCutoffSeconds(
    value: unknown,
    fallback = DEFAULT_POLYMARKET_ENTRY_CUTOFF_SECONDS
): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : fallback;
}

export function resolvePolymarketEntryCutoff(args: {
    entryTimeSec: number;
    eventEndTs: number;
    currentTimeSec?: number;
    enabled?: boolean;
    cutoffSeconds?: number;
}): { allowed: true } | { allowed: false; secondsToEventEnd: number } {
    if (args.enabled !== true) return { allowed: true };

    const cutoffSeconds = clampPolymarketEntryCutoffSeconds(args.cutoffSeconds);
    if (cutoffSeconds <= 0) return { allowed: true };

    const secondsFromEntryToClose = Math.floor(args.eventEndTs) - Math.floor(args.entryTimeSec);
    const secondsFromCurrentToClose = args.currentTimeSec === undefined
        ? secondsFromEntryToClose
        : Math.floor(args.eventEndTs) - Math.floor(args.currentTimeSec);
    const secondsToEventEnd = Math.min(secondsFromEntryToClose, secondsFromCurrentToClose);
    return secondsToEventEnd > cutoffSeconds
        ? { allowed: true }
        : { allowed: false, secondsToEventEnd };
}
