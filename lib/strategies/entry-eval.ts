import type { BacktestResult, EntryStats } from '../types/strategies';

export function buildEntryBacktestResult(entryStats: EntryStats): BacktestResult {
    const totalEntries = entryStats.totalEntries;
    const wins = entryStats.wins;
    const losses = entryStats.losses;
    const winRate = totalEntries > 0 ? (wins / totalEntries) * 100 : 0;

    const profitFactor = losses > 0 ? wins / losses : wins > 0 ? Infinity : 0;
    const expectancy = totalEntries > 0 ? (wins - losses) / totalEntries : 0;

    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate,
        expectancy,
        avgTrade: expectancy,
        profitFactor,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: totalEntries,
        winningTrades: wins,
        losingTrades: losses,
        avgWin: wins > 0 ? 1 : 0,
        avgLoss: losses > 0 ? 1 : 0,
        sharpeRatio: 0,
        equityCurve: [],
        entryStats
    };
}



