/**
 * Asset Search Service - Unified search across multiple providers
 * Supports Binance (Crypto), Bybit TradFi, and Twelve Data fallback assets
 */

import { binanceSearchService, BinanceSymbol } from './binance-search-service';
import { tradfiSearchService, type TradFiSymbol } from './tradfi-search-service';

export type AssetType = 'crypto' | 'stock' | 'forex' | 'commodity';
export type AssetProvider = 'binance' | 'bybit-tradfi' | 'mock';

export interface Asset {
    symbol: string;          // e.g., "AAPL", "ETHUSDT", "EURUSD"
    displayName: string;     // e.g., "Apple Inc.", "ETH/USDT"
    type: AssetType;         // Asset classification
    provider: AssetProvider;  // Data source
    baseAsset?: string;      // e.g., "ETH" for crypto
    quoteAsset?: string;     // e.g., "USDT" for crypto
}

// Additional fallback assets when not available in Bybit TradFi catalog
const POPULAR_ASSETS: Asset[] = [];

class AssetSearchService {
    private mapTradFiAsset(symbol: TradFiSymbol): Asset {
        return {
            symbol: symbol.symbol,
            displayName: symbol.displayName,
            type: symbol.type,
            provider: 'bybit-tradfi',
        };
    }

    private dedupeAssets(assets: Asset[]): Asset[] {
        const deduped = new Map<string, Asset>();
        for (const asset of assets) {
            const key = asset.symbol.toUpperCase();
            if (!deduped.has(key)) {
                deduped.set(key, asset);
            }
        }
        return Array.from(deduped.values());
    }

    /**
     * Search for assets across all providers
     */
    async searchAssets(query: string, limit = 50): Promise<Asset[]> {
        if (!query.trim()) {
            return this.getPopularAssets(limit);
        }

        const results: Asset[] = [];
        const searchTerm = query.toUpperCase();

        // Search Bybit TradFi pairs
        try {
            const tradfiResults = tradfiSearchService.searchSymbols(query, Math.floor(limit / 2) + 10);
            results.push(...tradfiResults.map(symbol => this.mapTradFiAsset(symbol)));
        } catch (error) {
            console.warn('Bybit TradFi search failed:', error);
        }

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
        const uniqueResults = this.dedupeAssets(results);

        // Score and sort by relevance
        const scored = uniqueResults.map(asset => {
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
            if (asset.provider === 'bybit-tradfi') score += 8;
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

        const bybitTradFi = tradfiSearchService
            .getPopularSymbols(Math.max(0, limit))
            .map(symbol => this.mapTradFiAsset(symbol));

        // Show crypto first, then TradFi list, then Twelve Data fallback assets
        popular.push(...topCrypto);
        popular.push(...bybitTradFi);
        popular.push(...POPULAR_ASSETS);

        return this.dedupeAssets(popular).slice(0, limit);
    }

    /**
     * Check if a symbol is valid
     */
    async isValidAsset(symbol: string): Promise<boolean> {
        if (tradfiSearchService.isTradFiSymbol(symbol)) {
            return true;
        }

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
        const tradfiAsset = tradfiSearchService.getSymbolInfo(symbol);
        if (tradfiAsset) {
            return this.mapTradFiAsset(tradfiAsset);
        }

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
        const tradfiAsset = tradfiSearchService.getSymbolInfo(symbol);
        if (tradfiAsset) return tradfiAsset.type;

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
    getProvider(symbol: string): AssetProvider {
        if (tradfiSearchService.isTradFiSymbol(symbol)) {
            return 'bybit-tradfi';
        }

        const asset = POPULAR_ASSETS.find(a => a.symbol === symbol);
        if (asset) return asset.provider;

        // Check if it looks like a Binance symbol
        if (symbol.endsWith('USDT') || symbol.endsWith('BUSD') || symbol.endsWith('BTC')) {
            return 'binance';
        }

        // Default to binance
        return 'binance';
    }
}

export const assetSearchService = new AssetSearchService();
