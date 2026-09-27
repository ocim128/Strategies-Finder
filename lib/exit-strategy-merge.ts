/**
 * Merge helper for the Exit Strategy Override feature.
 *
 * Exit-strategy signals are tagged `exitOnly: true` so the backtest engine
 * treats them as close-only (sell closes long, buy closes short) even when
 * `disableSignalExits` is on, and never opens a new position from them.
 *
 * Both streams are ordered in practice, so the merge is a guarded linear
 * merge (event-sweep plan phase 4): each input time is normalized once, and
 * when both sequences are nondecreasing with finite keys the outputs merge
 * in one pass — entries first on equal times, each input's internal order
 * preserved, entry objects kept by reference, exit objects cloned with
 * `exitOnly: true` as they enter the output. Unsorted inputs or
 * non-normalizable times fall back to the original tag/concatenate/
 * stable-sort path unchanged.
 */
import type { Signal } from "./types/strategies";
import { compareTime, timeToNumber } from "./strategies/backtest/backtest-utils";

export function mergeExitStrategySignals(
    entrySignals: Signal[],
    exitSignals: readonly Signal[]
): Signal[] {
    if (exitSignals.length === 0) {
        return entrySignals;
    }

    const entryCount = entrySignals.length;
    const exitCount = exitSignals.length;
    // Temporary key buffers: local to one merge, never a persistent cache.
    const entryKeys = new Array<number>(entryCount);
    for (let i = 0; i < entryCount; i += 1) {
        const key = timeToNumber(entrySignals[i]!.time);
        if (key === null || !Number.isFinite(key) || (i > 0 && key < entryKeys[i - 1]!)) {
            return mergeExitStrategySignalsBySort(entrySignals, exitSignals);
        }
        entryKeys[i] = key;
    }
    const exitKeys = new Array<number>(exitCount);
    for (let i = 0; i < exitCount; i += 1) {
        const key = timeToNumber(exitSignals[i]!.time);
        if (key === null || !Number.isFinite(key) || (i > 0 && key < exitKeys[i - 1]!)) {
            return mergeExitStrategySignalsBySort(entrySignals, exitSignals);
        }
        exitKeys[i] = key;
    }

    const merged: Signal[] = new Array(entryCount + exitCount);
    let entryIdx = 0;
    let exitIdx = 0;
    let mergedIdx = 0;
    while (entryIdx < entryCount && exitIdx < exitCount) {
        if (entryKeys[entryIdx]! <= exitKeys[exitIdx]!) {
            merged[mergedIdx++] = entrySignals[entryIdx++]!;
        } else {
            merged[mergedIdx++] = { ...exitSignals[exitIdx++]!, exitOnly: true };
        }
    }
    while (entryIdx < entryCount) {
        merged[mergedIdx++] = entrySignals[entryIdx++]!;
    }
    while (exitIdx < exitCount) {
        merged[mergedIdx++] = { ...exitSignals[exitIdx++]!, exitOnly: true };
    }
    return merged;
}

/** The original tag/concatenate/stable-sort merge, kept as the fallback. */
function mergeExitStrategySignalsBySort(
    entrySignals: Signal[],
    exitSignals: readonly Signal[]
): Signal[] {
    const taggedExits = exitSignals.map((signal) => ({ ...signal, exitOnly: true }));
    const merged = [...entrySignals, ...taggedExits];

    // Stable sort by time; preserves entry-before-exit order for same-bar ties.
    merged.sort((a, b) => compareTime(a.time, b.time));
    return merged;
}
