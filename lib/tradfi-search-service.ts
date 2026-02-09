import tradFiPairsRaw from '../archive/tradfi-pair.txt?raw';

export type TradFiAssetType = 'stock' | 'forex' | 'commodity';

export interface TradFiSymbol {
    symbol: string;
    displayName: string;
    type: TradFiAssetType;
    lookupKey: string;
    aliases: string[];
}

const FX_CODES = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CHF', 'CAD', 'SGD', 'CNH',
    'NOK', 'SEK', 'DKK', 'HUF', 'PLN', 'CZK', 'TRY', 'ZAR', 'MXN', 'HKD',
]);

const COMMODITY_SYMBOLS = new Set([
    'XAUUSD', 'XAGUSD', 'WTIUSD', 'BRENT', 'UKOIL', 'USOIL', 'NATGAS',
]);

const POPULAR_TRADFI_KEYS = [
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META',
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD',
    'XAUUSD', 'XAGUSD', 'WTIUSD', 'CHINA50',
];

function decodeEscapes(value: string): string {
    return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16))
    );
}

function cleanSymbol(value: string): string {
    return decodeEscapes(value).trim();
}

function normalizeSymbol(value: string): string {
    return cleanSymbol(value).toUpperCase();
}

function normalizeLookupKey(symbol: string): string {
    let normalized = normalizeSymbol(symbol).replace(/\//g, '');
    if (normalized.endsWith('.S')) {
        normalized = normalized.slice(0, -2);
    }
    if (normalized.endsWith('+')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

function normalizeSearchTerm(value: string): string {
    return normalizeSymbol(value).replace(/[^A-Z0-9]/g, '');
}

function inferAssetType(symbol: string, lookupKey: string): TradFiAssetType {
    if (lookupKey.startsWith('XAU') || lookupKey.startsWith('XAG')) {
        return 'commodity';
    }

    if (COMMODITY_SYMBOLS.has(lookupKey)) {
        return 'commodity';
    }

    const isForexKey = lookupKey.length === 6
        && FX_CODES.has(lookupKey.slice(0, 3))
        && FX_CODES.has(lookupKey.slice(3, 6));
    if (isForexKey) {
        return 'forex';
    }

    if (symbol.includes('/') || symbol.endsWith('+')) {
        const compact = lookupKey.replace(/[^A-Z]/g, '');
        if (compact.length === 6 && FX_CODES.has(compact.slice(0, 3)) && FX_CODES.has(compact.slice(3, 6))) {
            return 'forex';
        }
    }

    return 'stock';
}

function formatDisplayName(symbol: string, lookupKey: string, type: TradFiAssetType): string {
    if (type === 'commodity' && lookupKey.length === 6) {
        return `${lookupKey.slice(0, 3)}/${lookupKey.slice(3, 6)}`;
    }
    if (type === 'forex' && lookupKey.length === 6) {
        return `${lookupKey.slice(0, 3)}/${lookupKey.slice(3, 6)}`;
    }
    if (type === 'commodity') {
        if (lookupKey === 'XAUUSD') return 'Gold / US Dollar';
        if (lookupKey === 'XAGUSD') return 'Silver / US Dollar';
        if (lookupKey === 'WTIUSD') return 'WTI Crude / US Dollar';
    }
    return symbol;
}

class TradFiSearchService {
    private readonly symbols: TradFiSymbol[];
    private readonly byLookupKey: Map<string, TradFiSymbol>;
    private readonly byAlias: Map<string, TradFiSymbol>;

    constructor() {
        this.symbols = this.parseSymbols(tradFiPairsRaw);
        this.byLookupKey = new Map();
        this.byAlias = new Map();
        const addAlias = (alias: string, symbol: TradFiSymbol) => {
            this.byAlias.set(alias, symbol);
            this.byAlias.set(alias.toUpperCase(), symbol);
        };

        for (const symbol of this.symbols) {
            this.byLookupKey.set(symbol.lookupKey, symbol);
            addAlias(symbol.symbol, symbol);
            addAlias(symbol.lookupKey, symbol);

            for (const alias of symbol.aliases) {
                addAlias(alias, symbol);
            }

            if (symbol.type === 'forex' && symbol.lookupKey.length === 6) {
                const slash = `${symbol.lookupKey.slice(0, 3)}/${symbol.lookupKey.slice(3, 6)}`;
                addAlias(slash, symbol);
            }
        }
    }

    private parseSymbols(raw: string): TradFiSymbol[] {
        const deduped = new Map<string, string>();
        const lines = raw
            .split(/\r?\n/)
            .map(cleanSymbol)
            .filter(Boolean);

        for (const line of lines) {
            const key = line.toUpperCase();
            if (!deduped.has(key)) {
                deduped.set(key, line);
            }
        }

        return Array.from(deduped.values())
            .map(symbol => {
                const lookupKey = normalizeLookupKey(symbol);
                const aliases = [symbol];
                const type = inferAssetType(symbol, lookupKey);
                return {
                    symbol,
                    displayName: formatDisplayName(symbol, lookupKey, type),
                    type,
                    lookupKey,
                    aliases,
                };
            })
            .sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    getAllSymbols(): TradFiSymbol[] {
        return [...this.symbols];
    }

    getPopularSymbols(limit = 30): TradFiSymbol[] {
        const results: TradFiSymbol[] = [];
        const seen = new Set<string>();

        for (const key of POPULAR_TRADFI_KEYS) {
            const symbol = this.byLookupKey.get(key);
            if (!symbol) continue;
            seen.add(symbol.lookupKey);
            results.push(symbol);
            if (results.length >= limit) return results;
        }

        for (const symbol of this.symbols) {
            if (seen.has(symbol.lookupKey)) continue;
            seen.add(symbol.lookupKey);
            results.push(this.byLookupKey.get(symbol.lookupKey) || symbol);
            if (results.length >= limit) break;
        }

        return results;
    }

    searchSymbols(query: string, limit = 50): TradFiSymbol[] {
        if (!query.trim()) {
            return this.getPopularSymbols(limit);
        }

        const term = normalizeSearchTerm(query);
        if (!term) {
            return this.getPopularSymbols(limit);
        }
        const queryUpper = normalizeSymbol(query);

        const scored = this.symbols.map(symbol => {
            let score = 0;
            const rawSymbol = symbol.symbol;
            const rawSearchable = normalizeSearchTerm(rawSymbol);
            const lookupSearchable = normalizeSearchTerm(symbol.lookupKey);
            const display = normalizeSymbol(symbol.displayName);

            if (rawSearchable === term || lookupSearchable === term) score += 1000;
            if (rawSearchable.startsWith(term) || lookupSearchable.startsWith(term)) score += 120;
            if (rawSearchable.includes(term) || lookupSearchable.includes(term)) score += 55;
            if (display.startsWith(queryUpper)) score += 50;
            if (display.includes(queryUpper)) score += 20;
            if (symbol.aliases.some(alias => normalizeSearchTerm(alias) === term)) score += 80;
            if (symbol.type === 'stock') score += 5;

            return { symbol, score };
        });

        return scored
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(item => item.symbol);
    }

    isTradFiSymbol(symbol: string): boolean {
        const normalized = normalizeSymbol(symbol);
        if (!normalized) return false;
        return this.byAlias.has(normalized) || this.byLookupKey.has(normalizeLookupKey(normalized));
    }

    getSymbolInfo(symbol: string): TradFiSymbol | null {
        const normalized = normalizeSymbol(symbol);
        if (!normalized) return null;
        return this.byAlias.get(normalized)
            || this.byLookupKey.get(normalizeLookupKey(normalized))
            || null;
    }
}

export const tradfiSearchService = new TradFiSearchService();
