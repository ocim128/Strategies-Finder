import { OHLCVData, HistoricalFetchOptions } from "../types/index";
import type { DataProvider } from "../types/data-providers";
import {
    getBinanceMarketLabel,
    getBinanceMarketTypeForProvider,
    isBinanceDataProvider,
} from "../binance-market";
import { debugLogger } from "../debug-logger";
import {
    fetchBinanceDataAfter,
    fetchBinanceData,
    fetchBinanceDataWithLimit,
} from "../dataProviders/binance";
import {
    BybitTradFiUnsupportedSymbolError,
    fetchBybitTradFiData,
    fetchBybitTradFiDataWithLimit,
} from "../dataProviders/bybit";
import {
    fetchPolymarketData,
    fetchPolymarketDataWithLimit,
} from "../dataProviders/polymarket";
import {
    generateMockData,
    isMockSymbol
} from "../dataProviders/mock";
import { getIntervalSeconds } from "../dataProviders/utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { findFirstGapAnchorTime } from "../realtime-gap-utils";
import {
    loadCachedCandles,
    loadSeedCandlesFromPriceData,
    mergeCandles,
} from "../candle-cache";
import {
    loadSqliteCandles,
} from "../local-sqlite-api";
import {
    isSecondMarketChartContext,
    loadSecondMarketCandles,
    normalizeSecondMarketChartSymbol,
} from "../second-market/api";
import type { ResampleOptions } from "../strategies/resample-utils";
import {
    DATA_CACHE_SYNC_MIN_MS,
    DATA_CHART_TOTAL_LIMIT,
} from "./constants";
import {
    estimateBybitSeedOverlayBars as estimateBybitSeedOverlayBarsValue,
    getStorageInterval as resolveStorageInterval,
    isIntervalAlignedTime as checkIntervalAlignedTime,
    sliceCandlesToLookback,
    takeLastCandles as trimToLastCandles,
} from "./data-interval-utils";
import type { DataProviderRouter } from "./data-provider-router";
import type { DataCache } from "./data-cache";
import type { DataPersistence, PersistenceContext } from "./data-persistence";

export type DataLoadReporter = {
    updateSymbolDataSource?: (label: string, tone: 'live' | 'seed' | 'warning' | 'loading', title?: string) => void;
    showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
};

type NonBinanceLocalSource = 'imported' | 'sqlite' | 'cache' | 'seed';
type NonBinanceLocalData = { candles: OHLCVData[]; source: NonBinanceLocalSource };
type ProviderFallbackChain = {
    provider: DataProvider | 'mock';
    lookbackBars: number | null;
    maxBars: number;
    resampleOptions?: ResampleOptions;
    localNonBinance: NonBinanceLocalData | null;
};
type FastPathLocalCandlesOptions = {
    minBars?: number;
    lookbackBars?: number | null;
    skipCache?: boolean;
};
type SecondMarketMarketType = "spot" | "futures";

export class DataFetcher {
    private static readonly PRICE_JUMP_GUARD_RATIO = 8;
    private readonly inFlightLoads = new Map<string, Promise<OHLCVData[]>>();

    constructor(
        private providerRouter: DataProviderRouter,
        private cache: DataCache,
        private persistence: DataPersistence,
        private getImportedDataByKey: () => Map<string, OHLCVData[]>,
        private getChartLookbackBars: () => number | null,
        private reporter: DataLoadReporter,
    ) {}

    private runDedupedLoad(key: string, work: () => Promise<OHLCVData[]>): Promise<OHLCVData[]> {
        const existing = this.inFlightLoads.get(key);
        if (existing) {
            return existing;
        }

        const promise = work().finally(() => {
            if (this.inFlightLoads.get(key) === promise) {
                this.inFlightLoads.delete(key);
            }
        });
        this.inFlightLoads.set(key, promise);
        return promise;
    }

    private canDedupeHistoricalOptions(options?: HistoricalFetchOptions): boolean {
        return !options?.signal && typeof options?.onProgress !== "function";
    }

    private getSecondMarketMarketType(symbol: string): SecondMarketMarketType {
        return this.providerRouter.getProvider(symbol) === "binance-futures" ? "futures" : "spot";
    }

    async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        const secondMarketSymbol = normalizeSecondMarketChartSymbol(symbol);
        if (secondMarketSymbol && isSecondMarketChartContext(symbol, interval)) {
            if (signal?.aborted) return [];
            const marketType = this.getSecondMarketMarketType(symbol);
            const limit = this.getChartLookbackBars() ?? DATA_CHART_TOTAL_LIMIT;
            const load = async () => {
                const data = await loadSecondMarketCandles({
                    symbol: secondMarketSymbol,
                    marketType,
                    limit,
                });
                this.reporter.updateSymbolDataSource?.(
                    "1s miner DB",
                    "seed",
                    "Chart data is loaded from price-data/1second-chart/second-market-data.sqlite."
                );
                return data;
            };
            return signal
                ? load()
                : this.runDedupedLoad(`second-market:${secondMarketSymbol}:${marketType}:${limit}`, load);
        }

