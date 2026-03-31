import {
    type Time,
    compareTime
} from "../strategies/index";
import {
    calculateSharpeRatioFromEquityCurve,
    calculateSharpeRatioFromReturns,
} from "../strategies/performance-metrics";
import type {
    EndpointSelectionAdjustment
} from '../types/index';

function calculateSelectionSharpe(
    trades: EndpointSelectionAdjustment["result"]["trades"],
    initialCapital: number
): number {
    let equity = initialCapital;
    const equityCurve: Array<{ time: Time; value: number }> = [];

    for (const trade of trades) {
        if (!Number.isFinite(trade.pnl)) continue;
        equity += trade.pnl;
        equityCurve.push({ time: trade.exitTime, value: equity });
    }

    if (equityCurve.length > 1) {
        return calculateSharpeRatioFromEquityCurve(equityCurve);
    }

    return calculateSharpeRatioFromReturns(trades.map((trade) => trade.pnlPercent));
}

/**
 * Endpoint Selection Adjustment
 * 
 * Removes trades that exit at the very last bar of the dataset to avoid 
 * look-ahead bias or incomplete trades that might skew results.
 */
export function buildSelectionResult(
    raw: EndpointSelectionAdjustment["result"],
    lastDataTime: Time | null,
    initialCapital: number
): EndpointSelectionAdjustment {
    const rawTrades = Array.isArray(raw.trades) ? raw.trades : [];
    if (lastDataTime === null || rawTrades.length === 0) {
        return { result: raw, adjusted: false, removedTrades: 0 };
    }

    const filteredTrades = [] as typeof rawTrades;
    let totalTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let netProfit = 0;

    for (const trade of rawTrades) {
        if (compareTime(trade.exitTime, lastDataTime) >= 0) {
            continue;
        }

        filteredTrades.push(trade);
        totalTrades++;
        netProfit += trade.pnl;

        if (trade.pnl > 0) {
            winningTrades++;
            totalProfit += trade.pnl;
        } else {
            losingTrades++;
            totalLoss += Math.abs(trade.pnl);
        }
    }

    const removedTrades = rawTrades.length - filteredTrades.length;
    if (removedTrades <= 0) {
        return { result: raw, adjusted: false, removedTrades: 0 };
    }

    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const lossRate = totalTrades > 0 ? losingTrades / totalTrades : 0;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    // Recompute Sharpe on an equity-curve basis so endpoint-adjusted Finder rows
    // stay on the same scale as the backtest engine and result panels.
    const sharpeRatio = calculateSelectionSharpe(filteredTrades, initialCapital);

    return {
        result: {
            ...raw,
            trades: filteredTrades,
            netProfit,
            netProfitPercent,
            winRate: winRate * 100,
            expectancy,
            avgTrade,
            profitFactor,
            totalTrades,
            winningTrades,
            losingTrades,
            avgWin,
            avgLoss,
            sharpeRatio
        },
        adjusted: true,
        removedTrades
    };
}


