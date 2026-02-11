
import { BacktestResult, Time, Trade } from '../../types/index';
import { calculateSharpeRatioFromMoments, calculateSharpeRatioFromReturns } from '../performance-metrics';
import { directionFactorFor } from './backtest-utils';
import { PositionState } from '../../types/backtest';

/**
 * Calculates the maximum drawdown from an equity curve.
 */
export function calculateMaxDrawdown(equityCurve: { time: Time; value: number }[], initialCapital: number) {
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const point of equityCurve) {
        if (point.value > peak) peak = point.value;
        const drawdown = peak - point.value;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }
    }

    return { maxDrawdown, maxDrawdownPercent };
}

/**
 * Aggregates results into a final BacktestResult.
 */
export function calculateBacktestStats(
    trades: Trade[],
    equityCurve: { time: Time; value: number }[],
    initialCapital: number,
    finalCapital: number,
    maxDrawdown: number,
    maxDrawdownPercent: number
): BacktestResult {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((sum, t) => sum + t.pnl, 0));

    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const losingCount = trades.length - winningTrades.length;
    const avgLoss = losingCount > 0 ? totalLoss / losingCount : 0;

    const netProfit = finalCapital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) : 0;
    const lossRate = 1 - winRate;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = trades.length > 0 ? netProfit / trades.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const returns = trades.map(t => t.pnlPercent);
    const sharpeRatio = calculateSharpeRatioFromReturns(returns);

    return {
        trades,
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades: trades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingCount,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve
    };
}

/**
 * Finalizes metrics for the compact version (no Trade objects created).
 */
export function finalizeBacktestMetrics(
    initialCapital: number,
    capital: number,
    totalTrades: number,
    winningTrades: number,
    totalProfit: number,
    totalLoss: number,
    avgReturn: number,
    returnM2: number,
    maxDrawdown: number,
    maxDrawdownPercent: number
): Partial<BacktestResult> {
    const netProfit = capital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) : 0;
    const lossRate = totalTrades > 0 ? ((totalTrades - winningTrades) / totalTrades) : 0;
    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = (totalTrades - winningTrades) > 0 ? totalLoss / (totalTrades - winningTrades) : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const stdReturn = totalTrades > 1 ? Math.sqrt(returnM2 / (totalTrades - 1)) : 0;
    const sharpeRatio = calculateSharpeRatioFromMoments(avgReturn, stdReturn, totalTrades);

    return {
        trades: [],
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades,
        winningTrades,
        losingTrades: totalTrades - winningTrades,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve: []
    };
}

/**
 * Shared logic for calculating trade exit details.
 */
export function calculateTradeExitDetails(
    position: PositionState,
    exitPrice: number,
    exitSize: number,
    commissionRate: number
) {
    const directionFactor = directionFactorFor(position.direction);
    const size = Math.min(exitSize, position.size);
    const exitValue = size * exitPrice;
    const entryValue = size * position.entryPrice;
    const commission = exitValue * commissionRate;
    const entryCommission = position.entryCommissionPerShare * size;

    const rawPnl = (exitValue - entryValue) * directionFactor;
    const totalPnl = rawPnl - entryCommission - commission;
    const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

    return {
        size,
        totalPnl,
        pnlPercent,
        commission,
        entryCommission,
        rawPnl,
        fees: entryCommission + commission
    };
}

/**
 * Returns a BacktestResult with zero/empty values.
 */
export function createEmptyBacktestResult(): BacktestResult {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: []
    };
}
