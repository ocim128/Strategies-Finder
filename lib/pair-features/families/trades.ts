import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotTrade,
} from "../types";

const TRADE_WINDOW = 8;

/** Mean captured net trade percentage over the last eight eligible records. */
export function computeTradeMeanNetPct(
    historicalTrades: readonly PairFeatureSnapshotTrade[],
): PairFeatureEvaluationResult {
    const ordered = historicalTrades
        .filter((trade) => Number.isFinite(trade.pnlPercent))
        .slice()
        .sort((left, right) => left.exitBarIndex - right.exitBarIndex || left.tradeOrdinal - right.tradeOrdinal);
    const observations = Math.min(ordered.length, TRADE_WINDOW);
    if (observations < TRADE_WINDOW) return { value: null, observations };

    const recent = ordered.slice(-TRADE_WINDOW);
    let total = 0;
    for (const trade of recent) total += trade.pnlPercent;
    const value = total / TRADE_WINDOW;
    return { value: Object.is(value, -0) ? 0 : value, observations };
}
