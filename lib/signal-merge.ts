/**
 * Standalone signal merge utility used by the Combo Finder.
 */
import type { Time } from "lightweight-charts";
import { compareTime, timeKey } from "./strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

type MergeableSignal = {
    time: Time;
    type: 'buy' | 'sell';
    price: number;
    triggerPrice?: number;
    reason?: string;
    barIndex?: number;
    sizeFraction?: number;
};

function compareMergeableSignalTime(left: Time, right: Time): number {
    const leftSeconds = parseTimeToUnixSeconds(left);
    const rightSeconds = parseTimeToUnixSeconds(right);
    if (leftSeconds !== null && rightSeconds !== null) {
        return leftSeconds - rightSeconds;
    }
    return compareTime(left, right);
}

/**
 * Merge signals from two strategy runs.
 *
 * AND mode: keep only signals where both strategies fire on the same bar
 *           with the same direction (buy/sell). Uses primary signal's price.
 *
 * OR mode:  union of both signal sets; if both fire on the same bar,
 *           primary signal takes precedence.
 */
export function mergeStrategySignals(
    primarySignals: MergeableSignal[],
    secondarySignals: MergeableSignal[],
    mode: 'and' | 'or'
): MergeableSignal[] {
    // Build a map of secondary signals keyed by timeKey for O(1) lookup
    const secondaryMap = new Map<string, MergeableSignal>();
    for (const signal of secondarySignals) {
        const key = timeKey(signal.time);
        secondaryMap.set(key, signal);
    }

    if (mode === 'and') {
        // AND: keep primary signals only if secondary agrees (same bar + same direction)
        const merged: MergeableSignal[] = [];
        for (const primary of primarySignals) {
            const key = timeKey(primary.time);
            const secondary = secondaryMap.get(key);
            if (secondary && secondary.type === primary.type) {
                merged.push(primary); // use primary's price
            }
        }
        return merged;
    }

    // OR: union - primary wins on conflicts
    const primaryMap = new Map<string, MergeableSignal>();
    for (const signal of primarySignals) {
        primaryMap.set(timeKey(signal.time), signal);
    }

    const merged: MergeableSignal[] = [...primarySignals];
    for (const secondary of secondarySignals) {
        const key = timeKey(secondary.time);
        if (!primaryMap.has(key)) {
            merged.push(secondary);
        }
    }

    // Sort by time
    merged.sort((a, b) => compareMergeableSignalTime(a.time, b.time));

    return merged;
}
