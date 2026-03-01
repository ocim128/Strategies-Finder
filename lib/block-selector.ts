import { OHLCVData } from "./strategies/index";

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
    return data.filter(c => (c.time as number) >= from && (c.time as number) <= to);
}
