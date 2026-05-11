
import { OHLCVData } from "../types/index";
import type { DataProvider } from "../types/data-providers";
import {
    loadCachedCandles,
    loadSeedCandlesFromPriceData,
    mergeCandles,
    saveCachedCandles,
} from "../candle-cache";
import {
    loadSqliteCandles,
    storeSqliteCandles,
} from "../local-sqlite-api";
import {
    DATA_CACHE_SYNC_MIN_MS,
    DATA_CHART_TOTAL_LIMIT,
} from "./constants";
import {
    normalizeTradFiDailyCandles,
    takeLastCandles as trimToLastCandles,
} from "./data-interval-utils";

type NonBinanceLocalSource = 'imported' | 'sqlite' | 'cache' | 'seed';

export interface PersistenceContext {
    syncAtByKey: Map<string, number>;
    setCachedCandles: (cacheKey: string, candles: OHLCVData[], source: string) => void;
}

export class DataPersistence {
    private cachePersistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private cachePersistPendingByKey: Map<string, { symbol: string; storageInterval: string; candles: OHLCVData[] }> = new Map();
    private readonly STREAM_PERSIST_DELAY_MS = 1200;

    normalizeExternalCandles(candles: OHLCVData[]): OHLCVData[] {
        return mergeCandles([], candles);
    }

    private normalizeProviderCandles(candles: OHLCVData[], interval: string, provider: DataProvider): OHLCVData[] {
        const normalized = this.normalizeExternalCandles(candles);
        return provider === 'bybit-tradfi'
            ? normalizeTradFiDailyCandles(normalized, interval)
            : normalized;
    }

    async loadNonBinanceLocalData(deps: {
        symbol: string;
        interval: string;
        provider: DataProvider;
        maxBars: number;
        storageInterval: string;
        storageSymbol: string;
        cacheKey: string;
        importedCandles: OHLCVData[] | undefined;
        signal?: AbortSignal;
        ctx: PersistenceContext;
    }): Promise<{ candles: OHLCVData[]; source: NonBinanceLocalSource } | null> {
        const {
            symbol,
            interval,
            provider,
            maxBars,
            storageInterval,
            storageSymbol,
            cacheKey,
            importedCandles,
            signal,
            ctx,
        } = deps;

        const normalizedLimit = Math.max(1, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(maxBars)));
        const candidates: Array<{ candles: OHLCVData[]; source: NonBinanceLocalSource }> = [];

        if (importedCandles && importedCandles.length > 0) {
            candidates.push({
                candles: trimToLastCandles(this.normalizeProviderCandles(importedCandles, interval, provider), normalizedLimit),
                source: 'imported',
            });
        }

        const sqliteRaw = await loadSqliteCandles(storageSymbol, storageInterval, normalizedLimit);
        if (sqliteRaw && sqliteRaw.candles.length > 0) {
            candidates.push({
                candles: trimToLastCandles(this.normalizeProviderCandles(sqliteRaw.candles, interval, provider), normalizedLimit),
                source: 'sqlite',
            });
        }

        const cached = await loadCachedCandles(storageSymbol, storageInterval);
        if (cached && cached.candles.length > 0) {
            candidates.push({
                candles: trimToLastCandles(this.normalizeProviderCandles(cached.candles, interval, provider), normalizedLimit),
                source: 'cache',
            });
        }

        const seedData = await loadSeedCandlesFromPriceData(symbol, interval, signal);
        if (seedData && seedData.length > 0) {
            candidates.push({
                candles: trimToLastCandles(this.normalizeProviderCandles(seedData, interval, provider), normalizedLimit),
                source: 'seed',
            });
        }

        if (candidates.length === 0) {
            return null;
        }

        const priority: Record<NonBinanceLocalSource, number> = {
            imported: 4,
            cache: 3,
            sqlite: 2,
            seed: 1,
        };

        candidates.sort((a, b) => {
            if (b.candles.length !== a.candles.length) {
                return b.candles.length - a.candles.length;
            }
            return priority[b.source] - priority[a.source];
        });

