import type { ExecutionLabClosedPaperTrade } from "./execution-lab-model";

export interface ExecutionLabPerformanceMetrics {
    trades: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRatePct: number | null;
    totalPnlUsd: number;
    grossProfitUsd: number;
    grossLossUsd: number;
    profitFactor: number | null;
    expectancyUsd: number | null;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
}

export function computeExecutionLabPerformanceMetrics(
    trades: readonly Pick<ExecutionLabClosedPaperTrade, "pnlUsd">[]
): ExecutionLabPerformanceMetrics {
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let totalPnlUsd = 0;
    let grossProfitUsd = 0;
    let grossLossUsd = 0;

    for (const trade of trades) {
        const pnl = Number.isFinite(trade.pnlUsd) ? trade.pnlUsd : 0;
        totalPnlUsd += pnl;
        if (pnl > 0) {
            wins += 1;
            grossProfitUsd += pnl;
        } else if (pnl < 0) {
            losses += 1;
            grossLossUsd += Math.abs(pnl);
        } else {
            breakeven += 1;
        }
    }

    const count = trades.length;
    return {
        trades: count,
        wins,
        losses,
        breakeven,
        winRatePct: count > 0 ? (wins / count) * 100 : null,
        totalPnlUsd,
        grossProfitUsd,
        grossLossUsd,
        profitFactor: grossLossUsd > 0
            ? grossProfitUsd / grossLossUsd
            : grossProfitUsd > 0
                ? Number.POSITIVE_INFINITY
                : null,
        expectancyUsd: count > 0 ? totalPnlUsd / count : null,
        avgWinUsd: wins > 0 ? grossProfitUsd / wins : null,
        avgLossUsd: losses > 0 ? -(grossLossUsd / losses) : null,
    };
}

