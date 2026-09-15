import type { OHLCVData, EntryTimeFilter } from "./types/strategies";
import { parseTimeToUnixSeconds } from "./time-normalization";

export const DEFAULT_ENTRY_TIME_FILTER: EntryTimeFilter = "day_open";

export function resolveEntryTimeFilter(
    value: unknown,
    fallback: EntryTimeFilter = DEFAULT_ENTRY_TIME_FILTER,
): EntryTimeFilter {
    if (value === "day_open" || value === "day_close") {
        return value;
    }
    return fallback;
}

function utcDayKey(candle: OHLCVData | undefined): number | null {
    if (!candle) return null;
    const seconds = parseTimeToUnixSeconds(candle.time);
    return seconds === null ? null : Math.floor(seconds / 86_400);
}

/**
 * Checks the actual execution bar, not the signal bar. Invalid timestamps fail
 * open so a malformed legacy candle cannot silently remove all entries.
 */
export function isEntryBarAllowed(
    data: readonly OHLCVData[],
    barIndex: number,
    filter: EntryTimeFilter,
): boolean {
    const currentDay = utcDayKey(data[barIndex]);
    if (currentDay === null) return true;

    if (filter === "day_open") {
        return barIndex === 0 || utcDayKey(data[barIndex - 1]) !== currentDay;
    }
    return barIndex === data.length - 1 || utcDayKey(data[barIndex + 1]) !== currentDay;
}
