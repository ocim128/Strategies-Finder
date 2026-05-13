import {
    getPolymarketSeriesIdForSymbol,
} from "../polymarket-btc5m";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    type PolymarketOutcomeInterval,
} from "../polymarket-outcome-interval";
import {
    SECOND_MARKET_SYMBOLS,
    type SecondMarketReferenceSource,
    type SecondMarketSymbol,
} from "./types";

const SECOND_MARKET_SYMBOL_SET = new Set<string>(SECOND_MARKET_SYMBOLS);

export const SECOND_MARKET_REFERENCE_SYMBOLS: Record<
    SecondMarketSymbol,
    Record<SecondMarketReferenceSource, string>
> = {
    BTCUSDT: {
        crypto_prices: "btcusdt",
        crypto_prices_chainlink: "btc/usd",
    },
    XRPUSDT: {
        crypto_prices: "xrpusdt",
        crypto_prices_chainlink: "xrp/usd",
    },
};

export function normalizeSecondMarketSymbol(value: unknown): SecondMarketSymbol | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase();
    return SECOND_MARKET_SYMBOL_SET.has(normalized)
        ? normalized as SecondMarketSymbol
        : null;
}

export function parseSecondMarketSymbolList(value: unknown): SecondMarketSymbol[] {
    if (Array.isArray(value)) {
        const out = value
            .map((item) => normalizeSecondMarketSymbol(String(item ?? "")))
            .filter((symbol): symbol is SecondMarketSymbol => symbol !== null);
        return Array.from(new Set(out));
    }
    if (typeof value !== "string" || value.trim() === "") {
        return [...SECOND_MARKET_SYMBOLS];
    }
    const out = value
        .split(",")
        .map((item) => normalizeSecondMarketSymbol(item))
        .filter((symbol): symbol is SecondMarketSymbol => symbol !== null);
    return Array.from(new Set(out));
}

export function getSecondMarketSeriesId(
    symbol: SecondMarketSymbol,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL
): string {
    const seriesId = getPolymarketSeriesIdForSymbol(symbol, outcomeInterval);
    if (!seriesId) {
        throw new Error(`No Polymarket series id configured for ${symbol} ${outcomeInterval}.`);
    }
    return seriesId;
}

export function getReferenceSourceSymbol(
    symbol: SecondMarketSymbol,
    referenceSource: SecondMarketReferenceSource
): string {
    return SECOND_MARKET_REFERENCE_SYMBOLS[symbol][referenceSource];
}

export function getSymbolForReferenceSourceSymbol(
    sourceSymbol: string,
    referenceSource: SecondMarketReferenceSource
): SecondMarketSymbol | null {
    const normalized = sourceSymbol.trim().toLowerCase();
    for (const symbol of SECOND_MARKET_SYMBOLS) {
        if (SECOND_MARKET_REFERENCE_SYMBOLS[symbol][referenceSource] === normalized) {
            return symbol;
        }
    }
    return null;
}

