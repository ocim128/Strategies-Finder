export function normalizePolymarketPriceFeedSymbolValue(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("PM:")) {
        return null;
    }

    const compact = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!compact) return null;

    for (const quote of ["USDT", "USD"]) {
        if (compact.endsWith(quote) && compact.length > quote.length) {
            return compact.slice(0, -quote.length);
        }
    }

    return compact;
}

export function normalizeUnderlyingPriceFeedSymbolValue(value: string): string | null {
    return normalizePolymarketPriceFeedSymbolValue(value);
}

export function getProviderScopedSeriesSymbol(
    symbol: string,
    provider: string,
    options: { isPolymarketEventSymbol?: boolean } = {}
): string {
    const normalized = symbol.trim().toUpperCase();
    const normalizedProvider = provider.trim().toLowerCase();

    if (options.isPolymarketEventSymbol) {
        return normalized;
    }

    if (normalizedProvider === "chainlink") {
        return `CHAINLINK:${normalized}`;
    }
    if (normalizedProvider === "polymarket") {
        return `POLYMARKET:${normalized}`;
    }
    return normalized;
}