        const best = candidates[0];
        if (best) {
            ctx.setCachedCandles(cacheKey, best.candles, best.source);
        }
        return best;
    }

    async persistNonBinanceData(deps: {
        symbol: string;
        interval: string;
        provider: DataProvider;
        candles: OHLCVData[];
        source: string;
        storageInterval: string;
        storageSymbol: string;
        providerLabel: string;
        cacheKey: string;
        ctx: PersistenceContext;
    }): Promise<void> {
        const {
            storageInterval,
            providerLabel,
            provider,
            source,
            candles,
            storageSymbol,
            cacheKey,
            ctx,
        } = deps;

        if (candles.length === 0) return;
        const normalized = this.normalizeProviderCandles(candles, storageInterval, provider);
        await this.persistLocalCandles({
            symbol: storageSymbol,
            storageInterval,
            cacheCandles: normalized,
            sqliteCandles: normalized,
            providerLabel,
            sourceTrait: source,
            cacheKey,
            ctx,
        });
    }

    async persistLocalCandles(args: {
        symbol: string;
        storageInterval: string;
        cacheCandles?: OHLCVData[];
        sqliteCandles?: OHLCVData[];
        providerLabel: string;
        sourceTrait: string;
        cacheKey?: string;
        updateSyncTime?: boolean;
        ctx: PersistenceContext;
    }): Promise<void> {
        const {
            symbol,
            storageInterval,
            cacheCandles,
            sqliteCandles,
            providerLabel,
            sourceTrait,
            cacheKey,
            updateSyncTime = false,
            ctx,
        } = args;

        if (cacheCandles && cacheCandles.length > 0) {
            await saveCachedCandles(symbol, storageInterval, cacheCandles, sourceTrait);
        }

        if (sqliteCandles && sqliteCandles.length > 0) {
            await storeSqliteCandles(
                symbol,
                storageInterval,
                sqliteCandles,
                providerLabel,
                sourceTrait
            );
        }

        if (updateSyncTime && cacheKey) {
            ctx.syncAtByKey.set(cacheKey, Date.now());
            if (cacheCandles) {
                ctx.setCachedCandles(cacheKey, cacheCandles, sourceTrait);
            }
        }
    }

    queuePersistCandles(deps: {
        symbol: string;
        interval: string;
        candles: OHLCVData[];
        resolvedProvider: DataProvider;
        storageSymbol: string;
        storageInterval: string;
        cacheKey: string;
        providerLabel: string;
        ctx: PersistenceContext;
    }): void {
        const {
            symbol,
            interval,
            candles,
            storageSymbol,
            storageInterval,
            cacheKey,
            providerLabel,
            ctx,
        } = deps;

        if (!symbol || !interval || candles.length === 0) return;
        this.cachePersistPendingByKey.set(cacheKey, {
            symbol: storageSymbol,
            storageInterval,
            candles,
        });

        const existingTimer = this.cachePersistTimers.get(cacheKey);
        if (existingTimer) return;

        const persistence = this;
        const timer = setTimeout(() => {
            persistence.cachePersistTimers.delete(cacheKey);
            void (async () => {
                const pending = persistence.cachePersistPendingByKey.get(cacheKey);
                persistence.cachePersistPendingByKey.delete(cacheKey);
                if (!pending || pending.candles.length === 0) return;

                const snapshot = pending.candles.length > DATA_CHART_TOTAL_LIMIT
                    ? pending.candles.slice(-DATA_CHART_TOTAL_LIMIT)
                    : pending.candles.slice();
                const delta = snapshot.slice(-2);
                const sqliteResult = await storeSqliteCandles(
                    pending.symbol,
                    pending.storageInterval,
                    delta,
                    providerLabel,
                    'stream'
                );
                const lastSync = ctx.syncAtByKey.get(cacheKey) ?? 0;
                const shouldPersistSnapshot = !sqliteResult || (Date.now() - lastSync >= DATA_CACHE_SYNC_MIN_MS);
                await persistence.persistLocalCandles({
                    symbol: pending.symbol,
                    storageInterval: pending.storageInterval,
                    cacheCandles: shouldPersistSnapshot ? snapshot : undefined,
                    providerLabel,
                    sourceTrait: 'stream',
                    cacheKey,
                    updateSyncTime: true,
                    ctx,
                });
            })();
        }, this.STREAM_PERSIST_DELAY_MS);
        this.cachePersistTimers.set(cacheKey, timer);
    }
}
