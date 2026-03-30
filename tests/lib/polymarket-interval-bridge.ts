/**
 * Polymarket Multi-Interval Bridge Utilities
 *
 * Maps chart trades to Polymarket event windows for various intervals:
 * - 1m: Maps to minute offsets (0-4) within 5m events
 * - 5m: Direct event matching (legacy)
 * - 15m: Groups 3x 5m events, entry offset 0-2
 * - 1h: Groups 12x 5m events, entry offset 0-11
 * - 4h: Groups 48x 5m events, entry offset 0-47
 *
 * Key concepts:
 * - Base unit is always 5m (300s) Polymarket events from SQLite
 * - Larger intervals group multiple 5m events
 * - Entry offset represents which sub-event the trade entered
 * - Only one trade per (super-event, offset) pair scores
 */

import { parseTimeToUnixSeconds } from "./time-normalization";
import type { Trade } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

const FIVE_MINUTES_SECONDS = 300;

/** Supported intervals for Polymarket backtesting */
export type PolymarketInterval = "1m" | "5m" | "15m" | "1h" | "4h";

/** Configuration for each interval */
export interface IntervalConfig {
    /** Interval label */
    label: PolymarketInterval;
    /** Duration in seconds */
    durationSeconds: number;
    /** Number of 5m sub-events per super-event */
    subEventCount: number;
    /** Minimum offset value */
    minOffset: number;
    /** Maximum offset value */
    maxOffset: number;
}

export const INTERVAL_CONFIGS: Record<PolymarketInterval, IntervalConfig> = {
    "1m": {
        label: "1m",
        durationSeconds: 60,
        subEventCount: 5,
        minOffset: 0,
        maxOffset: 4,
    },
    "5m": {
        label: "5m",
        durationSeconds: 300,
        subEventCount: 1,
        minOffset: 0,
        maxOffset: 0,
    },
    "15m": {
        label: "15m",
        durationSeconds: 900,
        subEventCount: 3,
        minOffset: 0,
        maxOffset: 2,
    },
    "1h": {
        label: "1h",
        durationSeconds: 3600,
        subEventCount: 12,
        minOffset: 0,
        maxOffset: 11,
    },
    "4h": {
        label: "4h",
        durationSeconds: 14400,
        subEventCount: 48,
        minOffset: 0,
        maxOffset: 47,
    },
};

/**
 * Represents a trade mapped to its containing Polymarket event.
 *
 * For 1m interval: outcome is the 5m event row, entryOffset is minute (0-4)
 * For 15m/1h/4h intervals: outcome is the sub-event at entryOffset, baseOutcome mirrors outcome for compatibility
 */
export interface MappedPolymarketTrade {
    /** The original trade */
    trade: Trade;
    /** The 5m outcome row for this trade's entry */
    outcome: PolymarketOutcomeRow;
    /** The base 5m outcome row (first sub-event for larger intervals) - alias for compatibility */
    baseOutcome: PolymarketOutcomeRow;
    /** Start timestamp of the super-event in unix seconds */
    superEventStartTs: number;
    /** End timestamp of the super-event in unix seconds */
    superEventEndTs: number;
    /** Entry offset within the super-event (which sub-event) */
    entryOffset: number;
    /** Entry timestamp in unix seconds */
    entryTs: number;
}

/**
 * Get interval configuration for a given interval string.
 */
export function getIntervalConfig(interval: string): IntervalConfig | null {
    const config = INTERVAL_CONFIGS[interval as PolymarketInterval];
    return config ?? null;
}

/**
 * Check if an interval is supported for Polymarket backtesting.
 */
export function isSupportedPolymarketInterval(interval: string): boolean {
    return interval in INTERVAL_CONFIGS;
}

/**
 * Build super-events by grouping consecutive 5m outcome rows.
 *
 * For 5m interval, each outcome is its own super-event.
 * For larger intervals, groups of outcomes form super-events.
 *
 * @param outcomes - Array of 5m Polymarket outcome rows (must be sorted by event_start_ts)
 * @param interval - Target interval
 * @returns Array of super-events with their constituent outcomes
 */
