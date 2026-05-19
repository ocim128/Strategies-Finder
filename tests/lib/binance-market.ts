export type BinanceMarketType = "spot" | "futures";
export type BinanceDataProvider = "binance" | "binance-futures";

const BINANCE_FUTURES_STORAGE_PREFIX = "BINANCE-FUTURES:";

export function isBinanceMarketType(value: unknown): value is BinanceMarketType {
    return value === "spot" || value === "futures";
}

export function resolveBinanceMarketType(value: unknown, fallback: BinanceMarketType = "spot"): BinanceMarketType {
    return isBinanceMarketType(value) ? value : fallback;
}

export function getBinanceProviderForMarketType(marketType: BinanceMarketType): BinanceDataProvider {
    return marketType === "futures" ? "binance-futures" : "binance";
}

export function getBinanceMarketTypeForProvider(provider: BinanceDataProvider): BinanceMarketType {
    return provider === "binance-futures" ? "futures" : "spot";
}

export function isBinanceDataProvider(provider: string): provider is BinanceDataProvider {
    return provider === "binance" || provider === "binance-futures";
}

export function getBinanceMarketLabel(marketType: BinanceMarketType): string {
    return marketType === "futures" ? "Binance Futures" : "Binance Spot";
}

export function getScopedBinanceStorageSymbol(symbol: string, marketType: BinanceMarketType): string {
    const normalizedSymbol = getUnscopedBinanceStorageSymbol(symbol);
    if (!normalizedSymbol) return normalizedSymbol;
    return marketType === "futures" ? `${BINANCE_FUTURES_STORAGE_PREFIX}${normalizedSymbol}` : normalizedSymbol;
}

export function isScopedBinanceFuturesStorageSymbol(symbol: string): boolean {
    return symbol.trim().toUpperCase().startsWith(BINANCE_FUTURES_STORAGE_PREFIX);
}

export function getUnscopedBinanceStorageSymbol(symbol: string): string {
    let normalizedSymbol = symbol.trim().toUpperCase();
    while (normalizedSymbol.startsWith(BINANCE_FUTURES_STORAGE_PREFIX)) {
        normalizedSymbol = normalizedSymbol.slice(BINANCE_FUTURES_STORAGE_PREFIX.length);
    }
    return normalizedSymbol;
}
