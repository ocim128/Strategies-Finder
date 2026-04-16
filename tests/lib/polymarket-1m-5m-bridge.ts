/**
 * Polymarket 1m -> 5m Bridge Utilities
 *
 * Maps 1m chart trades into containing 5m Polymarket event windows
 * for scoring against 5m outcome rows.
 *
 * Key concepts:
 * - A 5m Polymarket event spans [event_start_ts, event_end_ts) where end = start + 300s
 * - Entry offset 0..4 represents which minute within the 5m event the trade entered:
 *   - 0 = first minute (event_start_ts to event_start_ts + 59s)
 *   - 1 = second minute (event_start_ts + 60s to event_start_ts + 119s)
 *   - 2 = third minute
 *   - 3 = fourth minute
 *   - 4 = fifth minute (event_start_ts + 240s to event_start_ts + 299s)
 * - For 1m runs, only trades falling into the selected offset are eligible
 * - Only one trade per (event, offset) pair scores; duplicates are ignored
 */

import { parseTimeToUnixSeconds } from "./time-normalization";
import type { Trade } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { isActualPolymarketEntryMinuteMode } from "./polymarket-entry-selection-mode";

const ONE_MINUTE_SECONDS = 60;

/**
 * Represents a trade mapped to its containing 5m Polymarket event.
 */
export interface MappedPolymarketTrade {
    /** The original trade */
    trade: Trade;
    /** The containing 5m outcome row */
    outcome: PolymarketOutcomeRow;
    /** Entry offset minute within the 5m event (0..4) */
    entryOffset: number;
    /** Entry timestamp in unix seconds */
    entryTs: number;
}

/**
 * Find the containing 5m Polymarket event for a given trade entry timestamp.
 *
 * A trade is contained in an event when:
 * - event_start_ts <= entryTs < event_end_ts
 *
 * For 5m events, end_ts = start_ts + 300 seconds.
 *
 * @param entryTs - Trade entry timestamp in unix seconds
 * @param outcomes - Array of Polymarket outcome rows (must include 5m events)
 * @returns The containing outcome row, or null if none found
 */
export function findContainingEvent(
    entryTs: number,
    outcomes: readonly PolymarketOutcomeRow[]
): PolymarketOutcomeRow | null {
    let left = 0;
    let right = outcomes.length - 1;

    while (left <= right) {
        const mid = (left + right) >>> 1;
        const outcome = outcomes[mid];

        if (entryTs < outcome.event_start_ts) {
            right = mid - 1;
        } else if (entryTs >= outcome.event_end_ts) {
            left = mid + 1;
        } else {
            return outcome;
        }
    }
    return null;
}

/**
 * Calculate the entry offset minute (0..4) within a 5m Polymarket event.
 *
 * @param entryTs - Trade entry timestamp in unix seconds
 * @param eventStartTs - Event start timestamp in unix seconds
 * @returns Entry offset 0..4, or -1 if entryTs is before event start
 */
export function calculateEntryOffset(
    entryTs: number,
    eventStartTs: number
): number {
    const secondsSinceStart = entryTs - eventStartTs;
    if (secondsSinceStart < 0) {
        return -1; // Entry is before event start (shouldn't happen if properly contained)
    }
    const offset = Math.floor(secondsSinceStart / ONE_MINUTE_SECONDS);
    // Clamp to 0..4 range; values >= 5 indicate entry after event window
    return offset >= 0 && offset < 5 ? offset : -1;
}

/**
 * Map an array of trades to their containing 5m Polymarket events.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of Polymarket outcome rows
 * @returns Array of mapped trades; trades without a containing event are excluded
 */
export function mapTradesToEvents(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): MappedPolymarketTrade[] {
    const result: MappedPolymarketTrade[] = [];

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const outcome = findContainingEvent(entryTs, outcomes);
        if (!outcome) continue;

        const entryOffset = calculateEntryOffset(entryTs, outcome.event_start_ts);
        if (entryOffset < 0 || entryOffset > 4) continue;

        result.push({
            trade,
            outcome,
            entryOffset,
            entryTs,
        });
    }

    return result;
}

/**
 * Filter mapped trades to only those matching a selected entry offset.
 *
 * @param mappedTrades - Array of mapped trades
 * @param selectedOffset - The offset minute to filter for (0..4)
 * @returns Filtered array of trades matching the selected offset
 */
export function filterByEntryOffset(
    mappedTrades: readonly MappedPolymarketTrade[],
    selectedOffset: number
): MappedPolymarketTrade[] {
    if (selectedOffset < 0 || selectedOffset > 4) {
        return [];
    }
    return mappedTrades.filter((mt) => mt.entryOffset === selectedOffset);
}

