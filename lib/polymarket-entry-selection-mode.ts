export type PolymarketEntrySelectionMode = "fixed_offset" | "actual_entry_minute";

import type { Trade } from "./types/strategies";

export function resolvePolymarketEntrySelectionMode(value: unknown): PolymarketEntrySelectionMode {
    return typeof value === "string" && value.trim().toLowerCase() === "actual_entry_minute"
        ? "actual_entry_minute"
        : "fixed_offset";
}

export function isActualPolymarketEntryMinuteMode(
    mode: PolymarketEntrySelectionMode | undefined | null
): boolean {
    return mode === "actual_entry_minute";
}

export function hasFilteredPolymarketTrades(trades: readonly Trade[] | undefined | null): boolean {
    return Boolean(trades?.some((trade) => trade.polymarketOutcome?.marketExitSource === "filtered"));
}

export function resolvePolymarketEntrySelectionModeForDisplay(
    storedMode: PolymarketEntrySelectionMode | undefined | null,
    activeMode: PolymarketEntrySelectionMode | undefined | null,
    trades?: readonly Trade[] | null
): PolymarketEntrySelectionMode {
    if (storedMode === "actual_entry_minute") {
        return "actual_entry_minute";
    }

    if (
        storedMode === "fixed_offset"
        && activeMode === "actual_entry_minute"
        && hasFilteredPolymarketTrades(trades)
    ) {
        return "actual_entry_minute";
    }

    return storedMode ?? (activeMode === "actual_entry_minute" ? "actual_entry_minute" : "fixed_offset");
}
