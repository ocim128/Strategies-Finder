import type { OHLCVData } from "./types/index";
import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

export function trimToClosedCandles(
    data: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000)
): OHLCVData[] {
    const intervalSec = getIntervalSeconds(interval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return data;

    let closedCount = 0;
    for (const candle of data) {
        const openSec = parseTimeToUnixSeconds(candle.time);
        if (openSec === null || nowSec < openSec + intervalSec) break;
        closedCount += 1;
    }

    return closedCount === data.length ? data : data.slice(0, closedCount);
}