        const provider = this.providerRouter.getProvider(symbol);
        const storageInterval = resolveStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        const lookbackBars = this.getChartLookbackBars();
        const shouldRefreshHotCache = provider === 'bybit-tradfi' && storageInterval === '1d';
        const fastPathCandles = this.readFastPathLocalCandles(provider, symbol, storageInterval, cacheKey, {
            lookbackBars,
            skipCache: shouldRefreshHotCache,
        });
        if (fastPathCandles) return fastPathCandles;

        const load = async () => {
            const chain = await this.resolveProviderFallbackChain(symbol, interval, signal);
            return this.fetchDataFromProviderChain(chain, symbol, interval, signal);
        };
        return signal
            ? load()
            : this.runDedupedLoad(`chart:${provider}:${cacheKey}:${interval}:${lookbackBars ?? "all"}`, load);
    }

    async fetchDataDetached(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        const detachedFetcher = new DataFetcher(
            this.providerRouter,
            this.cache,
            this.persistence,
            this.getImportedDataByKey,
            this.getChartLookbackBars,
            {}
        );
        return detachedFetcher.fetchData(symbol, interval, signal);
    }

    async fetchDataForScan(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<OHLCVData[]> {
        const result = await this.fetchDataForScanWithMeta(symbol, interval, signal, lookbackBars);
        return result.data;
    }

    async fetchDataForScanWithMeta(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<{ data: OHLCVData[]; source: 'mock' | 'local' | 'network' }> {
        const secondMarketSymbol = normalizeSecondMarketChartSymbol(symbol);
        if (secondMarketSymbol && isSecondMarketChartContext(symbol, interval)) {
            if (signal?.aborted) return { data: [], source: 'local' };
            const maxBars = Number.isFinite(lookbackBars)
                ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
                : DATA_CHART_TOTAL_LIMIT;
            const data = await loadSecondMarketCandles({
                symbol: secondMarketSymbol,
                marketType: this.getSecondMarketMarketType(symbol),
                limit: maxBars,
            });
            return { data, source: 'local' };
        }

        if (isMockSymbol(symbol)) {
            if (signal?.aborted) return { data: [], source: 'mock' };
            const mockData = generateMockData(symbol, interval);
            const maxBars = Number.isFinite(lookbackBars)
                ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
                : 1000;
            return { data: trimToLastCandles(mockData, maxBars), source: 'mock' };
        }

        const provider = this.providerRouter.getProvider(symbol);
        const maxBars = Number.isFinite(lookbackBars)
            ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
            : 1000;
        const resampleOptions = this.getResampleOptions(interval);

        const storageInterval = resolveStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        const fastPathCandles = this.readFastPathLocalCandles(provider, symbol, storageInterval, cacheKey, {
            lookbackBars: maxBars,
        });
        if (fastPathCandles) return { data: fastPathCandles, source: 'local' };

        if (!isBinanceDataProvider(provider)) {
            const localData = await this.loadNonBinanceLocalData(symbol, interval, maxBars, signal);
            if (localData) {
                return {
                    data: trimToLastCandles(localData.candles, maxBars),
                    source: 'local',
                };
            }
        }

        if (provider === 'local-daily') {
            return { data: [], source: 'local' };
        }

        if (isBinanceDataProvider(provider)) {
            const result = await this.fetchBinanceDataHybridWithMeta(symbol, interval, signal, {
                maxBars,
            });
            return result;
        }

        if (provider === 'bybit-tradfi' || provider === 'polymarket') {
            const data = await this.fetchLimitedNonBinanceNetworkData(
                provider,
                symbol,
                interval,
                maxBars,
                signal,
                resampleOptions
            );
            return { data, source: 'network' };
        }

        const fallbackData = await this.fetchNonBinanceData(symbol, interval, signal);
        return { data: trimToLastCandles(fallbackData, maxBars), source: 'network' };
    }

    async fetchDataWithLimit(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        const secondMarketSymbol = normalizeSecondMarketChartSymbol(symbol);
        if (secondMarketSymbol && isSecondMarketChartContext(symbol, interval)) {
            if (options?.signal?.aborted) return [];
            const marketType = this.getSecondMarketMarketType(symbol);
            const load = () => loadSecondMarketCandles({
                symbol: secondMarketSymbol,
                marketType,
                limit,
            });
            return this.canDedupeHistoricalOptions(options)
                ? this.runDedupedLoad(`second-market-limit:${secondMarketSymbol}:${marketType}:${limit}`, load)
                : load();
        }

        if (isMockSymbol(symbol)) {
            const data = generateMockData(symbol, interval);
            return trimToLastCandles(data, limit);
        }

        const provider = this.providerRouter.getProvider(symbol);
        const storageInterval = resolveStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        const fastPathCandles = this.readFastPathLocalCandles(provider, symbol, storageInterval, cacheKey, {
            minBars: limit,
            lookbackBars: limit,
        });
        if (fastPathCandles) return fastPathCandles;

        // SQLite fallback — survives page refresh, avoids re-fetching from Binance
        if (isBinanceDataProvider(provider)) {
            const storageSymbol = this.providerRouter.getStorageSymbol(symbol, provider);
            const sqliteRaw = await loadSqliteCandles(storageSymbol, storageInterval, limit);
            if (sqliteRaw) {
                const sanitized = this.sanitizeBinanceCandles(symbol, storageInterval, sqliteRaw.candles, 'sqlite');
                if (sanitized.length >= limit) {
                    this.cache.set(cacheKey, sanitized, 'sqlite');
                    return sliceCandlesToLookback(sanitized, limit);
                }
            }
        }

        const load = async () => {
            const data = await this.fetchDataWithLimitUncached(symbol, interval, limit, provider, options);
            if (data.length > 0) {
                this.cache.set(cacheKey, data, 'network-historical');
                this.queuePersistCandles(symbol, interval, data, provider);
            }
            return data;
        };
        if (this.canDedupeHistoricalOptions(options)) {
            return this.runDedupedLoad(
                [
                    "limit",
                    provider,
                    cacheKey,
                    interval,
                    limit,
                    options?.requestDelayMs ?? "default",
                    options?.maxRequests ?? "default",
                ].join(":"),
                load
            );
        }
        return load();
    }

    private async fetchDataWithLimitUncached(
        symbol: string,
        interval: string,
        limit: number,
        provider: DataProvider,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        const resampleOptions = this.getResampleOptions(interval);
        const localNonBinance = !isBinanceDataProvider(provider)
            ? await this.loadNonBinanceLocalData(symbol, interval, limit, options?.signal)
            : null;

        if (provider === 'local-daily') {
            return localNonBinance ? trimToLastCandles(localNonBinance.candles, limit) : [];
        }

        if (isBinanceDataProvider(provider)) {
            return fetchBinanceDataWithLimit(symbol, interval, limit, {
                ...options,
                ...(resampleOptions ?? {}),
                marketType: getBinanceMarketTypeForProvider(provider),
            });
        }

        if (provider === 'bybit-tradfi' || provider === 'polymarket') {
            if (localNonBinance && localNonBinance.candles.length >= limit) {
                return trimToLastCandles(localNonBinance.candles, limit);
            }
            const data = await this.fetchLimitedNonBinanceNetworkData(
                provider,
                symbol,
                interval,
                limit,
                options?.signal,
                resampleOptions
            );
            if (data.length > 0) {
                return data;
            }
            return localNonBinance ? trimToLastCandles(localNonBinance.candles, limit) : [];
        }

        const data = await this.fetchNonBinanceData(symbol, interval, options?.signal);
        return trimToLastCandles(data, limit);
    }

    async fetchHistoricalData(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions & { onProgress?: (progress: { fetched: number; total: number; requestCount: number }) => void }
    ): Promise<OHLCVData[]> {
        return this.fetchDataWithLimit(symbol, interval, limit, options);
    }

    sanitizeBinanceCandles(
        symbol: string,
        interval: string,
        candles: OHLCVData[],
        source: string
    ): OHLCVData[] {
        if (candles.length <= 1) return candles.slice();

        const timeCache = new Map<OHLCVData, number | null>();
        for (const candle of candles) {
            timeCache.set(candle, parseTimeToUnixSeconds(candle.time));
        }

        const sorted = candles
            .slice()
            .sort((a, b) => (timeCache.get(a) ?? 0) - (timeCache.get(b) ?? 0));

        const cleaned: OHLCVData[] = [];
        let dropped = 0;
        const maxRatio = DataFetcher.PRICE_JUMP_GUARD_RATIO;

        for (const candle of sorted) {
            const open = Number(candle.open);
            const high = Number(candle.high);
            const low = Number(candle.low);
            const close = Number(candle.close);
            const timeSec = timeCache.get(candle) ?? null;

            if (
                timeSec === null ||
                !Number.isFinite(open) ||
                !Number.isFinite(high) ||
                !Number.isFinite(low) ||
                !Number.isFinite(close) ||
                open <= 0 ||
                high <= 0 ||
                low <= 0 ||
                close <= 0 ||
                low > high
            ) {
                dropped += 1;
                continue;
            }
            if (!checkIntervalAlignedTime(timeSec, interval)) {
                dropped += 1;
                continue;
            }

            const prev = cleaned[cleaned.length - 1];
            if (!prev) {
                cleaned.push(candle);
                continue;
            }

            const prevTime = timeCache.get(prev) ?? null;
            if (prevTime !== null && prevTime === timeSec) {
                cleaned[cleaned.length - 1] = candle;
                continue;
            }

            const prevClose = Number(prev.close);
            if (!Number.isFinite(prevClose) || prevClose <= 0) {
                dropped += 1;
                continue;
            }

            const maxPrice = Math.max(open, high, low, close);
            const minPrice = Math.min(open, high, low, close);
            const jumpUp = maxPrice / prevClose;
            const jumpDown = prevClose / Math.max(minPrice, Number.EPSILON);
            const intraBarRatio = maxPrice / Math.max(minPrice, Number.EPSILON);

            if (jumpUp > maxRatio || jumpDown > maxRatio || intraBarRatio > maxRatio) {
                dropped += 1;
                continue;
            }

            cleaned.push(candle);
        }

        if (dropped > 0) {
            debugLogger.warn('data.series.sanitized_outliers', {
                symbol,
                interval,
                source,
                dropped,
                input: candles.length,
                output: cleaned.length,
                guardRatio: maxRatio,
            });
        }

        return cleaned;
    }

    private sanitizeFastPathCandles(
        provider: DataProvider,
        symbol: string,
        storageInterval: string,
        candles: OHLCVData[],
        source: string
    ): OHLCVData[] {
        return isBinanceDataProvider(provider)
            ? this.sanitizeBinanceCandles(symbol, storageInterval, candles, source)
            : candles;
    }

    private readFastPathLocalCandles(
        provider: DataProvider,
        symbol: string,
        storageInterval: string,
        cacheKey: string,
        options: FastPathLocalCandlesOptions = {}
    ): OHLCVData[] | null {
        const minBars = Math.max(0, Math.floor(options.minBars ?? 1));
        const takeCandles = (candles: OHLCVData[]) =>
            sliceCandlesToLookback(candles, options.lookbackBars ?? null);

        const imported = this.getImportedDataByKey().get(cacheKey);
        if (imported && imported.length >= minBars) {
            const candles = this.sanitizeFastPathCandles(provider, symbol, storageInterval, imported, 'imported');
            if (candles.length >= minBars) {
                return takeCandles(candles);
            }
        }

        if (options.skipCache) return null;

        const cached = this.cache.get(cacheKey);
        if (cached && cached.candles.length >= minBars) {
            const candles = this.sanitizeFastPathCandles(provider, symbol, storageInterval, cached.candles, String(cached.source ?? 'cache'));
            if (candles.length !== cached.candles.length) {
                this.cache.set(cacheKey, candles, cached.source);
            }
            if (candles.length >= minBars) {
                return takeCandles(candles);
            }
        }

        return null;
    }

    queuePersistCandles(
        symbol: string,
        interval: string,
        candles: OHLCVData[],
        provider: DataProvider | '' = ''
    ): void {
        if (!symbol || !interval || candles.length === 0) return;
        const resolvedProvider: DataProvider = provider || this.providerRouter.getProvider(symbol);
        const storageSymbol = this.providerRouter.getStorageSymbol(symbol, resolvedProvider);
        const storageInterval = resolveStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, resolvedProvider);
        this.persistence.queuePersistCandles({
            symbol,
            interval,
            candles,
            resolvedProvider,
            storageSymbol,
            storageInterval,
            cacheKey,
            providerLabel: this.providerRouter.getProviderStorageLabel(resolvedProvider),
            ctx: this.createPersistenceContext(),
        });
    }

    buildCacheKey(symbol: string, interval: string, provider?: DataProvider): string {
        const resolvedProvider = provider ?? this.providerRouter.getProvider(symbol);
        return `${this.providerRouter.getStorageSymbol(symbol, resolvedProvider)}::${resolveStorageInterval(interval)}`;
    }

    private createPersistenceContext(): PersistenceContext {
        return {
            syncAtByKey: this.cache.syncAtByKey,
            setCachedCandles: (key: string, candles: OHLCVData[], source: string) => this.cache.set(key, candles, source),
        };
    }

    private async resolveProviderFallbackChain(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<ProviderFallbackChain> {
        const lookbackBars = this.getChartLookbackBars();
        const maxBars = lookbackBars ?? DATA_CHART_TOTAL_LIMIT;
        const resampleOptions = this.getResampleOptions(interval);

        if (isMockSymbol(symbol)) {
            return {
                provider: 'mock',
                lookbackBars,
                maxBars,
                resampleOptions,
                localNonBinance: null,
            };
        }

        const provider = this.providerRouter.getProvider(symbol);
        const localNonBinance = !isBinanceDataProvider(provider)
            ? await this.loadNonBinanceLocalData(symbol, interval, maxBars, signal)
            : null;

        return {
            provider,
            lookbackBars,
            maxBars,
            resampleOptions,
            localNonBinance,
        };
    }

    private async fetchDataFromProviderChain(
        chain: ProviderFallbackChain,
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData[]> {
        if (chain.provider === 'mock') {
            return this.fetchMockChartData(symbol, interval, signal, chain.lookbackBars);
        }

        if (isBinanceDataProvider(chain.provider)) {
            return this.fetchBinanceChartData(symbol, interval, signal, chain.lookbackBars);
        }

        if (chain.provider === 'bybit-tradfi') {
            return this.fetchBybitTradFiChartData(chain, symbol, interval, signal);
        }

        if (chain.provider === 'local-daily') {
            return this.fetchLocalDailyChartData(chain, symbol, interval);
        }

        if (chain.provider === 'polymarket') {
            return this.fetchPolymarketChartData(chain, symbol, interval, signal);
        }

        const fallback = await this.fetchNonBinanceData(symbol, interval, signal);
        this.reporter.updateSymbolDataSource?.(
            'Fallback',
            'warning',
            'Primary data source was unavailable, so fallback data is being used.'
        );
        return sliceCandlesToLookback(fallback, chain.lookbackBars);
    }

    private fetchLocalDailyChartData(
        chain: ProviderFallbackChain,
        symbol: string,
        interval: string
    ): OHLCVData[] {
        const { lookbackBars, localNonBinance } = chain;
        if (localNonBinance && localNonBinance.candles.length > 0) {
            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            this.reporter.updateSymbolDataSource?.(localSourceMeta.label, 'seed', localSourceMeta.title);
            return sliceCandlesToLookback(localNonBinance.candles, lookbackBars);
        }

        this.reporter.showToast?.(`No local daily seed data found for ${symbol} ${interval}.`, 'error');
        this.reporter.updateSymbolDataSource?.(
            'Local seed unavailable',
            'warning',
            'No bundled local daily seed data was found for this symbol and interval.'
        );
        return [];
    }

    private async fetchMockChartData(
        symbol: string,
        interval: string,
        signal: AbortSignal | undefined,
        lookbackBars: number | null
    ): Promise<OHLCVData[]> {
        if (import.meta.env?.DEV) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (signal?.aborted) return [];
        const mockData = generateMockData(symbol, interval);
        this.reporter.updateSymbolDataSource?.('Mock data', 'seed', 'Chart is using generated mock candles.');
        return sliceCandlesToLookback(mockData, lookbackBars);
    }

    private async fetchBinanceChartData(
        symbol: string,
        interval: string,
        signal: AbortSignal | undefined,
        lookbackBars: number | null
    ): Promise<OHLCVData[]> {
        const provider = this.providerRouter.getProvider(symbol);
        if (!isBinanceDataProvider(provider)) {
            throw new Error(`Expected Binance provider for ${symbol}, received ${provider}.`);
        }
        const result = await this.fetchBinanceDataHybridWithMeta(symbol, interval, signal, {
            maxBars: lookbackBars ?? undefined,
        });
        this.reporter.updateSymbolDataSource?.(
            `Live: ${getBinanceMarketLabel(getBinanceMarketTypeForProvider(provider))}`,
            'live',
            `Chart data is loaded from ${getBinanceMarketLabel(getBinanceMarketTypeForProvider(provider))}.`
        );
        return result.data;
    }

    private async fetchBybitTradFiChartData(
        chain: ProviderFallbackChain,
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData[]> {
        const { lookbackBars, localNonBinance, resampleOptions } = chain;

        if (localNonBinance && interval.trim().toLowerCase() === '1d') {
            const seededWithLatest = await this.mergeBybitRecentIntoSeed(
                symbol,
                interval,
                localNonBinance.candles,
                signal,
                resampleOptions
            );
            if (seededWithLatest.liveRefreshed) {
                void this.persistBybitTradFiDailyOverlay(
                    symbol,
                    interval,
                    seededWithLatest.candles,
                    seededWithLatest.refreshedCandles,
                    `local-${localNonBinance.source}-overlay`
                );
                this.reporter.updateSymbolDataSource?.(
                    localNonBinance.source === 'seed' ? 'CSV + Bybit' : 'Local + Bybit',
                    'live',
                    localNonBinance.source === 'seed'
                        ? 'Historical candles came from the local CSV seed and the latest candle was refreshed from Bybit.'
                        : 'Historical candles came from local cache/SQLite and the latest candle was refreshed from Bybit.'
                );
                return sliceCandlesToLookback(seededWithLatest.candles, lookbackBars);
            }

            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            if (seededWithLatest.unsupported) {
                this.reporter.updateSymbolDataSource?.(
                    localSourceMeta.label,
                    'seed',
                    `${localSourceMeta.title} Bybit TradFi does not support this symbol.`
                );
                return sliceCandlesToLookback(seededWithLatest.candles, lookbackBars);
            }

            this.reporter.updateSymbolDataSource?.(
                localSourceMeta.label,
                localNonBinance.source === 'seed' ? 'warning' : 'seed',
                `${localSourceMeta.title} Latest refresh from Bybit did not return a candle.`
            );
            return sliceCandlesToLookback(seededWithLatest.candles, lookbackBars);
        }

        const data = typeof lookbackBars === 'number'
            ? await fetchBybitTradFiDataWithLimit(symbol, interval, lookbackBars, {
                signal,
                ...(resampleOptions ?? {}),
            })
            : await fetchBybitTradFiData(symbol, interval, signal, resampleOptions);
        if (data.length > 0) {
            const merged = localNonBinance
                ? mergeCandles(localNonBinance.candles, data)
                : data;
            void this.persistNonBinanceData(symbol, interval, 'bybit-tradfi', merged, 'network');
            this.reporter.updateSymbolDataSource?.(
                'Live: Bybit',
                'live',
                'Chart data is loaded directly from Bybit TradFi.'
            );
            return sliceCandlesToLookback(merged, lookbackBars);
        }
        if (localNonBinance && localNonBinance.candles.length > 0) {
            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            this.reporter.updateSymbolDataSource?.(
                localSourceMeta.label,
                'warning',
                `${localSourceMeta.title} Bybit TradFi did not return fresh intraday chart data, so local data is being used.`
            );
            return sliceCandlesToLookback(localNonBinance.candles, lookbackBars);
        }
        this.reporter.showToast?.('Bybit TradFi returned no data.', 'error');
        this.reporter.updateSymbolDataSource?.(
            'Bybit unavailable',
            'warning',
            'Bybit TradFi did not return chart data for this symbol and timeframe.'
        );
        return [];
    }

    private async fetchPolymarketChartData(
        chain: ProviderFallbackChain,
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData[]> {
        const { lookbackBars, localNonBinance } = chain;

        if (localNonBinance) {
            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            this.reporter.updateSymbolDataSource?.(localSourceMeta.label, 'seed', localSourceMeta.title);
            return sliceCandlesToLookback(localNonBinance.candles, lookbackBars);
        }

        const data = typeof lookbackBars === 'number'
            ? await fetchPolymarketDataWithLimit(symbol, interval, lookbackBars, { signal })
            : await fetchPolymarketData(symbol, interval, signal);
        if (data.length > 0) {
            void this.persistNonBinanceData(symbol, interval, 'polymarket', data, 'network');
            this.reporter.updateSymbolDataSource?.(
                'Live: Polymarket',
                'live',
                'Chart data is loaded from Polymarket.'
            );
            return data;
        }
        this.reporter.showToast?.('Polymarket returned no data for this market.', 'error');
        this.reporter.updateSymbolDataSource?.(
            'Polymarket unavailable',
            'warning',
            'Polymarket did not return chart data for this market.'
        );
        return [];
    }

    private async fetchLimitedNonBinanceNetworkData(
        provider: 'bybit-tradfi' | 'polymarket',
        symbol: string,
        interval: string,
        limit: number,
        signal?: AbortSignal,
        resampleOptions?: ResampleOptions
    ): Promise<OHLCVData[]> {
        const data = provider === 'bybit-tradfi'
            ? await fetchBybitTradFiDataWithLimit(symbol, interval, limit, {
                signal,
                ...(resampleOptions ?? {}),
            })
            : await fetchPolymarketDataWithLimit(symbol, interval, limit, { signal });

        if (data.length > 0) {
            void this.persistNonBinanceData(symbol, interval, provider, data, 'network');
        }

        return data;
    }

    private async fetchNonBinanceData(symbol: string, interval: string, _signal?: AbortSignal): Promise<OHLCVData[]> {
        this.notifyDataFallback(symbol, interval);
        return generateMockData(symbol, interval);
    }

    private describeLocalSource(source: NonBinanceLocalSource): { label: string; title: string } {
        if (source === 'sqlite') {
            return {
                label: 'SQLite cache',
                title: 'Chart is using local SQLite history for this symbol and interval.',
            };
        }
        if (source === 'cache') {
            return {
                label: 'Local cache',
                title: 'Chart is using the browser candle cache for this symbol and interval.',
            };
        }
        if (source === 'imported') {
            return {
                label: 'Imported',
                title: 'Chart is using imported local candles for this symbol and interval.',
            };
        }
        return {
            label: 'Local seed',
            title: 'Chart is using bundled local seed data for this symbol and interval.',
        };
    }

    private async loadNonBinanceLocalData(
        symbol: string,
        interval: string,
        maxBars: number,
        signal?: AbortSignal
    ): Promise<{ candles: OHLCVData[]; source: NonBinanceLocalSource } | null> {
        const storageInterval = resolveStorageInterval(interval);
        const provider = this.providerRouter.getProvider(symbol);
        const storageSymbol = this.providerRouter.getStorageSymbol(symbol, provider);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        return this.persistence.loadNonBinanceLocalData({
            symbol,
            interval,
            provider,
            maxBars,
            storageInterval,
            storageSymbol,
            cacheKey,
            importedCandles: this.getImportedDataByKey().get(cacheKey),
            signal,
            ctx: this.createPersistenceContext(),
        });
    }

    private async persistNonBinanceData(
        symbol: string,
        interval: string,
        provider: DataProvider,
        candles: OHLCVData[],
        source: string
    ): Promise<void> {
        if (candles.length === 0) return;
        const storageInterval = resolveStorageInterval(interval);
        const storageSymbol = this.providerRouter.getStorageSymbol(symbol, provider);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        await this.persistence.persistNonBinanceData({
            symbol,
            interval,
            provider,
            candles,
            source,
            storageInterval,
            storageSymbol,
            providerLabel: this.providerRouter.getProviderStorageLabel(provider),
            cacheKey,
            ctx: this.createPersistenceContext(),
        });
    }

    private async persistBybitTradFiDailyOverlay(
        symbol: string,
        interval: string,
        candles: OHLCVData[],
        refreshedCandles: OHLCVData[],
        source: string
    ): Promise<void> {
        if (candles.length === 0) return;
        const provider: DataProvider = 'bybit-tradfi';
        const storageInterval = resolveStorageInterval(interval);
        const storageSymbol = this.providerRouter.getStorageSymbol(symbol, provider);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);
        await this.persistLocalCandles({
            symbol: storageSymbol,
            storageInterval,
            cacheCandles: candles,
            sqliteCandles: refreshedCandles.length > 0 ? refreshedCandles : undefined,
            providerLabel: this.providerRouter.getProviderStorageLabel(provider),
            sourceTrait: source,
            cacheKey,
            updateSyncTime: true,
        });
    }

    private async persistLocalCandles(args: {
        symbol: string;
        storageInterval: string;
        cacheCandles?: OHLCVData[];
        sqliteCandles?: OHLCVData[];
        providerLabel: string;
        sourceTrait: string;
        cacheKey?: string;
        updateSyncTime?: boolean;
    }): Promise<void> {
        await this.persistence.persistLocalCandles({
            ...args,
            ctx: this.createPersistenceContext(),
        });
    }

    private getResampleOptions(interval: string): ResampleOptions | undefined {
        const normalized = interval.trim().toLowerCase();
        const intervalSeconds = getIntervalSeconds(normalized);
        return intervalSeconds === 7200 ? {} : undefined;
    }

    private getBybitSeedOverlayBars(interval: string, seedData: OHLCVData[]): number {
        return estimateBybitSeedOverlayBarsValue(interval, seedData);
    }

    private async mergeBybitRecentIntoSeed(
        symbol: string,
        interval: string,
        seedData: OHLCVData[],
        signal?: AbortSignal,
        options?: ResampleOptions
    ): Promise<{ candles: OHLCVData[]; liveRefreshed: boolean; refreshedCandles: OHLCVData[]; unsupported?: boolean }> {
        try {
            const overlayBars = this.getBybitSeedOverlayBars(interval, seedData);
            const recent = await fetchBybitTradFiDataWithLimit(symbol, interval, overlayBars, {
                signal,
                ...(options ?? {}),
            });
            if (recent.length === 0) {
                return { candles: seedData, liveRefreshed: false, refreshedCandles: [] };
            }
            const merged = mergeCandles(seedData, recent);
            return {
                candles: merged,
                liveRefreshed: true,
                refreshedCandles: recent,
            };
        } catch (error) {
            if (error instanceof BybitTradFiUnsupportedSymbolError) {
                debugLogger.info('data.bybit_tradfi.seed_overlay_unsupported', { symbol, interval });
                return { candles: seedData, liveRefreshed: false, refreshedCandles: [], unsupported: true };
            }
            debugLogger.warn('data.bybit_tradfi.seed_overlay_failed', {
                symbol,
                interval,
                error: String(error),
            });
            return { candles: seedData, liveRefreshed: false, refreshedCandles: [] };
        }
    }

    private async fetchBinanceDataHybridWithMeta(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        options?: { maxBars?: number }
    ): Promise<{ data: OHLCVData[]; source: 'local' | 'network' }> {
        const result = await this.fetchBinanceDataHybridInternal(symbol, interval, signal, options);
        return { data: result.data, source: result.source };
    }

    private async fetchBinanceDataHybridInternal(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        options?: { maxBars?: number }
    ): Promise<{ data: OHLCVData[]; source: 'local' | 'network'; cached: { candles: OHLCVData[]; updatedAt: number; source: string } | null; hasSqliteBase: boolean; cacheKey: string; storageInterval: string; effectiveMaxBars: number }> {
        const provider = this.providerRouter.getProvider(symbol);
        if (!isBinanceDataProvider(provider)) {
            throw new Error(`Expected Binance provider for ${symbol}, received ${provider}.`);
        }
        const marketType = getBinanceMarketTypeForProvider(provider);
        const providerLabel = this.providerRouter.getProviderStorageLabel(provider);
        const storageSymbol = this.providerRouter.getStorageSymbol(symbol, provider);
        const requestedMaxBars = options?.maxBars;
        const hasMaxBars = typeof requestedMaxBars === 'number' && Number.isFinite(requestedMaxBars);
        const effectiveMaxBars = hasMaxBars
            ? Math.max(1, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(requestedMaxBars)))
            : DATA_CHART_TOTAL_LIMIT;
        const storageInterval = resolveStorageInterval(interval);
        const resampleOptions = this.getResampleOptions(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval, provider);

        const imported = this.getImportedDataByKey().get(cacheKey);
        if (imported && imported.length > 0) {
            const data = trimToLastCandles(
                this.sanitizeBinanceCandles(symbol, storageInterval, imported, 'imported'),
                effectiveMaxBars
            );
            return { data, source: 'local', cached: null, hasSqliteBase: false, cacheKey, storageInterval, effectiveMaxBars };
        }

        const sqliteRaw = await loadSqliteCandles(storageSymbol, storageInterval, effectiveMaxBars);
        const sqliteLoadedCandles = sqliteRaw
            ? this.sanitizeBinanceCandles(symbol, storageInterval, sqliteRaw.candles, 'sqlite')
            : null;
        const sqliteSanitized = Boolean(sqliteRaw && sqliteLoadedCandles && sqliteLoadedCandles.length < sqliteRaw.candles.length);
        const sqliteCachedCandles = sqliteLoadedCandles;
        const hasSqliteBase = Boolean(sqliteCachedCandles && sqliteCachedCandles.length > 0);

        let cached: { candles: OHLCVData[]; updatedAt: number; source: string } | null = hasSqliteBase
            ? { candles: sqliteCachedCandles!, updatedAt: Date.now(), source: 'sqlite' }
            : await loadCachedCandles(storageSymbol, storageInterval);
        let cachedSanitized = sqliteSanitized;

        if (cached) {
            const before = cached.candles.length;
            cached = {
                ...cached,
                candles: this.sanitizeBinanceCandles(symbol, storageInterval, cached.candles, String(cached.source ?? 'cache')),
            };
            if (cached.candles.length < before) {
                cachedSanitized = true;
            }
        }

        if (!cached || cached.candles.length === 0) {
            const seedCandles = marketType === "futures"
                ? null
                : await loadSeedCandlesFromPriceData(symbol, interval, signal);
            if (seedCandles && seedCandles.length > 0) {
                const sanitizedSeedCandles = this.sanitizeBinanceCandles(symbol, storageInterval, seedCandles, 'seed-file');
                cached = {
                    candles: sanitizedSeedCandles,
                    updatedAt: Date.now(),
                    source: 'seed-file',
                };
                await this.persistLocalCandles({
                    symbol: storageSymbol,
                    storageInterval,
                    cacheCandles: sanitizedSeedCandles,
                    sqliteCandles: sanitizedSeedCandles,
                    providerLabel,
                    sourceTrait: 'seed-file',
                });
                debugLogger.event('data.cache.seed_loaded', {
                    symbol,
                    interval,
                    bars: sanitizedSeedCandles.length,
                });
            }
        }

        const now = Date.now();
        const lastSyncAt = this.cache.syncAtByKey.get(cacheKey) ?? 0;
        const recentlySynced = now - lastSyncAt < DATA_CACHE_SYNC_MIN_MS;
        const hasCachedData = Boolean(cached && cached.candles.length > 0);
        if (hasCachedData && recentlySynced) {
            if (cachedSanitized) {
                await this.persistLocalCandles({
                    symbol: storageSymbol,
                    storageInterval,
                    cacheCandles: cached!.candles,
                    sqliteCandles: cached!.candles,
                    providerLabel,
                    sourceTrait: 'sanitized',
                });
            }
            return {
                data: trimToLastCandles(cached!.candles, effectiveMaxBars),
                source: 'local',
                cached,
                hasSqliteBase,
                cacheKey,
                storageInterval,
                effectiveMaxBars
            };
        }

        let remoteData: OHLCVData[] = [];

        if (hasCachedData) {
            const cachedCandles = cached!.candles;
            const gapAnchorTime = findFirstGapAnchorTime(cachedCandles, interval);
            const fetchFromTime = gapAnchorTime ?? Number(cachedCandles[cachedCandles.length - 1]?.time ?? 0);
            if (gapAnchorTime !== null) {
                debugLogger.warn('data.series.cached_gap_detected', {
                    symbol,
                    interval,
                    gapAnchorTime,
                    candles: cachedCandles.length,
                });
            }
            remoteData = await fetchBinanceDataAfter(symbol, interval, fetchFromTime, {
                signal,
                requestDelayMs: 80,
                maxRequests: 60,
                marketType,
                ...(resampleOptions ?? {}),
            });
        } else {
            if (hasMaxBars) {
                remoteData = await fetchBinanceDataWithLimit(symbol, interval, effectiveMaxBars, {
                    signal,
                    requestDelayMs: 80,
                    maxRequests: 60,
                    marketType,
                    ...(resampleOptions ?? {}),
                });
            } else {
                remoteData = await fetchBinanceData(symbol, interval, signal, {
                    marketType,
                    ...(resampleOptions ?? {}),
                });
            }
        }

        if (signal?.aborted) {
            return { data: [], source: 'network', cached, hasSqliteBase, cacheKey, storageInterval, effectiveMaxBars };
        }

        remoteData = this.sanitizeBinanceCandles(symbol, storageInterval, remoteData, hasCachedData ? 'binance-gap' : 'binance-full');

        if (!hasCachedData) {
            const fresh = trimToLastCandles(remoteData, effectiveMaxBars);
            if (fresh.length > 0) {
                await this.persistLocalCandles({
                    symbol: storageSymbol,
                    storageInterval,
                    cacheCandles: fresh,
                    sqliteCandles: fresh,
                    providerLabel,
                    sourceTrait: 'binance-full',
                    cacheKey,
                    updateSyncTime: true,
                });
                this.cache.set(cacheKey, fresh, 'network');
            }
            return { data: fresh, source: 'network', cached, hasSqliteBase, cacheKey, storageInterval, effectiveMaxBars };
        }

        if (remoteData.length === 0) {
            this.cache.syncAtByKey.set(cacheKey, Date.now());
            const finalData = trimToLastCandles(cached!.candles, effectiveMaxBars);
            this.cache.set(cacheKey, finalData, 'network');
            return {
                data: finalData,
                source: 'network',
                cached,
                hasSqliteBase,
                cacheKey,
                storageInterval,
                effectiveMaxBars
            };
        }

        const merged = this.sanitizeBinanceCandles(
            symbol,
            storageInterval,
            trimToLastCandles(mergeCandles(cached!.candles, remoteData), effectiveMaxBars),
            'merged'
        );
        if (merged.length > 0) {
            await this.persistLocalCandles({
                symbol: storageSymbol,
                storageInterval,
                cacheCandles: merged,
                sqliteCandles: hasSqliteBase ? remoteData : merged,
                providerLabel,
                sourceTrait: 'binance-gap',
                cacheKey,
                updateSyncTime: true,
            });
        }
        const finalData = merged.length > 0 ? merged : trimToLastCandles(cached!.candles, effectiveMaxBars);
        this.cache.set(cacheKey, finalData, 'network');
        return {
            data: finalData,
            source: 'network',
            cached,
            hasSqliteBase,
            cacheKey,
            storageInterval,
            effectiveMaxBars
        };
    }

    private notifyDataFallback(symbol: string, interval: string): void {
        this.reporter.showToast?.(`Data unavailable for ${symbol} (${interval}). Using mock data.`, 'warning');
    }
}
