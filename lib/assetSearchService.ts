/**
 * Asset Search Service - Unified search across multiple providers
 * Supports Binance (Crypto), Twelve Data (Stocks, Forex, Commodities)
 */

import { binanceSearchService, BinanceSymbol } from './binanceSearchService';

export type AssetType = 'crypto' | 'stock' | 'forex' | 'commodity';

export interface Asset {
    symbol: string;          // e.g., "AAPL", "ETHUSDT", "EURUSD"
    displayName: string;     // e.g., "Apple Inc.", "ETH/USDT"
    type: AssetType;         // Asset classification
    provider: 'binance' | 'twelvedata' | 'mock';  // Data source
    baseAsset?: string;      // e.g., "ETH" for crypto
    quoteAsset?: string;     // e.g., "USDT" for crypto
}

// Popular non-crypto assets
const POPULAR_ASSETS: Asset[] = [
    // US Stocks
    { symbol: 'AAPL', displayName: 'Apple Inc.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'MSFT', displayName: 'Microsoft Corp.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'GOOGL', displayName: 'Alphabet Inc.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'AMZN', displayName: 'Amazon.com Inc.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'TSLA', displayName: 'Tesla Inc.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'NVDA', displayName: 'NVIDIA Corp.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'META', displayName: 'Meta Platforms Inc.', type: 'stock', provider: 'twelvedata' },
    { symbol: 'JPM', displayName: 'JPMorgan Chase', type: 'stock', provider: 'twelvedata' },

    // Forex Majors
    { symbol: 'EUR/USD', displayName: 'Euro / US Dollar', type: 'forex', provider: 'twelvedata' },
    { symbol: 'GBP/USD', displayName: 'British Pound / US Dollar', type: 'forex', provider: 'twelvedata' },
    { symbol: 'USD/JPY', displayName: 'US Dollar / Japanese Yen', type: 'forex', provider: 'twelvedata' },
    { symbol: 'AUD/USD', displayName: 'Australian Dollar / US Dollar', type: 'forex', provider: 'twelvedata' },

    // Commodities
    { symbol: 'XAUUSD', displayName: 'Gold / US Dollar', type: 'commodity', provider: 'twelvedata' },
    { symbol: 'XAGUSD', displayName: 'Silver / US Dollar', type: 'commodity', provider: 'twelvedata' },
    { symbol: 'WTIUSD', displayName: 'Crude Oil WTI / US Dollar', type: 'commodity', provider: 'twelvedata' },
];

