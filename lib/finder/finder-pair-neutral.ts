import type { CapitalSettings } from "../types/backtest";
import type { BacktestResult, Trade } from "../types/strategies";
import { calculateSharpeRatioFromReturns, estimatePeriodsPerYear } from "../strategies/performance-metrics";
import { parseSyntheticPairToken } from "../synthetic-pair-token";

/** Metrics used by Finder for synthetic ratios so BASE/QUOTE and QUOTE/BASE
 * are scored on the same multiplicative return scale. */
export type FinderPairNeutralMetrics = Pick<BacktestResult,
    | "netProfit"
    | "netProfitPercent"
    | "winRate"
    | "expectancy"
    | "avgTrade"
    | "profitFactor"
    | "maxDrawdown"
    | "maxDrawdownPercent"
    | "totalTrades"
    | "winningTrades"
    | "losingTrades"
    | "avgWin"
    | "avgLoss"
    | "sharpeRatio"
>;

export const FINDER_PAIR_NEUTRAL_METRIC_BASIS = "pair_neutral_log" as const;

export function isSyntheticPairFinderSymbol(symbol: string): boolean {
    return parseSyntheticPairToken(symbol) !== null;
}

function resolveTradeMultiplier(trade: Trade): number {
    if (!(trade.entryPrice > 0) || !(trade.exitPrice > 0)) return NaN;
    return trade.type === "short"
        ? trade.entryPrice / trade.exitPrice
        : trade.exitPrice / trade.entryPrice;
}

/**
 * Convert executed trades into inversion-symmetric Finder metrics.
 *
 * A ratio long from p0 to p1 and its reciprocal short from 1/p0 to 1/p1
 * both produce log(p1 / p0). Commission is charged symmetrically per side.
 * The returned cash values use the caller's capital/sizing configuration, but
 * the trade return and Sharpe inputs are based on log returns rather than the
 * raw ratio's absolute price.
 */
export function buildFinderPairNeutralMetrics(
    result: BacktestResult,
    capital: CapitalSettings,
): FinderPairNeutralMetrics | null {
    if (result.totalTrades <= 0 || result.trades.length !== result.totalTrades) {
        return null;
    }

    const commissionRate = Math.max(0, capital.commission) / 100;
    const positionFraction = Math.max(0, capital.positionSize) / 100;
    const initialCapital = Math.max(0, capital.initialCapital);
    const tradePnls: number[] = [];
    const logReturnsPct: number[] = [];
    let neutralCapital = initialCapital;
    let peakCapital = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const trade of result.trades) {
        const multiplier = resolveTradeMultiplier(trade);
        if (!(multiplier > 0) || !Number.isFinite(multiplier)) return null;

        // The executor charges commission on both the entry and exit
        // notionals. Applying that exact cash adjustment keeps the reciprocal
        // pair symmetric while avoiding a price-dependent fee approximation.
        const netMultiplier = multiplier - (commissionRate * (1 + multiplier));
        if (!(netMultiplier > 0) || !Number.isFinite(netMultiplier)) return null;
        const logReturn = Math.log(netMultiplier);
        const simpleReturn = netMultiplier - 1;
        if (!Number.isFinite(simpleReturn)) return null;

        let allocation: number;
        if (capital.sizingMode === "percent") {
            allocation = neutralCapital * positionFraction;
        } else {
            const notional = Math.abs(trade.size * trade.entryPrice);
            allocation = notional > 0
                ? notional
                : Math.max(0, capital.fixedTradeAmount);
        }

        const neutralPnl = allocation * simpleReturn;
        if (!Number.isFinite(neutralPnl)) return null;
        neutralCapital += neutralPnl;
        if (!Number.isFinite(neutralCapital)) return null;

        tradePnls.push(neutralPnl);
        logReturnsPct.push(logReturn * 100);

        if (neutralCapital > peakCapital) peakCapital = neutralCapital;
        const drawdown = peakCapital - neutralCapital;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peakCapital > 0 ? (drawdown / peakCapital) * 100 : 0;
        }
    }

    const totalTrades = tradePnls.length;
    const winningTrades = tradePnls.filter((pnl) => pnl > 0).length;
    const losingTrades = totalTrades - winningTrades;
    const totalProfit = tradePnls.reduce((sum, pnl) => sum + (pnl > 0 ? pnl : 0), 0);
    const totalLoss = tradePnls.reduce((sum, pnl) => sum + (pnl < 0 ? Math.abs(pnl) : 0), 0);
    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const lossRate = totalTrades > 0 ? losingTrades / totalTrades : 0;
    const netProfit = neutralCapital - initialCapital;

    const tradeTimeSamples = result.trades.map((trade) => ({ time: trade.exitTime }));
    const periodsPerYear = estimatePeriodsPerYear(tradeTimeSamples);

    return {
        netProfit,
        netProfitPercent: initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0,
        winRate: winRate * 100,
        expectancy: (winRate * avgWin) - (lossRate * avgLoss),
        avgTrade: totalTrades > 0 ? netProfit / totalTrades : 0,
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades,
        winningTrades,
        losingTrades,
        avgWin,
        avgLoss,
        sharpeRatio: calculateSharpeRatioFromReturns(logReturnsPct, periodsPerYear),
    };
}
