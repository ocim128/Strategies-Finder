import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { OHLCVData } from "./types";

export function countRealtimeGapBars(
    lastTime: unknown,
    nextTime: unknown,
    interval: string
): number {
    const lastTimeSec = parseTimeToUnixSeconds(lastTime);
    const nextTimeSec = parseTimeToUnixSeconds(nextTime);
    const intervalSeconds = getIntervalSeconds(interval.trim().toLowerCase());

    if (
        lastTimeSec === null ||
        nextTimeSec === null ||
        !Number.isFinite(intervalSeconds) ||
        intervalSeconds <= 0
    ) {
        return 0;
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
    const intervalSeconds = getIntervalSeconds(interval.trim().toLowerCase());
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
        if (currentTimeSec - previousTimeSec > intervalSeconds) {
            return previousTimeSec;
        }
        previousTimeSec = currentTimeSec;
    }

    return null;
}
