/**
 * Selector P&L leaf calculations for the OPEN_SCORE USD replay: the
 * overlapping event-basket summary and the fixed-$1,000 TOP_MEAN portfolio
 * simulation. Moved verbatim from the engine entry point.
 */
import type {
    SelectorPnlSummary,
    TopMeanPortfolioOpportunity,
    TopMeanPortfolioSummary,
} from "./types";
import { finiteOrNull } from "./statistics";

/**
 * Summarize a fixed-notional selector event series as overlapping basket P&L.
 * Non-finite returns are omitted rather than converted to zero. Drawdown is
 * calculated on the chronological, non-compounded cumulative return curve.
 */
export function computeSelectorPnl(
    returns: readonly number[],
    times: readonly number[],
): SelectorPnlSummary {
    const points: Array<{ value: number; time: number; index: number }> = [];
    for (let i = 0; i < returns.length; i += 1) {
        const value = returns[i]!;
        if (!Number.isFinite(value)) continue;
        const rawTime = times[i];
        points.push({ value, time: Number.isFinite(rawTime) ? rawTime! : i, index: i });
    }
    points.sort((a, b) => a.time - b.time || a.index - b.index);
    if (points.length === 0) {
        return { trades: 0, totalReturn: null, sharpe: null, winRate: null, maxDrawdown: null };
    }

    let totalReturn = 0;
    let wins = 0;
    let mean = 0;
    for (const point of points) {
        totalReturn += point.value;
        if (point.value > 0) wins += 1;
        mean += point.value;
    }
    mean /= points.length;
    let variance = 0;
    for (const point of points) variance += (point.value - mean) ** 2;
    const stdDev = points.length > 1 ? Math.sqrt(variance / (points.length - 1)) : 0;

    let curve = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const point of points) {
        curve += point.value;
        if (curve > peak) peak = curve;
        const drawdown = peak - curve;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
        trades: points.length,
        totalReturn: finiteOrNull(totalReturn),
        sharpe: finiteOrNull(stdDev > 1e-12 ? mean / stdDev : 0),
        winRate: finiteOrNull(wins / points.length),
        maxDrawdown: finiteOrNull(maxDrawdown),
    };
}

export function simulateTopMeanPortfolio(
    opportunities: readonly TopMeanPortfolioOpportunity[],
): TopMeanPortfolioSummary {
    const notional = 1_000;
    const ordered = opportunities
        .map((opportunity, index) => ({ opportunity, index }))
        .filter(({ opportunity }) =>
            Number.isFinite(opportunity.decisionTime)
            && Number.isFinite(opportunity.entryTime)
            && Number.isFinite(opportunity.exitTime)
            && opportunity.exitTime >= opportunity.entryTime
            && Number.isFinite(opportunity.netReturn))
        .sort((a, b) =>
            a.opportunity.decisionTime - b.opportunity.decisionTime
            || a.index - b.index);

    const activeUntilByAsset = new Map<string, number>();
    const accepted: Array<TopMeanPortfolioOpportunity & { pnl: number; index: number }> = [];
    let skippedTies = 0;
    let skippedActiveAsset = 0;

    for (const { opportunity, index } of ordered) {
        if (opportunity.tied) {
            skippedTies += 1;
            continue;
        }
        const activeUntil = activeUntilByAsset.get(opportunity.asset);
        // Exit occurs at the bar close. A new entry at that same bar's open
        // still overlaps, so it is accepted only when the prior exit is earlier.
        if (activeUntil !== undefined && activeUntil >= opportunity.entryTime) {
            skippedActiveAsset += 1;
            continue;
        }
        activeUntilByAsset.set(opportunity.asset, opportunity.exitTime);
        accepted.push({ ...opportunity, pnl: opportunity.netReturn * notional, index });
    }

    const capitalEvents: Array<{ time: number; delta: number; index: number }> = [];
    for (const trade of accepted) {
        capitalEvents.push({ time: trade.entryTime, delta: 1, index: trade.index });
        capitalEvents.push({ time: trade.exitTime, delta: -1, index: trade.index });
    }
    capitalEvents.sort((a, b) =>
        a.time - b.time
        // An exit is at the close while an entry is at the open, so entries at
        // the same timestamp consume capital before close-time exits release it.
        || b.delta - a.delta
        || a.index - b.index);
    let concurrent = 0;
    let peakConcurrentPositions = 0;
    for (const event of capitalEvents) {
        concurrent += event.delta;
        if (concurrent > peakConcurrentPositions) peakConcurrentPositions = concurrent;
    }

    const realized = [...accepted].sort((a, b) => a.exitTime - b.exitTime || a.index - b.index);
    let netPnl = 0;
    let wins = 0;
    let curve = 0;
    let peak = 0;
    let maxRealizedDrawdown = 0;
    for (const trade of realized) {
        netPnl += trade.pnl;
        if (trade.pnl > 0) wins += 1;
        curve += trade.pnl;
        if (curve > peak) peak = curve;
        const drawdown = peak - curve;
        if (drawdown > maxRealizedDrawdown) maxRealizedDrawdown = drawdown;
    }

    const trades = accepted.length;
    const peakCapital = peakConcurrentPositions * notional;
    return {
        notionalPerTrade: notional,
        eligibleSignals: ordered.length,
        trades,
        skippedTies,
        skippedActiveAsset,
        netPnl: trades > 0 ? finiteOrNull(netPnl) : null,
        averagePnl: trades > 0 ? finiteOrNull(netPnl / trades) : null,
        winRate: trades > 0 ? finiteOrNull(wins / trades) : null,
        maxRealizedDrawdown: trades > 0 ? finiteOrNull(maxRealizedDrawdown) : null,
        peakConcurrentPositions,
        peakCapital,
        returnOnPeakCapital: peakCapital > 0 ? finiteOrNull(netPnl / peakCapital) : null,
    };
}
