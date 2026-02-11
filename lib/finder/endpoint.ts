import {
    type Time,
    compareTime
} from "../strategies/index";
import { calculateSharpeRatioFromMoments } from "../strategies/performance-metrics";
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
    let returnCount = 0;
    let avgReturn = 0;
    let returnM2 = 0;

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

        if (Number.isFinite(trade.pnlPercent)) {
            returnCount++;
            const delta = trade.pnlPercent - avgReturn;
            avgReturn += delta / returnCount;
            returnM2 += delta * (trade.pnlPercent - avgReturn);
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

    const stdReturn = returnCount > 1 ? Math.sqrt(returnM2 / (returnCount - 1)) : 0;
    const sharpeRatio = calculateSharpeRatioFromMoments(avgReturn, stdReturn, returnCount);

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


