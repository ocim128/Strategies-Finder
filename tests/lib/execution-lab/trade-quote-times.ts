import { parseTimeToUnixSeconds } from "../time-normalization";
import type { BacktestSettings, Trade } from "../types/strategies";

function finiteTradeTimeSeconds(time: Trade["entryTime"]): number | null {
    const seconds = parseTimeToUnixSeconds(time);
    return seconds === null || !Number.isFinite(seconds) ? null : seconds;
}

function closeExecutionTimestampShiftSec(backtestSettings: Pick<BacktestSettings, "executionModel">): number {
    const executionModel = backtestSettings.executionModel;
    return executionModel === "signal_close" || executionModel === "next_close" ? 1 : 0;
}

export function executionLabTradeExecutionTimeSec(args: {
    backtestSettings: Pick<BacktestSettings, "executionModel">;
    time: Trade["entryTime"];
}): number | null {
    const rawTimeSec = finiteTradeTimeSeconds(args.time);
    return rawTimeSec === null ? null : rawTimeSec + closeExecutionTimestampShiftSec(args.backtestSettings);
}

function isExecutableQuoteExit(reason: Trade["exitReason"]): boolean {
    return Boolean(reason) && reason !== "end_of_data" && reason !== "partial";
}

export function collectExecutionLabTradeQuoteTimes(args: {
    backtestSettings: Pick<BacktestSettings, "executionModel">;
    trades: readonly Trade[];
    previousProcessedCandleTimeSec: number | null;
    latestCandleTimeSec: number;
}): number[] {
    const afterTs = args.previousProcessedCandleTimeSec ?? -Infinity;
    const times = new Set<number>();
    for (const trade of args.trades) {
        const entryTimeSec = executionLabTradeExecutionTimeSec({
            backtestSettings: args.backtestSettings,
            time: trade.entryTime,
        });
        if (entryTimeSec !== null && entryTimeSec > afterTs && entryTimeSec <= args.latestCandleTimeSec) {
            times.add(entryTimeSec);
        }

        const exitTimeSec = executionLabTradeExecutionTimeSec({
            backtestSettings: args.backtestSettings,
            time: trade.exitTime,
        });
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
