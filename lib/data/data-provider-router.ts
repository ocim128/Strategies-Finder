import type { DataProvider } from "../types/data-providers";
import {
    getBinanceProviderForMarketType,
    getScopedBinanceStorageSymbol,
    isBinanceDataProvider,
    type BinanceDataProvider,
} from "../binance-market";
import { state } from "../state";
import { isPolymarketEventSymbol } from "../dataProviders/polymarket";
import { tradfiSearchService } from "../tradfi-search-service";

export class DataProviderRouter {
    private providerOverrideBySymbol: Map<string, Exclude<DataProvider, BinanceDataProvider>> = new Map();

    getDefaultBinanceProvider(): BinanceDataProvider {
        return getBinanceProviderForMarketType(state.binanceMarketType);
    }

    getStorageSymbol(symbol: string, provider: DataProvider): string {
        if (provider === "binance-futures") {
            return getScopedBinanceStorageSymbol(symbol, "futures");
        }
        return symbol.trim().toUpperCase();
    }

    getProvider(symbol: string): DataProvider {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (this.providerOverrideBySymbol.has(normalizedSymbol)) {
            return this.providerOverrideBySymbol.get(normalizedSymbol)!;
        }
        if (isPolymarketEventSymbol(symbol)) {
            this.providerOverrideBySymbol.set(normalizedSymbol, 'polymarket');
            return 'polymarket';
        }
        if (tradfiSearchService.isTradFiSymbol(normalizedSymbol)) {
            this.providerOverrideBySymbol.set(normalizedSymbol, 'bybit-tradfi');
            return 'bybit-tradfi';
        }

        return this.getDefaultBinanceProvider();
    }

    setProviderOverride(symbol: string, provider: DataProvider | null): void {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (!normalizedSymbol) return;

        if (!provider || isBinanceDataProvider(provider)) {
            this.providerOverrideBySymbol.delete(normalizedSymbol);
            return;
        }

        this.providerOverrideBySymbol.set(normalizedSymbol, provider);
    }

    getProviderStorageLabel(provider: DataProvider): string {
        if (provider === 'binance-futures') return 'Binance Futures';
        if (provider === 'bybit-tradfi') return 'Bybit TradFi';
        if (provider === 'polymarket') return 'Polymarket';
        return 'Binance Spot';
    }
}
