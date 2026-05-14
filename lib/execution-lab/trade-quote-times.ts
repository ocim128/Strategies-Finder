import { parseTimeToUnixSeconds } from "../time-normalization";
import type { Trade } from "../types/strategies";

function finiteTradeTimeSeconds(time: Trade["entryTime"]): number | null {
    const seconds = parseTimeToUnixSeconds(time);
    return seconds === null || !Number.isFinite(seconds) ? null : Math.floor(seconds);
}

function isExecutableQuoteExit(reason: Trade["exitReason"]): boolean {
    return Boolean(reason) && reason !== "end_of_data" && reason !== "partial";
}

export function collectExecutionLabTradeQuoteTimes(args: {
    trades: readonly Trade[];
    previousProcessedCandleTimeSec: number | null;
    latestCandleTimeSec: number;
}): number[] {
    const afterTs = args.previousProcessedCandleTimeSec ?? -Infinity;
    const times = new Set<number>();
    for (const trade of args.trades) {
        const entryTimeSec = finiteTradeTimeSeconds(trade.entryTime);
        if (entryTimeSec !== null && entryTimeSec > afterTs && entryTimeSec <= args.latestCandleTimeSec) {
            times.add(entryTimeSec);
        }

        const exitTimeSec = finiteTradeTimeSeconds(trade.exitTime);
        if (
            isExecutableQuoteExit(trade.exitReason)
            && exitTimeSec !== null
            && exitTimeSec > afterTs
            && exitTimeSec <= args.latestCandleTimeSec
        ) {
            times.add(exitTimeSec);
        }
    }
    return Array.from(times).sort((left, right) => left - right);
}
