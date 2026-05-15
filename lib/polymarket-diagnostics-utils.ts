import type { BacktestPolymarketTradeSummary } from "./types/polymarket-outcomes";
import type { BacktestResult, ExpectancyBreakdownRow, Trade } from "./types/strategies";
import type { PolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";

interface PolymarketFeatureAnalysis {
    feature: string;
    label: string;
    suggestedFilter: {
        direction: "above" | "below";
        threshold: number;
    } | null;
    winRateIfFiltered: number;
    expectancyIfFiltered: number;
    tradesRemovedPercent: number;
    separationScore: number;
    scoredProjection?: {
        filteredWinRate: number;
        filteredTrades: number;
        originalTrades: number;
        removedPercent: number;
        baselineDelta: number;
    } | null;
}

export function clampPolymarketEntryOffset(value: number): number {
    return Math.max(0, Math.min(4, Math.floor(value)));
}

export function inferPolymarketEntryOffsetFromTrades(trades: readonly Trade[]): number | null {
    const offsets = new Set<number>();
    for (const trade of trades) {
        const entryOffset = trade.polymarketOutcome?.entryOffset;
        if (typeof entryOffset !== "number" || !Number.isFinite(entryOffset)) {
            return null;
        }
        offsets.add(clampPolymarketEntryOffset(entryOffset));
        if (offsets.size > 1) {
            return null;
        }
    }

    return offsets.size === 1 ? [...offsets][0]! : null;
}

export function resolvePolymarketSelectedEntryOffset(
    result: BacktestResult,
    fallbackOffset?: number | null
): number {
    const summaryOffset = result.polymarketTradeSummary?.entryOffset;
    if (typeof summaryOffset === "number" && Number.isFinite(summaryOffset)) {
        return clampPolymarketEntryOffset(summaryOffset);
    }

    const inferredOffset = inferPolymarketEntryOffsetFromTrades(result.trades);
    if (inferredOffset !== null) {
        return inferredOffset;
    }

    if (typeof fallbackOffset === "number" && Number.isFinite(fallbackOffset)) {
        return clampPolymarketEntryOffset(fallbackOffset);
    }

    return 0;
}

export function rankPolymarketFeatureSuggestions(
    featureAnalyses: readonly PolymarketFeatureAnalysis[]
): PolymarketFeatureAnalysis[] {
    return featureAnalyses
        .filter((analysis) => analysis.suggestedFilter !== null)
        .slice()
        .sort((left, right) => {
            if (right.expectancyIfFiltered !== left.expectancyIfFiltered) {
                return right.expectancyIfFiltered - left.expectancyIfFiltered;
            }
            if (right.winRateIfFiltered !== left.winRateIfFiltered) {
                return right.winRateIfFiltered - left.winRateIfFiltered;
            }
            if (left.tradesRemovedPercent !== right.tradesRemovedPercent) {
                return left.tradesRemovedPercent - right.tradesRemovedPercent;
            }
            if (right.separationScore !== left.separationScore) {
                return right.separationScore - left.separationScore;
            }
            return left.label.localeCompare(right.label);
        });
}

export interface PolymarketPayoutDiagnosticsSummary {
    pricedTrades: number;
    unpricedScoredTrades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number | null;
    avgEntryPrice: number;
    breakEvenWinRate: number;
    edgeVsBreakEven: number;
}

export interface BacktestPolymarketPerformanceSummary {
    wins: number;
    losses: number;
    neutralTrades: number;
    scoredTrades: number;
    unscoredTrades: number;
    missingOutcomeTrades: number;
    scoredTradeShare: number;
    polymarketWinRate: number;
    polymarketExpectancy: number | null;
    polymarketProfitFactor: number | null;
    pricedTrades: number;
    unpricedScoredTrades: number;
    outcomeRowsLoaded: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
    entrySelectionMode?: PolymarketEntrySelectionMode;
    longestWinStreak: number;
    longestLossStreak: number;
    entryOffset?: number;
}

type PolymarketTradeOutcomeState = "positive" | "negative" | "neutral" | null;

function getPolymarketPricedTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => getPolymarketTradePayout(trade) !== null);
}

function getScoredPolymarketTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => (
        trade.polymarketOutcome !== null
        && trade.polymarketOutcome !== undefined
        && trade.polymarketOutcome.marketExitSource !== "duplicate"
        && trade.polymarketOutcome.marketExitSource !== "filtered"
        && trade.polymarketOutcome.marketExitSource !== "entry_price_filtered"
        && trade.polymarketOutcome.marketExitSource !== "no_event"
        && trade.polymarketOutcome.marketExitSource !== "missing"
    ));
}

