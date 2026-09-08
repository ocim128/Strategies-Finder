import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotBar,
    PairFeatureSnapshotTrade,
} from "../types";
import { median, populationMean } from "./math";

function orderedFiniteTrades(historicalTrades: readonly PairFeatureSnapshotTrade[]): PairFeatureSnapshotTrade[] {
    return historicalTrades
        .filter((trade) => Number.isFinite(trade.pnlPercent))
        .slice()
        .sort((left, right) => left.exitBarIndex - right.exitBarIndex || left.tradeOrdinal - right.tradeOrdinal);
}

export function computeTradeMeanNetPctV1(historicalTrades: readonly PairFeatureSnapshotTrade[], window: number): PairFeatureEvaluationResult {
    const ordered = orderedFiniteTrades(historicalTrades);
    const observations = Math.min(ordered.length, window);
    if (observations < window) return { value: null, observations };
    let total = 0;
    for (const trade of ordered.slice(-window)) total += trade.pnlPercent;
    return { value: Object.is(total / window, -0) ? 0 : total / window, observations };
}

function tradeWindowMetric(
    historicalTrades: readonly PairFeatureSnapshotTrade[],
    window: number,
    calculate: (trades: readonly PairFeatureSnapshotTrade[]) => number | null,
): PairFeatureEvaluationResult {
    const ordered = orderedFiniteTrades(historicalTrades);
    const observations = Math.min(ordered.length, window);
    if (observations < window) return { value: null, observations };
    return { value: calculate(ordered.slice(-window)), observations };
}

export function computeTradeMedianNetPct(historicalTrades: readonly PairFeatureSnapshotTrade[], window: number): PairFeatureEvaluationResult {
    return tradeWindowMetric(historicalTrades, window, (trades) => median(trades.map((trade) => trade.pnlPercent)));
}

export function computeTradeWinFraction(historicalTrades: readonly PairFeatureSnapshotTrade[], window: number): PairFeatureEvaluationResult {
    return tradeWindowMetric(historicalTrades, window, (trades) => trades.filter((trade) => trade.pnlPercent > 0).length / trades.length);
}

export function computeTradeDownsideRms(historicalTrades: readonly PairFeatureSnapshotTrade[], window: number): PairFeatureEvaluationResult {
    return tradeWindowMetric(historicalTrades, window, (trades) => {
        const losses = trades.filter((trade) => trade.pnlPercent < 0).map((trade) => trade.pnlPercent ** 2);
        return losses.length === 0 ? null : Math.sqrt(populationMean(losses));
    });
}

export function computeTradeProfitFactor(historicalTrades: readonly PairFeatureSnapshotTrade[], window: number): PairFeatureEvaluationResult {
    return tradeWindowMetric(historicalTrades, window, (trades) => {
        let gains = 0;
        let losses = 0;
        for (const trade of trades) {
            if (trade.pnlPercent > 0) gains += trade.pnlPercent;
            else if (trade.pnlPercent < 0) losses += -trade.pnlPercent;
        }
        return losses === 0 ? null : gains / losses;
    });
}

export function computeGrandfatheredLosingStreak(historicalTrades: readonly PairFeatureSnapshotTrade[]): PairFeatureEvaluationResult {
    const ordered = orderedFiniteTrades(historicalTrades);
    if (ordered.length === 0) return { value: null, observations: 0 };
    let streak = 0;
    for (let index = ordered.length - 1; index >= 0 && ordered[index]!.pnlPercent < 0; index -= 1) streak += 1;
    return { value: streak, observations: ordered.length };
}

export function computeGrandfatheredDrawdown(historicalTrades: readonly PairFeatureSnapshotTrade[]): PairFeatureEvaluationResult {
    const ordered = orderedFiniteTrades(historicalTrades);
    if (ordered.length === 0) return { value: null, observations: 0 };
    let equity = 0;
    let peak = 0;
    for (const trade of ordered) {
        equity += trade.pnlPercent;
        peak = Math.max(peak, equity);
    }
    return { value: Math.max(0, peak - equity), observations: ordered.length };
}

export function computeGrandfatheredMedianMae(
    bars: readonly PairFeatureSnapshotBar[],
    historicalTrades: readonly PairFeatureSnapshotTrade[],
): PairFeatureEvaluationResult {
    const maes: number[] = [];
    for (const trade of orderedFiniteTrades(historicalTrades)) {
        if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;
        let minimum = Number.POSITIVE_INFINITY;
        for (let index = trade.entryBarIndex + 1; index < trade.exitBarIndex; index += 1) {
            const close = bars[index]?.[4];
            if (!Number.isFinite(close)) continue;
            const signedReturn = trade.direction === "long"
                ? (close - trade.entryPrice) / trade.entryPrice
                : (trade.entryPrice - close) / trade.entryPrice;
            minimum = Math.min(minimum, signedReturn);
        }
        if (minimum !== Number.POSITIVE_INFINITY) maes.push(Math.max(0, -minimum) * 100);
    }
    return { value: maes.length > 0 ? median(maes) : null, observations: maes.length };
}