export function buildSuperEvents(
    outcomes: readonly PolymarketOutcomeRow[],
    interval: PolymarketInterval
): Array<{
    superEventStartTs: number;
    superEventEndTs: number;
    outcomes: PolymarketOutcomeRow[];
    subEventCount: number;
}> {
    const config = INTERVAL_CONFIGS[interval];
    if (!config) return [];

    if (interval === "1m") {
        // 1m uses individual 5m events with minute-level offsets
        return outcomes.map((o) => ({
            superEventStartTs: o.event_start_ts,
            superEventEndTs: o.event_end_ts,
            outcomes: [o],
            subEventCount: 1,
        }));
    }

    const result: Array<{
        superEventStartTs: number;
        superEventEndTs: number;
        outcomes: PolymarketOutcomeRow[];
        subEventCount: number;
    }> = [];

    // Group outcomes into super-events
    for (let i = 0; i < outcomes.length; i += config.subEventCount) {
        const group = outcomes.slice(i, i + config.subEventCount);
        if (group.length === 0) continue;

        const firstOutcome = group[0];
        const lastOutcome = group[group.length - 1];

        result.push({
            superEventStartTs: firstOutcome.event_start_ts,
            superEventEndTs: lastOutcome.event_end_ts,
            outcomes: group,
            subEventCount: group.length,
        });
    }

    return result;
}

/**
 * Find the containing super-event for a given trade entry timestamp.
 *
 * @param entryTs - Trade entry timestamp in unix seconds
 * @param superEvents - Array of super-events
 * @returns The containing super-event, or null if none found
 */
export function findContainingSuperEvent(
    entryTs: number,
    superEvents: Array<{
        superEventStartTs: number;
        superEventEndTs: number;
        outcomes: PolymarketOutcomeRow[];
        subEventCount: number;
    }>
): {
    superEventStartTs: number;
    superEventEndTs: number;
    outcomes: PolymarketOutcomeRow[];
    subEventCount: number;
} | null {
    for (const se of superEvents) {
        if (entryTs >= se.superEventStartTs && entryTs < se.superEventEndTs) {
            return se;
        }
    }
    return null;
}

/**
 * Calculate the entry offset (which sub-event) within a super-event.
 *
 * For 1m: offset is minute within 5m (0-4)
 * For 15m/1h/4h: offset is which 5m sub-event (0 to subEventCount-1)
 *
 * @param entryTs - Trade entry timestamp in unix seconds
 * @param superEventStartTs - Super-event start timestamp in unix seconds
 * @param interval - Target interval
 * @returns Entry offset, or -1 if entryTs is before event start
 */
export function calculateEntryOffset(
    entryTs: number,
    superEventStartTs: number,
    interval: PolymarketInterval
): number {
    const config = INTERVAL_CONFIGS[interval];
    if (!config) return -1;

    const secondsSinceStart = entryTs - superEventStartTs;
    if (secondsSinceStart < 0) {
        return -1;
    }

    if (interval === "1m") {
        // For 1m, calculate minute within the 5m event
        const offset = Math.floor(secondsSinceStart / 60);
        return offset >= 0 && offset < 5 ? offset : -1;
    }

    // For larger intervals, calculate which 5m sub-event
    const offset = Math.floor(secondsSinceStart / FIVE_MINUTES_SECONDS);
    return offset >= 0 && offset < config.subEventCount ? offset : -1;
}

/**
 * Map an array of trades to their containing Polymarket super-events.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of 5m Polymarket outcome rows (must be sorted)
 * @param interval - Target interval
 * @returns Array of mapped trades; trades without a containing event are excluded
 */
