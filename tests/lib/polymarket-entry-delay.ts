import { readNumber } from "./settings-parse-utils";

export const DEFAULT_POLYMARKET_ENTRY_DELAY_BARS = 0;
export const MAX_POLYMARKET_ENTRY_DELAY_BARS = 300;

export function clampPolymarketEntryDelayBars(value: unknown): number {
    const parsed = readNumber(value, DEFAULT_POLYMARKET_ENTRY_DELAY_BARS);
    return Math.max(0, Math.min(MAX_POLYMARKET_ENTRY_DELAY_BARS, Math.round(parsed)));
}
