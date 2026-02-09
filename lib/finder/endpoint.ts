import {
    type Time,
    compareTime
} from "../strategies/index";
import { calculateSharpeRatioFromReturns } from "../strategies/performance-metrics";
import type {
    EndpointSelectionAdjustment
} from '../types/index';

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
    if (lastDataTime === null || raw.trades.length === 0) {
        return { result: raw, adjusted: false, removedTrades: 0 };
    }

    const filteredTrades = raw.trades.filter(trade => compareTime(trade.exitTime, lastDataTime) < 0);
    const removedTrades = raw.trades.length - filteredTrades.length;
    if (removedTrades <= 0) {
        return { result: raw, adjusted: false, removedTrades: 0 };
    }

    const winningTrades = filteredTrades.filter(t => t.pnl > 0);
    const losingTrades = filteredTrades.filter(t => t.pnl <= 0);
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    const totalTrades = filteredTrades.length;

    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
    const winRate = totalTrades > 0 ? winningTrades.length / totalTrades : 0;
    const lossRate = totalTrades > 0 ? losingTrades.length / totalTrades : 0;
    const netProfit = filteredTrades.reduce((sum, t) => sum + t.pnl, 0);
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const returns = filteredTrades.map(t => t.pnlPercent);
    const sharpeRatio = calculateSharpeRatioFromReturns(returns);

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
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            avgWin,
            avgLoss,
            sharpeRatio
        },
        adjusted: true,
        removedTrades
    };
}