export function mapTradesToSuperEvents(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: PolymarketInterval
): MappedPolymarketTrade[] {
    const config = INTERVAL_CONFIGS[interval];
    if (!config) return [];

    const superEvents = buildSuperEvents(outcomes, interval);
    const result: MappedPolymarketTrade[] = [];

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const superEvent = findContainingSuperEvent(entryTs, superEvents);
        if (!superEvent) continue;

        const entryOffset = calculateEntryOffset(
            entryTs,
            superEvent.superEventStartTs,
            interval
        );
        if (entryOffset < 0 || entryOffset >= config.subEventCount) continue;

        // Use the outcome at the entry offset as the base outcome
        const baseOutcome = superEvent.outcomes[entryOffset];
        if (!baseOutcome) continue;

        result.push({
            trade,
            outcome: baseOutcome,
            baseOutcome,
            superEventStartTs: superEvent.superEventStartTs,
            superEventEndTs: superEvent.superEventEndTs,
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
 * @param selectedOffset - The offset to filter for
 * @returns Filtered array of trades matching the selected offset
 */
export function filterByEntryOffset(
    mappedTrades: readonly MappedPolymarketTrade[],
    selectedOffset: number
): MappedPolymarketTrade[] {
    if (selectedOffset < 0) {
        return [];
    }
    return mappedTrades.filter((mt) => mt.entryOffset === selectedOffset);
}

/**
 * Deduplicate trades per (super-event) for a given offset.
 *
 * When multiple trades fall into the same super-event and offset bucket,
 * only the first trade (by entry timestamp) is kept for scoring.
 *
 * @param mappedTrades - Array of mapped trades (should already be offset-filtered)
 * @returns Deduplicated array, keeping first trade per super-event
 */
export function deduplicateBySuperEvent(
    mappedTrades: readonly MappedPolymarketTrade[]
): MappedPolymarketTrade[] {
    const seenEvents = new Set<number>();
    const result: MappedPolymarketTrade[] = [];

    for (const mt of mappedTrades) {
        const eventKey = mt.superEventStartTs;
        if (seenEvents.has(eventKey)) {
            continue;
        }
        seenEvents.add(eventKey);
        result.push(mt);
    }

    return result;
}

/**
 * Select trades for Polymarket scoring based on interval and offset configuration.
 *
 * For 5m runs: passes through all trades with matching events.
 * For 1m/15m/1h/4h runs: filters by selected offset, then deduplicates per super-event.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of 5m Polymarket outcome rows
 * @param interval - Chart interval
 * @param selectedOffset - Entry offset for multi-sub-event intervals (ignored for 5m)
 * @returns Selected trades for scoring with their outcome mappings
 */
export function selectTradesForScoring(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: string,
    selectedOffset?: number
): MappedPolymarketTrade[] {
    const config = INTERVAL_CONFIGS[interval as PolymarketInterval];
    if (!config) return [];

    const isMultiSubEvent = interval !== "5m";

    // Map all trades to their containing super-events
    const mapped = mapTradesToSuperEvents(trades, outcomes, interval as PolymarketInterval);

    if (isMultiSubEvent) {
        // For multi-sub-event intervals, filter by selected offset and deduplicate
        const offset = selectedOffset ?? 0;
        const filtered = filterByEntryOffset(mapped, offset);
        return deduplicateBySuperEvent(filtered);
    }

    // For 5m runs, return all mapped trades
    return mapped;
}

/**
 * Build a map of super-event start ts -> first eligible trade for each offset.
 *
 * Useful for analysis across all offsets simultaneously.
 *
 * @param trades - Array of executed trades
 * @param outcomes - Array of 5m Polymarket outcome rows
 * @param interval - Target interval
 * @returns Map from superEventStartTs to array of [offset, firstTrade] pairs
 */
export function buildSuperEventOffsetTradeMap(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: PolymarketInterval
): Map<number, Map<number, MappedPolymarketTrade>> {
    const result = new Map<number, Map<number, MappedPolymarketTrade>>();
    const mapped = mapTradesToSuperEvents(trades, outcomes, interval);

    // Group by super-event, then by offset, keeping first trade per (super-event, offset)
    const seen = new Map<string, MappedPolymarketTrade>();
    for (const mt of mapped) {
        const key = `${mt.superEventStartTs}-${mt.entryOffset}`;
        if (!seen.has(key)) {
            seen.set(key, mt);

            const eventMap = result.get(mt.superEventStartTs) ?? new Map<number, MappedPolymarketTrade>();
            eventMap.set(mt.entryOffset, mt);
            result.set(mt.superEventStartTs, eventMap);
        }
    }

    return result;
}

/**
 * Validate that a selected offset is in the valid range for the given interval.
 *
 * @param offset - The offset to validate
 * @param interval - Target interval
 * @returns True if offset is valid for the interval
 */
export function isValidEntryOffset(offset: number, interval: PolymarketInterval): boolean {
    const config = INTERVAL_CONFIGS[interval];
    if (!config) return false;
    return Number.isInteger(offset) && offset >= config.minOffset && offset <= config.maxOffset;
}

/**
 * Get the valid offset range for an interval.
 */
export function getOffsetRange(interval: PolymarketInterval): { min: number; max: number } | null {
    const config = INTERVAL_CONFIGS[interval];
    if (!config) return null;
    return { min: config.minOffset, max: config.maxOffset };
}
