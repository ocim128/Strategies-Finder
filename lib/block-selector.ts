import { OHLCVData } from "./strategies/index";
import { parseTimeToUnixSeconds } from "./time-normalization";

/**
 * Slices an OHLCV array to the given block range (inclusive).
 * If block is null, returns the original array unchanged.
 * `from` / `to` are Unix timestamps in seconds matching OHLCVData.time.
 */
export function sliceOhlcvByBlock(
    data: OHLCVData[],
    block: { from: number; to: number } | null
): OHLCVData[] {
    if (!block) return data;
    const { from, to } = block;
    return data.filter((candle) => {
        const time = parseTimeToUnixSeconds(candle.time);
        return time !== null && time >= from && time <= to;
    });
}
