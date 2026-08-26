import type { BacktestResult } from "../types/strategies";
import type { FinderMetric } from "../types/finder";

export function finderSortRequiresExitAlpha(sortPriority: readonly FinderMetric[]): boolean {
    return sortPriority.includes("exitAlpha");
}

/**
 * Exit Alpha is a percentage-point delta on the raw, full-window results.
 * Missing counterfactuals stay missing; they are never coerced to zero.
 */
export function computeExitAlpha(
    normalResult: Pick<BacktestResult, "netProfitPercent">,
    noStrategyExitResult: Pick<BacktestResult, "netProfitPercent">,
): number | undefined {
    const alpha = normalResult.netProfitPercent - noStrategyExitResult.netProfitPercent;
    return Number.isFinite(alpha) ? alpha : undefined;
}

export function filterStrategyExitSignals<T extends { exitOnly?: boolean }>(signals: readonly T[]): T[] {
    return signals.filter((signal) => signal.exitOnly !== true);
}
