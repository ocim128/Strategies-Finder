import type { BacktestResult } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

/**
 * Open-position detection for Batch run results.
 *
 * A pair "currently has an open position" when its LAST backtest trade was
 * closed only because the data ran out (`exitReason === "end_of_data"` — the
 * engine's end-of-data force-close of a still-open position). This is the same
 * open-trade signal `computeOpenTradeAssetScores` (batch-row-scalars.ts) uses
 * for the OPEN_SCORE summary sections, so both surfaces agree on which pairs
 * are open at the end of a run.
 */

export interface OpenPositionInfo {
    side: "long" | "short";
    /** Entry timestamp in Unix seconds; absent in older saved results. */
    entryTimeSec?: number;
}

/**
 * Scalar projection of the still-open position for one row. Returns null when
 * the last trade exited normally or the row has no trades. Computed where
 * trades are available (the runner) and carried as a tiny scalar so the
 * browser can build the open-position pair list without `result.trades`.
 */
export function computeOpenPosition(
    result: Pick<BacktestResult, "trades"> | undefined | null,
): OpenPositionInfo | null {
    const trades = result?.trades;
    if (!trades || trades.length === 0) return null;
    const last = trades[trades.length - 1]!;
    if (last.exitReason !== "end_of_data") return null;
    if (last.type !== "long" && last.type !== "short") return null;
    const entryTimeSec = timeToNumber(last.entryTime);
    return { side: last.type, ...(entryTimeSec !== null ? { entryTimeSec } : {}) };
}

/**
 * Pair symbols whose position was still open at the end of the run, newest
 * entry first. Ties and entries without a timestamp retain run order; unknown
 * timestamps sort last. Prefers the runner-computed `openPosition` scalar so
 * scalar-only server rows (no `result.trades` on the wire) participate; falls
 * back to the trades for full rows that predate the scalar.
 */
export function collectOpenPositionSymbols(
    rows: readonly BatchBacktestSymbolResult[],
): string[] {
    const positions: { symbol: string; entryTimeSec: number }[] = [];
    for (const row of rows) {
        const position = row.openPosition ?? computeOpenPosition(row.result);
        if (position) {
            positions.push({
                symbol: row.symbol,
                entryTimeSec: Number.isFinite(position.entryTimeSec) ? position.entryTimeSec! : -Infinity,
            });
        }
    }
    positions.sort((a, b) => a.entryTimeSec === b.entryTimeSec ? 0 : b.entryTimeSec - a.entryTimeSec);
    return positions.map((position) => position.symbol);
}