class AssetSearchService {
    /**
     * Search for assets across all providers
     */
    async searchAssets(query: string, limit = 50): Promise<Asset[]> {
        if (!query.trim()) {
            return this.getPopularAssets(limit);
        }

        const results: Asset[] = [];
        const searchTerm = query.toUpperCase();

        // Search Binance (crypto)
        try {
            const binanceResults = await binanceSearchService.searchSymbols(query, Math.floor(limit / 2));
            const cryptoAssets = binanceResults.map((b: BinanceSymbol) => ({
                symbol: b.symbol,
                displayName: b.displayName,
                type: 'crypto' as AssetType,
                provider: 'binance' as const,
                baseAsset: b.baseAsset,
                quoteAsset: b.quoteAsset,
            }));
            results.push(...cryptoAssets);
        } catch (error) {
            console.warn('Binance search failed:', error);
        }

        // Search popular assets (stocks, forex, commodities)
        const matchingPopular = POPULAR_ASSETS.filter(asset => {
            const sym = asset.symbol.toUpperCase();
            const name = asset.displayName.toUpperCase();
            return sym.includes(searchTerm) || name.includes(searchTerm);
        });
        results.push(...matchingPopular);

        // Score and sort by relevance
        const scored = results.map(asset => {
            let score = 0;
            const sym = asset.symbol.toUpperCase();
            const name = asset.displayName.toUpperCase();

            // Exact match gets highest score
            if (sym === searchTerm) score += 1000;

            // Symbol starts with query
            if (sym.startsWith(searchTerm)) score += 100;

            // Display name starts with query
            if (name.startsWith(searchTerm)) score += 80;

            // Symbol contains query
            if (sym.includes(searchTerm)) score += 50;

            // Display name contains query
            if (name.includes(searchTerm)) score += 20;

            // Prioritize stocks and popular assets
            if (asset.type === 'stock') score += 5;
            if (asset.type === 'crypto' && asset.quoteAsset === 'USDT') score += 3;

            return { asset, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.asset);
    }

    /**
     * Get popular assets when no search query is provided
     */
    private getPopularAssets(limit: number): Asset[] {
        const popular: Asset[] = [];

        // Add top crypto pairs from Binance
        const topCrypto: Asset[] = [
            { symbol: 'BTCUSDT', displayName: 'BTC/USDT', type: 'crypto', provider: 'binance', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'ETHUSDT', displayName: 'ETH/USDT', type: 'crypto', provider: 'binance', baseAsset: 'ETH', quoteAsset: 'USDT' },
            { symbol: 'BNBUSDT', displayName: 'BNB/USDT', type: 'crypto', provider: 'binance', baseAsset: 'BNB', quoteAsset: 'USDT' },
            { symbol: 'SOLUSDT', displayName: 'SOL/USDT', type: 'crypto', provider: 'binance', baseAsset: 'SOL', quoteAsset: 'USDT' },
            { symbol: 'XRPUSDT', displayName: 'XRP/USDT', type: 'crypto', provider: 'binance', baseAsset: 'XRP', quoteAsset: 'USDT' },
        ];

        // Interleave crypto and traditional assets
        popular.push(...topCrypto.slice(0, Math.min(5, limit)));
        popular.push(...POPULAR_ASSETS.slice(0, Math.min(limit - popular.length, POPULAR_ASSETS.length)));

        return popular.slice(0, limit);
    }

    /**
     * Check if a symbol is valid
     */
    async isValidAsset(symbol: string): Promise<boolean> {
        // Check if it's a known popular asset
        if (POPULAR_ASSETS.some(a => a.symbol === symbol)) {
            return true;
        }

        // Check Binance
        try {
            const isValidOnBinance = await binanceSearchService.isValidSymbol(symbol);
            if (isValidOnBinance) return true;
        } catch (error) {
            // Continue to other checks
        }

        return false;
    }

    /**
     * Get asset info
     */
    async getAssetInfo(symbol: string): Promise<Asset | null> {
        // Check popular assets first
        const popularAsset = POPULAR_ASSETS.find(a => a.symbol === symbol);
        if (popularAsset) return popularAsset;

        // Check Binance
        try {
            const binanceInfo = await binanceSearchService.getSymbolInfo(symbol);
            if (binanceInfo) {
                return {
                    symbol: binanceInfo.symbol,
                    displayName: binanceInfo.displayName,
                    type: 'crypto',
                    provider: 'binance',
                    baseAsset: binanceInfo.baseAsset,
                    quoteAsset: binanceInfo.quoteAsset,
                };
            }
        } catch (error) {
            // Continue
        }

        return null;
    }

    /**
     * Determine asset type from symbol
     */
    getAssetType(symbol: string): AssetType {
        const asset = POPULAR_ASSETS.find(a => a.symbol === symbol);
        if (asset) return asset.type;

        // Heuristics
        if (symbol.includes('USD') && !symbol.includes('/')) return 'crypto'; // e.g., BTCUSDT
        if (symbol.includes('/')) return 'forex'; // e.g., EUR/USD
        if (/^[A-Z]{1,5}$/.test(symbol)) return 'stock'; // e.g., AAPL

        return 'stock'; // Default
    }

    /**
     * Determine provider from symbol
     */
    getProvider(symbol: string): 'binance' | 'twelvedata' | 'mock' {
        const asset = POPULAR_ASSETS.find(a => a.symbol === symbol);
        if (asset) return asset.provider;

        // Check if it looks like a Binance symbol
        if (symbol.endsWith('USDT') || symbol.endsWith('BUSD') || symbol.endsWith('BTC')) {
            return 'binance';
        }

        // Default to twelvedata for stocks/forex/commodities
        return 'twelvedata';
    }
}

export const assetSearchService = new AssetSearchService();
