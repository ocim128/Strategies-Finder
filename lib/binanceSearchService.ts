/**
 * Binance Symbol Search Service
 * Provides functionality to search and fetch trading pairs from Binance
 */

export interface BinanceSymbol {
    symbol: string;          // e.g., "ETHUSDT"
    baseAsset: string;       // e.g., "ETH"
    quoteAsset: string;      // e.g., "USDT"
    displayName: string;     // e.g., "ETH/USDT"
    status: string;          // e.g., "TRADING"
}

interface BinanceExchangeInfoSymbol {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
}

interface BinanceExchangeInfoResponse {
    symbols: BinanceExchangeInfoSymbol[];
}

class BinanceSearchService {
    private readonly EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
    private readonly CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes cache

    private symbolsCache: BinanceSymbol[] = [];
    private cacheTimestamp = 0;
    private isLoading = false;
    private loadingPromise: Promise<BinanceSymbol[]> | null = null;

    /**
     * Get all available trading symbols from Binance
     */
    async getAllSymbols(): Promise<BinanceSymbol[]> {
        const now = Date.now();

        // Return cached data if still valid
        if (this.symbolsCache.length > 0 && (now - this.cacheTimestamp) < this.CACHE_DURATION_MS) {
            return this.symbolsCache;
        }

        // If already loading, wait for the existing promise
        if (this.isLoading && this.loadingPromise) {
            return this.loadingPromise;
        }

        this.isLoading = true;
        this.loadingPromise = this.fetchExchangeInfo();

        try {
            this.symbolsCache = await this.loadingPromise;
            this.cacheTimestamp = now;
        } finally {
            this.isLoading = false;
            this.loadingPromise = null;
        }

        return this.symbolsCache;
    }

    /**
     * Fetch exchange info from Binance API
     */
    private async fetchExchangeInfo(): Promise<BinanceSymbol[]> {
        try {
            const response = await fetch(this.EXCHANGE_INFO_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data: BinanceExchangeInfoResponse = await response.json();

            return data.symbols
                .filter(s => s.status === 'TRADING')
                .map(s => ({
                    symbol: s.symbol,
                    baseAsset: s.baseAsset,
                    quoteAsset: s.quoteAsset,
                    displayName: `${s.baseAsset}/${s.quoteAsset}`,
                    status: s.status
                }))
                .sort((a, b) => {
                    // Prioritize USDT pairs, then BTC pairs
                    const aUSDT = a.quoteAsset === 'USDT' ? 0 : 1;
                    const bUSDT = b.quoteAsset === 'USDT' ? 0 : 1;
                    if (aUSDT !== bUSDT) return aUSDT - bUSDT;
                    return a.symbol.localeCompare(b.symbol);
                });
        } catch (error) {
            console.error('Failed to fetch Binance exchange info:', error);
            return [];
        }
    }

    /**
     * Search for symbols matching the query
     */
    async searchSymbols(query: string, limit = 50): Promise<BinanceSymbol[]> {
        const symbols = await this.getAllSymbols();

        if (!query.trim()) {
            // Return popular pairs when no query
            return this.getPopularPairs(symbols, limit);
        }

        const searchTerm = query.toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Score each symbol based on relevance
        const scored = symbols.map(s => {
            let score = 0;
            const sym = s.symbol.toUpperCase();
            const base = s.baseAsset.toUpperCase();
            const quote = s.quoteAsset.toUpperCase();

            // Exact match gets highest score
            if (sym === searchTerm) score += 1000;

            // Symbol starts with query
            if (sym.startsWith(searchTerm)) score += 100;

            // Base asset exact match
            if (base === searchTerm) score += 80;

            // Base asset starts with query
            if (base.startsWith(searchTerm)) score += 60;

            // Quote asset matches
            if (quote === searchTerm) score += 40;
            if (quote.startsWith(searchTerm)) score += 20;

            // Symbol contains query
            if (sym.includes(searchTerm)) score += 10;

            // USDT pairs get bonus
            if (quote === 'USDT') score += 5;

            return { symbol: s, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.symbol);
    }

    /**
     * Get popular/common trading pairs
     */
    private getPopularPairs(symbols: BinanceSymbol[], limit: number): BinanceSymbol[] {
        const popularBases = [
            'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOT',
            'MATIC', 'LINK', 'ATOM', 'LTC', 'UNI', 'DOGE', 'SHIB',
            'OP', 'ARB', 'SUI', 'APT', 'INJ'
        ];

        const popular: BinanceSymbol[] = [];

        // First, add USDT pairs for popular assets
        for (const base of popularBases) {
            const pair = symbols.find(s => s.baseAsset === base && s.quoteAsset === 'USDT');
            if (pair && popular.length < limit) {
                popular.push(pair);
            }
        }

        // Fill remaining slots with other USDT pairs
        for (const sym of symbols) {
            if (sym.quoteAsset === 'USDT' && !popular.includes(sym) && popular.length < limit) {
                popular.push(sym);
            }
        }

        return popular;
    }

    /**
     * Check if a symbol is valid (exists on Binance)
     */
    async isValidSymbol(symbol: string): Promise<boolean> {
        const symbols = await this.getAllSymbols();
        return symbols.some(s => s.symbol === symbol.toUpperCase());
    }

    /**
     * Get symbol info
     */
    async getSymbolInfo(symbol: string): Promise<BinanceSymbol | null> {
        const symbols = await this.getAllSymbols();
        return symbols.find(s => s.symbol === symbol.toUpperCase()) || null;
    }
}

export const binanceSearchService = new BinanceSearchService();
