import { state } from "./state";
import {
    getUnscopedBinanceStorageSymbol,
    isScopedBinanceFuturesStorageSymbol,
    resolveBinanceMarketType,
    type BinanceMarketType,
} from "./binance-market";
import type { BacktestResult } from "./types/strategies";

export type ResolvedBacktestResultMarketContext = {
    symbol: string;
    interval: string;
    binanceMarketType: BinanceMarketType;
};

export function resolveBacktestResultMarketContext(
    result: BacktestResult | null | undefined
): ResolvedBacktestResultMarketContext | null {
    if (!result) {
        return null;
    }

    const rawSymbol = typeof result.marketContext?.symbol === "string" && result.marketContext.symbol.trim().length > 0
        ? result.marketContext.symbol.trim().toUpperCase()
        : state.currentSymbol;
    const isFuturesStorageSymbol = isScopedBinanceFuturesStorageSymbol(rawSymbol);
    const symbol = isFuturesStorageSymbol ? getUnscopedBinanceStorageSymbol(rawSymbol) : rawSymbol;
    const interval = typeof result.marketContext?.interval === "string" && result.marketContext.interval.trim().length > 0
        ? result.marketContext.interval.trim()
        : state.currentInterval;
    const binanceMarketType = resolveBinanceMarketType(
        result.marketContext?.binanceMarketType,
        isFuturesStorageSymbol ? "futures" : state.binanceMarketType
    );

    return { symbol, interval, binanceMarketType };
}

export function backtestResultMatchesCurrentMarket(
    result: BacktestResult | null | undefined
): boolean {
    const context = resolveBacktestResultMarketContext(result);
    return Boolean(
        context
        && context.symbol === state.currentSymbol
        && context.interval === state.currentInterval
        && context.binanceMarketType === state.binanceMarketType
    );
}
