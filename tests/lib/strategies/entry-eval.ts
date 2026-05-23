import type { BacktestDiagnostics, BacktestResult, EntryStats } from '../types/strategies';

type EntryBacktestDiagnosticsInput = {
    entryStats: EntryStats;
    inputBars: number;
    inputSignals: number;
    elapsedMs: number;
};

function roundEntryDiagnosticMs(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

export function buildEntryBacktestDiagnostics(input: EntryBacktestDiagnosticsInput): BacktestDiagnostics {
    const totalEntries = Math.max(0, input.entryStats.totalEntries);
    const elapsedMs = roundEntryDiagnosticMs(input.elapsedMs);
    return {
        counts: {
            inputBars: input.inputBars,
            evaluationBars: input.inputBars,
            inputSignals: input.inputSignals,
            preparedSignals: input.inputSignals,
            barsScanned: input.inputBars,
            barsWithPosition: 0,
            entriesAttempted: totalEntries,
            tradesOpened: totalEntries,
            tradesClosed: totalEntries,
            signalExitOrders: 0,
            forcedEndOfDataExits: 0,
            fastPathRuns: 0,
            maxOpenPositions: 0,
        },
        timingsMs: {
            total: elapsedMs,
            dataClean: 0,
            indicatorResolution: 0,
            signalPreparation: 0,
            signalIndexing: 0,
            entryEvaluation: elapsedMs,
            tradeSimulation: 0,
            forcedClose: 0,
            drawdown: 0,
            metrics: 0,
        },
    };
}

export function buildEntryBacktestResult(entryStats: EntryStats, diagnostics?: BacktestDiagnostics): BacktestResult {
    const totalEntries = entryStats.totalEntries;
    const wins = entryStats.wins;
    const losses = entryStats.losses;
    const winRate = totalEntries > 0 ? (wins / totalEntries) * 100 : 0;

    const profitFactor = losses > 0 ? wins / losses : wins > 0 ? Infinity : 0;
    const expectancy = totalEntries > 0 ? (wins - losses) / totalEntries : 0;

    const result: BacktestResult = {
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
    if (diagnostics) result.diagnostics = diagnostics;
    return result;
}



