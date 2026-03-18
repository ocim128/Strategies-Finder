import type { OHLCVData } from "./types/index";
import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

export function trimToClosedCandles(
    data: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000)
): OHLCVData[] {
    if (data.length < 2) return data;

    const intervalSec = getIntervalSeconds(interval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return data;

    const lastOpenSec = parseTimeToUnixSeconds(data[data.length - 1].time);
    if (lastOpenSec === null) return data;

    return nowSec < lastOpenSec + intervalSec
        ? data.slice(0, -1)
        : data;
}