/**
 * Deduplicate trades per (event_start_ts) for a given offset.
 *
 * When multiple trades fall into the same event and offset bucket,
 * only the first trade (by entry timestamp) is kept for scoring.
 *
 * @param mappedTrades - Array of mapped trades (should already be offset-filtered)
 * @returns Deduplicated array, keeping first trade per event
 */
export function deduplicateByEvent(
    mappedTrades: readonly MappedPolymarketTrade[]
): MappedPolymarketTrade[] {
    const seenEvents = new Set<number>();
    const result: MappedPolymarketTrade[] = [];

    for (const mt of mappedTrades) {
        const eventKey = mt.outcome.event_start_ts;
        if (seenEvents.has(eventKey)) {
            continue; // Skip duplicate for this event
        }
        seenEvents.add(eventKey);
        result.push(mt);
    }

    return result;
}

/**
 * Select trades for Polymarket scoring based on interval and offset configuration.
 *
 * For 5m runs: passes through all trades with matching events (current behavior).
 * For 1m runs: filters by selected offset, then deduplicates per event.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of Polymarket outcome rows
 * @param interval - Chart interval ("1m" or "5m")
 * @param selectedOffset - Entry offset for 1m runs (ignored for 5m)
 * @returns Selected trades for scoring with their outcome mappings
 */
export function selectTradesForScoring(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: string,
    selectedOffset?: number,
    entrySelectionMode: PolymarketEntrySelectionMode = "fixed_offset"
): MappedPolymarketTrade[] {
    const is1mRun = interval === "1m";

    // Map all trades to their containing events
    const mapped = mapTradesToEvents(trades, outcomes);

    if (is1mRun) {
        if (isActualPolymarketEntryMinuteMode(entrySelectionMode)) {
            return deduplicateByEvent(mapped);
        }

        // For 1m runs, filter by selected offset and deduplicate
        const offset = selectedOffset ?? 0;
        const filtered = filterByEntryOffset(mapped, offset);
        return deduplicateByEvent(filtered);
    }

    // For 5m runs, return all mapped trades (current behavior preserved)
    // No offset filtering or deduplication applied for backward compatibility
    return mapped;
}

/**
 * Build a map of event_start_ts -> first eligible trade for each offset.
 *
 * Useful for analysis across all offsets simultaneously.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of Polymarket outcome rows
 * @returns Map from event_start_ts to array of [offset, firstTrade] pairs
 */
export function buildEventOffsetTradeMap(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): Map<number, Map<number, MappedPolymarketTrade>> {
    const result = new Map<number, Map<number, MappedPolymarketTrade>>();
    const mapped = mapTradesToEvents(trades, outcomes);

    // Group by event, then by offset, keeping first trade per (event, offset)
    const seen = new Map<string, MappedPolymarketTrade>();
    for (const mt of mapped) {
        const key = `${mt.outcome.event_start_ts}-${mt.entryOffset}`;
        if (!seen.has(key)) {
            seen.set(key, mt);

            const eventMap = result.get(mt.outcome.event_start_ts) ?? new Map<number, MappedPolymarketTrade>();
            eventMap.set(mt.entryOffset, mt);
            result.set(mt.outcome.event_start_ts, eventMap);
        }
    }

    return result;
}

/**
 * Get the entry price for a specific offset minute from an outcome row.
 *
 * @param outcome - Polymarket outcome row
 * @param offset - Entry offset minute (0..4)
 * @returns The YES entry price for that minute, or yes_open_price for offset 0
 */
export function getEntryPriceForOffset(
    outcome: PolymarketOutcomeRow,
    offset: number
): number | null {
    // #COMPLETION_DRIVE: Assuming yes_entry_minute_X_price is 1-indexed for the minute of the event
    // #SUGGEST_VERIFY: Verify the Polymarket dataset schema specifically on what X means in yes_entry_minute_X_price
    switch (offset) {
        case 0:
            return outcome.yes_open_price;
        case 1:
            return outcome.yes_entry_minute_2_price;
        case 2:
            return outcome.yes_entry_minute_3_price;
        case 3:
            return outcome.yes_entry_minute_4_price;
        case 4:
            return null;
        default:
            return null;
    }
}

/**
 * Validate that a selected offset is in the valid range.
 *
 * @param offset - The offset to validate
 * @returns True if offset is 0..4
 */
export function isValidEntryOffset(offset: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && offset <= 4;
}
