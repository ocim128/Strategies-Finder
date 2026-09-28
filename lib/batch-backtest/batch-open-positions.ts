import type { BacktestResult } from "../types/strategies";
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
    return { side: last.type };
}

/**
 * Pair symbols (in run order) whose position was still open at the end of the
 * run. Prefers the runner-computed `openPosition` scalar so scalar-only server
 * rows (no `result.trades` on the wire) participate; falls back to the trades
 * for full rows that predate the scalar.
 */
export function collectOpenPositionSymbols(
    rows: readonly BatchBacktestSymbolResult[],
): string[] {
    const symbols: string[] = [];
    for (const row of rows) {
        if (row.openPosition ?? computeOpenPosition(row.result)) {
            symbols.push(row.symbol);
        }
    }
    return symbols;
}
