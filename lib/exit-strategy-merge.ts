/**
 * Merge helper for the Exit Strategy Override feature.
 *
 * Exit-strategy signals are tagged `exitOnly: true` so the backtest engine
 * treats them as close-only (sell closes long, buy closes short) even when
 * `disableSignalExits` is on, and never opens a new position from them.
 *
 * The merge is a stable sort by signal time: entry signals keep precedence
 * over exit signals on the same bar so the engine evaluates entries first
 * (matches the existing combo-merge and polymarket-protection precedents).
 */
import type { Signal } from "./types/strategies";
import { compareTime } from "./strategies/backtest/backtest-utils";

export function mergeExitStrategySignals(
    entrySignals: readonly Signal[],
    exitSignals: readonly Signal[]
): Signal[] {
    if (exitSignals.length === 0) {
        return entrySignals.slice();
    }

    const taggedExits = exitSignals.map((signal) => ({ ...signal, exitOnly: true }));
    const merged = [...entrySignals, ...taggedExits];

    // Stable sort by time; preserves entry-before-exit order for same-bar ties.
    merged.sort((a, b) => compareTime(a.time, b.time));
    return merged;
}
