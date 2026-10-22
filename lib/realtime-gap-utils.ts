import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { OHLCVData } from "./types";

function resolveGapInterval(interval: string): { seconds: number; months: number | null } {
    const trimmed = interval.trim();
    const monthly = /^(\d+)M$/.exec(trimmed);
    return {
        seconds: getIntervalSeconds(monthly ? trimmed : trimmed.toLowerCase()),
        months: monthly ? Number(monthly[1]) : null,
    };
}

function elapsedCalendarMonths(fromSeconds: number, toSeconds: number): number {
    const from = new Date(fromSeconds * 1000);
    const to = new Date(toSeconds * 1000);
    return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
}

export function countRealtimeGapBars(
    lastTime: unknown,
    nextTime: unknown,
    interval: string
): number {
    const lastTimeSec = parseTimeToUnixSeconds(lastTime);
    const nextTimeSec = parseTimeToUnixSeconds(nextTime);
    const { seconds: intervalSeconds, months: intervalMonths } = resolveGapInterval(interval);

    if (
        lastTimeSec === null ||
        nextTimeSec === null ||
        !Number.isFinite(intervalSeconds) ||
        intervalSeconds <= 0
    ) {
        return 0;
    }

    if (intervalMonths !== null) {
        const months = elapsedCalendarMonths(lastTimeSec, nextTimeSec);
        return Number.isFinite(months) ? Math.max(0, Math.floor(months / intervalMonths) - 1) : 0;
    }

    const diffSeconds = nextTimeSec - lastTimeSec;
    if (diffSeconds <= intervalSeconds) {
        return 0;
    }

    return Math.max(0, Math.floor(diffSeconds / intervalSeconds) - 1);
}

export function findFirstGapAnchorTime(
    candles: OHLCVData[],
    interval: string
): number | null {
    const { seconds: intervalSeconds, months: intervalMonths } = resolveGapInterval(interval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || candles.length < 2) {
        return null;
    }

    let previousTimeSec = parseTimeToUnixSeconds(candles[0]?.time);
    if (previousTimeSec === null) {
        return null;
    }

    for (let i = 1; i < candles.length; i += 1) {
        const currentTimeSec = parseTimeToUnixSeconds(candles[i]?.time);
        if (currentTimeSec === null) {
            return null;
        }
        const hasGap = intervalMonths !== null
            ? elapsedCalendarMonths(previousTimeSec, currentTimeSec) > intervalMonths
            : currentTimeSec - previousTimeSec > intervalSeconds;
        if (hasGap) {
            return previousTimeSec;
        }
        previousTimeSec = currentTimeSec;
    }

    return null;
}
