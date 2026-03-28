import { state } from "./state";
import type { BacktestResult } from "./types/strategies";

export type ResolvedBacktestResultMarketContext = {
    symbol: string;
    interval: string;
};

export function resolveBacktestResultMarketContext(
    result: BacktestResult | null | undefined
): ResolvedBacktestResultMarketContext | null {
    if (!result) {
        return null;
    }

    const symbol = typeof result.marketContext?.symbol === "string" && result.marketContext.symbol.trim().length > 0
        ? result.marketContext.symbol.trim().toUpperCase()
        : state.currentSymbol;
    const interval = typeof result.marketContext?.interval === "string" && result.marketContext.interval.trim().length > 0
        ? result.marketContext.interval.trim()
        : state.currentInterval;

    return { symbol, interval };
}

export function backtestResultMatchesCurrentMarket(
    result: BacktestResult | null | undefined
): boolean {
    const context = resolveBacktestResultMarketContext(result);
    return Boolean(
        context
        && context.symbol === state.currentSymbol
        && context.interval === state.currentInterval
    );
}