function getPolymarketTradePayout(trade: Trade): number | null {
    const pm = trade.polymarketOutcome;
    if (!pm) return null;

    if (typeof pm.marketPnl === "number" && Number.isFinite(pm.marketPnl)) {
        return pm.marketPnl;
    }

    if (pm.evaluationMode === "signal_exit_same_event") {
        if (
            typeof pm.marketExitPrice === "number" && Number.isFinite(pm.marketExitPrice)
            && typeof pm.marketEntryPrice === "number" && Number.isFinite(pm.marketEntryPrice)
        ) {
            return pm.marketExitPrice - pm.marketEntryPrice;
        }
        return null;
    }

    const price = pm.marketEntryPrice;
    const isWin = pm.isWin;
    if (typeof price !== "number" || !Number.isFinite(price) || typeof isWin !== "boolean") {
        return null;
    }
    return isWin ? (1 - price) : -price;
}

function getPolymarketTradeOutcomeState(trade: Trade): PolymarketTradeOutcomeState {
    const payout = getPolymarketTradePayout(trade);
    if (payout === null) {
        return null;
    }
    if (payout > 0) {
        return "positive";
    }
    if (payout < 0) {
        return "negative";
    }
    return "neutral";
}

function average(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildPolymarketExpectancyRow(label: string, trades: readonly Trade[]): ExpectancyBreakdownRow {
    const payouts = trades
        .map((trade) => getPolymarketTradePayout(trade))
        .filter((value): value is number => value !== null);
    const entryPrices = trades
        .map((trade) => trade.polymarketOutcome?.marketEntryPrice)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const winningPayouts = payouts.filter((value) => value > 0);
    const losingPayouts = payouts.filter((value) => value < 0);
    const totalProfit = winningPayouts.reduce((sum, value) => sum + value, 0);
    const totalLoss = Math.abs(losingPayouts.reduce((sum, value) => sum + value, 0));
    const netProfit = payouts.reduce((sum, value) => sum + value, 0);
    const tradeCount = payouts.length;
    const avgEntryPrice = entryPrices.length > 0 ? average(entryPrices) : 0;
    const breakEvenWinRate = avgEntryPrice * 100;
    const winRate = tradeCount > 0 ? (winningPayouts.length / tradeCount) * 100 : 0;

    return {
        label,
        tradeCount,
        winRate,
        netProfit,
        expectancy: tradeCount > 0 ? netProfit / tradeCount : 0,
        avgWin: winningPayouts.length > 0 ? totalProfit / winningPayouts.length : 0,
        avgLoss: losingPayouts.length > 0 ? totalLoss / losingPayouts.length : 0,
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
        avgEntryPrice,
        breakEvenWinRate,
        edgeVsBreakEven: winRate - breakEvenWinRate,
    };
}

export function summarizePolymarketPayoutDiagnostics(
    trades: readonly Trade[]
): PolymarketPayoutDiagnosticsSummary | null {
    const scoredTrades = getScoredPolymarketTrades(trades);
    const pricedTrades = getPolymarketPricedTrades(trades);
    if (pricedTrades.length === 0) {
        return null;
    }

    const summaryRow = buildPolymarketExpectancyRow("All", pricedTrades);
    return {
        pricedTrades: summaryRow.tradeCount,
        unpricedScoredTrades: Math.max(0, scoredTrades.length - pricedTrades.length),
        winRate: summaryRow.winRate / 100,
        expectancy: summaryRow.expectancy,
        profitFactor: summaryRow.profitFactor,
        avgEntryPrice: summaryRow.avgEntryPrice ?? 0,
        breakEvenWinRate: (summaryRow.breakEvenWinRate ?? 0) / 100,
        edgeVsBreakEven: (summaryRow.edgeVsBreakEven ?? 0) / 100,
    };
}

export function summarizePolymarketStreaks(trades: readonly Trade[]): {
    longestWinStreak: number;
    longestLossStreak: number;
} {
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;

    for (const trade of trades) {
        const outcomeState = getPolymarketTradeOutcomeState(trade);
        if (outcomeState === "positive") {
            currentWinStreak++;
            currentLossStreak = 0;
            longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
            continue;
        }

        if (outcomeState === "negative") {
            currentLossStreak++;
            currentWinStreak = 0;
            longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
            continue;
        }

        currentWinStreak = 0;
        currentLossStreak = 0;
    }

    return {
        longestWinStreak,
        longestLossStreak,
    };
}

export function computePolymarketBestBaselineWinRate(trades: readonly Trade[]): number {
    const scoredTrades = getScoredPolymarketTrades(trades);
    if (scoredTrades.length === 0) {
        return 0;
    }

    const alwaysYesWins = scoredTrades.filter((trade) => trade.polymarketOutcome?.actualOutcomeUp === 1).length;
    const alwaysYesWinRate = alwaysYesWins / scoredTrades.length;
    const alwaysNoWinRate = 1 - alwaysYesWinRate;
    return Math.max(alwaysYesWinRate, alwaysNoWinRate);
}

export function countDistinctPolymarketOutcomeRows(trades: readonly Trade[]): number {
    const distinctEventStartTs = new Set<number>();
    for (const trade of trades) {
        const eventStartTs = trade.polymarketOutcome?.eventStartTs;
        if (typeof eventStartTs === "number" && Number.isFinite(eventStartTs) && eventStartTs > 0) {
            distinctEventStartTs.add(eventStartTs);
        }
    }
    return distinctEventStartTs.size;
}

function resolvePolymarketCoverageSummary(
    result: BacktestResult,
    summary: BacktestPolymarketTradeSummary | undefined,
    scoredTrades: number
): {
    unscoredTrades: number;
    missingOutcomeTrades: number;
    scoredTradeShare: number;
} {
    const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
    const missingOutcomeTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
    const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
    const coverageBase = Math.max(0, scoredTrades + unscoredTrades);

    return {
        unscoredTrades,
        missingOutcomeTrades,
        scoredTradeShare: coverageBase > 0 ? scoredTrades / coverageBase : 0,
    };
}

export function buildBacktestPolymarketPerformanceSummary(
    result: BacktestResult
): BacktestPolymarketPerformanceSummary | undefined {
    const summary = result.polymarketTradeSummary;
    const isSignalExit = summary?.evaluationMode === "signal_exit_same_event";

    const wins = isSignalExit
        ? (summary?.profitableTrades ?? result.trades.filter((trade) => trade.polymarketOutcome?.isProfitable === true).length)
        : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
    const losses = isSignalExit
        ? (summary?.losingTrades ?? result.trades.filter((trade) => trade.polymarketOutcome?.isProfitable === false).length)
        : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
    const neutralTrades = isSignalExit
        ? (summary?.neutralTrades ?? result.trades.filter((trade) => getPolymarketTradeOutcomeState(trade) === "neutral").length)
        : 0;
    const scoredTrades = isSignalExit ? (summary?.scoredTrades ?? wins + losses + neutralTrades) : wins + losses;

    if (!summary && scoredTrades === 0) {
        return undefined;
    }

    const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
    const streakSummary = summarizePolymarketStreaks(result.trades);
    const bestBaselineWinRate = isSignalExit ? 0 : computePolymarketBestBaselineWinRate(result.trades);
    const coverageSummary = resolvePolymarketCoverageSummary(result, summary, scoredTrades);

    const performance: BacktestPolymarketPerformanceSummary = {
        wins,
        losses,
        neutralTrades,
        scoredTrades,
        unscoredTrades: coverageSummary.unscoredTrades,
        missingOutcomeTrades: coverageSummary.missingOutcomeTrades,
        scoredTradeShare: coverageSummary.scoredTradeShare,
        polymarketWinRate: scoredTrades > 0 ? wins / scoredTrades : 0,
        polymarketExpectancy: isSignalExit
            ? (summary?.expectancy ?? payoutSummary?.expectancy ?? null)
            : payoutSummary?.expectancy ?? null,
        polymarketProfitFactor: isSignalExit
            ? (summary?.profitFactor ?? payoutSummary?.profitFactor ?? null)
            : payoutSummary?.profitFactor ?? null,
        pricedTrades: payoutSummary?.pricedTrades ?? 0,
        unpricedScoredTrades: payoutSummary?.unpricedScoredTrades ?? 0,
        outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
        bestBaselineWinRate,
        baselineDelta: isSignalExit ? 0 : (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
        longestWinStreak: streakSummary.longestWinStreak,
        longestLossStreak: streakSummary.longestLossStreak,
        entryOffset: summary?.entryOffset,
    };
    if (summary?.entrySelectionMode !== undefined) {
        performance.entrySelectionMode = summary.entrySelectionMode;
    }
    return performance;
}
