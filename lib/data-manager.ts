
import { OHLCVData } from "./types/index";
import { state } from "./state";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";
import {
    fetchBinanceDataAfter,
    fetchBinanceData,
    fetchBinanceDataWithLimit,
    isBinanceInterval,
    startBinanceStream
} from "./dataProviders/binance";
import {
    fetchBybitTradFiData,
    fetchBybitTradFiDataWithLimit,
    fetchBybitTradFiLatest
} from "./dataProviders/bybit";
import {
    fetchPolymarketData,
    fetchPolymarketDataWithLimit,
    isPolymarketEventSymbol,
} from "./dataProviders/polymarket";

import {
    generateMockData,
    isMockSymbol
} from "./dataProviders/mock";
import { tradfiSearchService } from "./tradfi-search-service";
import { HistoricalFetchOptions } from "./types/index";
import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { countRealtimeGapBars, findFirstGapAnchorTime } from "./realtime-gap-utils";
import {
    loadCachedCandles,
    loadSeedCandlesFromPriceData,
    mergeCandles,
    saveCachedCandles,
} from "./candle-cache";
import {
    loadSqliteCandles,
    storeSqliteCandles,
} from "./local-sqlite-api";
import type { ResampleOptions, TwoHourCloseParity } from "./strategies/resample-utils";
import { isTwoHourParityAligned as isTwoHourParityAlignedFromTime } from "./two-hour-parity";
import {
    DATA_CACHE_SYNC_MIN_MS,
    DATA_CHART_TOTAL_LIMIT,
    DATA_MAX_RECONNECT_ATTEMPTS,
} from "./data/constants";
import { commitOhlcvData } from "./state-actions";

type DataProvider = 'binance' | 'bybit-tradfi' | 'polymarket';
type NonBinanceLocalSource = 'imported' | 'sqlite' | 'cache' | 'seed';
type NonBinanceLocalData = { candles: OHLCVData[]; source: NonBinanceLocalSource };
type ProviderFallbackChain = {
    provider: DataProvider | 'mock';
    lookbackBars: number | null;
    maxBars: number;
    resampleOptions?: ResampleOptions;
    localNonBinance: NonBinanceLocalData | null;
};

export class DataManager {
    private static readonly PRICE_JUMP_GUARD_RATIO = 8;
    private nonBinanceProviderOverride: Map<string, DataProvider> = new Map();
    private autoReloadSuppressCount = 0;
    private importedDataByKey: Map<string, OHLCVData[]> = new Map();
    private ws: WebSocket | null = null;
    public isStreaming: boolean = false;
    public streamSymbol: string = '';
    public streamInterval: string = '';
    public streamProvider: DataProvider | '' = '';
    private streamSessionId = 0;

    // Polling state for non-GS providers
    private isPolling: boolean = false;
    private pollTimeout: any = null;
    private pollingInFlight: boolean = false;
    private pollAbort: AbortController | null = null;

    // Stream reconnection state
    private reconnectAttempts: number = 0;
    private reconnectTimeout: any = null;
    private readonly RECONNECT_DELAY_BASE = 1000;

    // UI update throttling
    private lastLogTime: number = 0;
    private lastUiUpdateTime: number = 0;
    private chartLookbackBars: number | null = null;
    private readonly STREAM_PERSIST_DELAY_MS = 1200;
    private cacheSyncAtByKey: Map<string, number> = new Map();
    private cachePersistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private cachePersistPendingByKey: Map<string, { symbol: string; storageInterval: string; candles: OHLCVData[] }> = new Map();
    private realtimeGapFillInFlight: Set<string> = new Set();
    private loadedSymbol: string | null = null;
    private loadedInterval: string | null = null;

    // ============================================================================
    // Public API
    // ============================================================================

    public isMockSymbol(symbol: string): boolean {
        return isMockSymbol(symbol);
    }

    public suppressNextAutoReload(count = 1): void {
        this.autoReloadSuppressCount += Math.max(0, Math.floor(count));
    }

    public shouldSkipAutoReload(): boolean {
        if (this.autoReloadSuppressCount <= 0) return false;
        this.autoReloadSuppressCount -= 1;
        return true;
    }

    public setChartLookbackBars(lookbackBars: number | null): void {
        if (lookbackBars === null || !Number.isFinite(lookbackBars)) {
            this.chartLookbackBars = null;
            return;
        }
        this.chartLookbackBars = Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars)));
    }

    public registerImportedData(symbol: string, interval: string, candles: OHLCVData[]): void {
        const normalizedSymbol = symbol.trim().toUpperCase();
        const normalizedInterval = interval.trim().toLowerCase();
        if (!normalizedSymbol || !normalizedInterval || candles.length === 0) return;

        const storageIntervals = this.getImportStorageIntervals(normalizedInterval);
        const now = Date.now();
        for (const storageInterval of storageIntervals) {
            const cacheKey = this.buildCacheKey(normalizedSymbol, storageInterval);
            this.importedDataByKey.set(cacheKey, candles);
            this.cacheSyncAtByKey.set(cacheKey, now);
        }
    }

    public clearImportedData(): void {
        this.importedDataByKey.clear();
    }

    public getChartLookbackBars(): number | null {
        return this.chartLookbackBars;
    }

    public getLoadedContextKey(): string | null {
        if (!this.loadedSymbol || !this.loadedInterval) return null;
        return `${this.loadedSymbol}|${this.loadedInterval}`;
    }

    public getProvider(symbol: string): DataProvider {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (this.nonBinanceProviderOverride.has(normalizedSymbol)) {
            return this.nonBinanceProviderOverride.get(normalizedSymbol)!;
        }
        if (isPolymarketEventSymbol(symbol)) {
            this.nonBinanceProviderOverride.set(normalizedSymbol, 'polymarket');
            return 'polymarket';
        }
        if (tradfiSearchService.isTradFiSymbol(normalizedSymbol)) {
            this.nonBinanceProviderOverride.set(normalizedSymbol, 'bybit-tradfi');
            return 'bybit-tradfi';
        }

        return 'binance';
    }

    public setProviderOverride(symbol: string, provider: 'binance' | 'bybit-tradfi' | 'polymarket' | null): void {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (!normalizedSymbol) return;

        if (!provider || provider === 'binance') {
            this.nonBinanceProviderOverride.delete(normalizedSymbol);
            return;
        }

        this.nonBinanceProviderOverride.set(normalizedSymbol, provider);
    }

    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        const chain = await this.resolveProviderFallbackChain(symbol, interval, signal);
        return this.fetchDataFromProviderChain(chain, symbol, interval, signal);
    }

    private async resolveProviderFallbackChain(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<ProviderFallbackChain> {
        const lookbackBars = this.chartLookbackBars;
        const maxBars = lookbackBars ?? DATA_CHART_TOTAL_LIMIT;
        const resampleOptions = this.getResampleOptions(interval);

        if (this.isMockSymbol(symbol)) {
            return {
                provider: 'mock',
                lookbackBars,
                maxBars,
                resampleOptions,
                localNonBinance: null,
            };
        }

        const provider = this.getProvider(symbol);
        const localNonBinance = provider !== 'binance'
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

        if (chain.provider === 'binance') {
            return this.fetchBinanceChartData(symbol, interval, signal, chain.lookbackBars);
        }

        if (chain.provider === 'bybit-tradfi') {
            return this.fetchBybitTradFiChartData(chain, symbol, interval, signal);
        }

        if (chain.provider === 'polymarket') {
            return this.fetchPolymarketChartData(chain, symbol, interval, signal);
        }

        const fallback = await this.fetchNonBinanceData(symbol, interval, signal);
        uiManager.updateSymbolDataSource(
            'Fallback',
            'warning',
            'Primary data source was unavailable, so fallback data is being used.'
        );
        return this.sliceToLookback(fallback, chain.lookbackBars);
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
        uiManager.updateSymbolDataSource('Mock data', 'seed', 'Chart is using generated mock candles.');
        return this.sliceToLookback(mockData, lookbackBars);
    }

    private async fetchBinanceChartData(
        symbol: string,
        interval: string,
        signal: AbortSignal | undefined,
        lookbackBars: number | null
    ): Promise<OHLCVData[]> {
        const result = await this.fetchBinanceDataHybridWithMeta(symbol, interval, signal, {
            maxBars: lookbackBars ?? undefined,
        });
        uiManager.updateSymbolDataSource(
            'Live: Binance',
            'live',
            'Chart data is loaded from Binance.'
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
                void this.persistNonBinanceData(
                    symbol,
                    interval,
                    'bybit-tradfi',
                    seededWithLatest.candles,
                    `local-${localNonBinance.source}-overlay`
                );
                uiManager.updateSymbolDataSource(
                    localNonBinance.source === 'seed' ? 'CSV + Bybit' : 'Local + Bybit',
                    'live',
                    localNonBinance.source === 'seed'
                        ? 'Historical candles came from the local CSV seed and the latest candle was refreshed from Bybit.'
                        : 'Historical candles came from local cache/SQLite and the latest candle was refreshed from Bybit.'
                );
                return this.sliceToLookback(seededWithLatest.candles, lookbackBars);
            }

            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            uiManager.updateSymbolDataSource(
                localSourceMeta.label,
                localNonBinance.source === 'seed' ? 'warning' : 'seed',
                `${localSourceMeta.title} Latest refresh from Bybit did not return a candle.`
            );
            return this.sliceToLookback(seededWithLatest.candles, lookbackBars);
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
            uiManager.updateSymbolDataSource(
                'Live: Bybit',
                'live',
                'Chart data is loaded directly from Bybit TradFi.'
            );
            return this.sliceToLookback(merged, lookbackBars);
        }
        if (localNonBinance && localNonBinance.candles.length > 0) {
            const localSourceMeta = this.describeLocalSource(localNonBinance.source);
            uiManager.updateSymbolDataSource(
                localSourceMeta.label,
                'warning',
                `${localSourceMeta.title} Bybit TradFi did not return fresh intraday chart data, so local data is being used.`
            );
            return this.sliceToLookback(localNonBinance.candles, lookbackBars);
        }
        uiManager.showToast('Bybit TradFi returned no data.', 'error');
        uiManager.updateSymbolDataSource(
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
            uiManager.updateSymbolDataSource(localSourceMeta.label, 'seed', localSourceMeta.title);
            return this.sliceToLookback(localNonBinance.candles, lookbackBars);
        }

        const data = typeof lookbackBars === 'number'
            ? await fetchPolymarketDataWithLimit(symbol, interval, lookbackBars, { signal })
            : await fetchPolymarketData(symbol, interval, signal);
        if (data.length > 0) {
            void this.persistNonBinanceData(symbol, interval, 'polymarket', data, 'network');
            uiManager.updateSymbolDataSource(
                'Live: Polymarket',
                'live',
                'Chart data is loaded from Polymarket.'
            );
            return data;
        }
        uiManager.showToast('Polymarket returned no data for this market.', 'error');
        uiManager.updateSymbolDataSource(
            'Polymarket unavailable',
            'warning',
            'Polymarket did not return chart data for this market.'
        );
        return [];
    }

    private async fetchLimitedNonBinanceNetworkData(
        provider: Exclude<DataProvider, 'binance'>,
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

    public async fetchDataForScan(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<OHLCVData[]> {
        const result = await this.fetchDataForScanWithMeta(symbol, interval, signal, lookbackBars);
        return result.data;
    }

    /**
     * Fetch data for scanner with metadata about the data source.
     * Returns whether the data came from local cache or required a network fetch.
     */
    public async fetchDataForScanWithMeta(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<{ data: OHLCVData[]; source: 'mock' | 'local' | 'network' }> {
        if (this.isMockSymbol(symbol)) {
            if (signal?.aborted) return { data: [], source: 'mock' };
            const mockData = generateMockData(symbol, interval);
            const maxBars = Number.isFinite(lookbackBars)
                ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
                : 1000;
            return { data: this.takeLastCandles(mockData, maxBars), source: 'mock' };
        }

        const provider = this.getProvider(symbol);
        const maxBars = Number.isFinite(lookbackBars)
            ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
            : 1000;
        const resampleOptions = this.getResampleOptions(interval);

        if (provider !== 'binance') {
            const localData = await this.loadNonBinanceLocalData(symbol, interval, maxBars, signal);
            if (localData) {
                return {
                    data: this.takeLastCandles(localData.candles, maxBars),
                    source: 'local',
                };
            }
        }
        
        if (provider === 'binance') {
            const result = await this.fetchBinanceDataHybridWithMeta(symbol, interval, signal, {
                maxBars,
            });
            return result;
        }
        
        // Non-Binance providers always hit network
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
        return { data: this.takeLastCandles(fallbackData, maxBars), source: 'network' };
    }

    public async fetchDataWithLimit(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            const data = generateMockData(symbol, interval);
            return this.takeLastCandles(data, limit);
        }

        const provider = this.getProvider(symbol);
        const resampleOptions = this.getResampleOptions(interval);
        const localNonBinance = provider !== 'binance'
            ? await this.loadNonBinanceLocalData(symbol, interval, limit, options?.signal)
            : null;

        if (provider === 'binance') {
            return fetchBinanceDataWithLimit(symbol, interval, limit, {
                ...options,
                ...(resampleOptions ?? {}),
            });
        }

        if (provider === 'bybit-tradfi' || provider === 'polymarket') {
            if (localNonBinance && localNonBinance.candles.length >= limit) {
                return this.takeLastCandles(localNonBinance.candles, limit);
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
            return localNonBinance ? this.takeLastCandles(localNonBinance.candles, limit) : [];
        }

        // For others, fall back to standard fetch (no specific limit optimization yet implemented for 12data/yahoo historical)
        // But we can implement wrapper logic if needed. For now just fetch standard.
        // Actually fetchTwelveData usually fetches 5000 bars.
        const data = await this.fetchNonBinanceData(symbol, interval, options?.signal);
        return this.takeLastCandles(data, limit);
    }

    public async loadData(symbol: string = state.currentSymbol, interval: string = state.currentInterval): Promise<void> {
        await this.setSymbol(symbol, interval);
        // Optional: Trigger any other side effects of loading data
    }

    public async setSymbol(symbol: string, interval: string): Promise<OHLCVData[]> {
        this.clearImportedData();
        this.stopStreaming();
        state.set('currentSymbol', symbol);
        state.set('currentInterval', interval);

        uiManager.clearUI();
        uiManager.updateTimeframeUI(interval);

        const data = await this.fetchData(symbol, interval);
        commitOhlcvData(data, 'set_symbol_load');
        this.loadedSymbol = symbol;
        this.loadedInterval = interval;

        this.startStreaming(symbol, interval);

        return data;
    }

    public async fetchHistoricalData(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions & { onProgress?: (progress: { fetched: number; total: number; requestCount: number }) => void }
    ): Promise<OHLCVData[]> {
        return this.fetchDataWithLimit(symbol, interval, limit, options);
    }

    public startStreaming(symbol: string = state.currentSymbol, interval: string = state.currentInterval): void {
        if (this.isMockSymbol(symbol)) {
            debugLogger.info('data.stream.skip_mock', { symbol });
            return;
        }
        const provider = this.getProvider(symbol);
        if (provider !== 'binance') {
            this.nonBinanceProviderOverride.set(symbol.trim().toUpperCase(), provider);
        }
        if (provider === 'polymarket') {
            debugLogger.info('data.stream.skip_polymarket', { symbol, interval });
            return;
        }
        if (provider === 'binance' && !isBinanceInterval(interval)) {
            debugLogger.info('data.stream.skip_interval', { symbol, interval, provider });
            return;
        }
        const useBinanceAlignedPolling = provider === 'binance' && this.shouldUseBinanceAlignedPolling(interval);

        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval && this.streamProvider === provider) {
            return;
        }

        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.streamProvider = provider;
        this.streamSessionId += 1;
        this.reconnectAttempts = 0;

        if (provider === 'binance' && !useBinanceAlignedPolling) {
            this.connectBinanceStream();
        } else {
            this.startPolling();
        }
    }

    public stopStreaming(): void {
        this.streamSessionId += 1;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        if (this.pollAbort) {
            this.pollAbort.abort();
            this.pollAbort = null;
        }
        this.pollingInFlight = false;
        this.isPolling = false;

        if (this.ws) {
            this.ws.close();
            this.ws = null;
            debugLogger.info('data.stream.stopped', {
                symbol: this.streamSymbol,
                interval: this.streamInterval
            });
        }

        this.isStreaming = false;
        this.streamSymbol = '';
        this.streamInterval = '';
        this.streamProvider = '';
    }

    private isActiveStreamContext(
        sessionId: number,
        symbol: string,
        interval: string,
        provider: DataProvider
    ): boolean {
        return this.streamSessionId === sessionId
            && this.streamSymbol === symbol
            && this.streamInterval === interval
            && this.streamProvider === provider
            && state.currentSymbol === symbol
            && state.currentInterval === interval;
    }

    // ============================================================================
    // Internal Logic
    // ============================================================================

    private async fetchNonBinanceData(symbol: string, interval: string, _signal?: AbortSignal): Promise<OHLCVData[]> {
        // Priority: Fallback to Mock
        this.notifyDataFallback(symbol, interval);
        return generateMockData(symbol, interval);
    }

    private normalizeExternalCandles(candles: OHLCVData[]): OHLCVData[] {
        return mergeCandles([], candles);
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

    private getProviderStorageLabel(provider: DataProvider): string {
        if (provider === 'bybit-tradfi') return 'Bybit TradFi';
        if (provider === 'polymarket') return 'Polymarket';
        return 'Binance';
    }

    private async loadNonBinanceLocalData(
        symbol: string,
        interval: string,
        maxBars: number,
        signal?: AbortSignal
    ): Promise<{ candles: OHLCVData[]; source: NonBinanceLocalSource } | null> {
        const normalizedLimit = Math.max(1, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(maxBars)));
        const storageInterval = this.getStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval);
        const candidates: Array<{ candles: OHLCVData[]; source: NonBinanceLocalSource }> = [];

        const imported = this.importedDataByKey.get(cacheKey);
        if (imported && imported.length > 0) {
            candidates.push({
                candles: this.takeLastCandles(this.normalizeExternalCandles(imported), normalizedLimit),
                source: 'imported',
            });
        }

        const sqliteRaw = await loadSqliteCandles(symbol, storageInterval, normalizedLimit);
        if (sqliteRaw && sqliteRaw.length > 0) {
            candidates.push({
                candles: this.takeLastCandles(this.normalizeExternalCandles(sqliteRaw), normalizedLimit),
                source: 'sqlite',
            });
        }

        const cached = await loadCachedCandles(symbol, storageInterval);
        if (cached && cached.candles.length > 0) {
            candidates.push({
                candles: this.takeLastCandles(this.normalizeExternalCandles(cached.candles), normalizedLimit),
                source: 'cache',
            });
        }

        const seedData = await loadSeedCandlesFromPriceData(symbol, interval, signal);
        if (seedData && seedData.length > 0) {
            candidates.push({
                candles: this.takeLastCandles(this.normalizeExternalCandles(seedData), normalizedLimit),
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

        return candidates[0];
    }

    private async persistNonBinanceData(
        symbol: string,
        interval: string,
        provider: DataProvider,
        candles: OHLCVData[],
        source: string
    ): Promise<void> {
        if (candles.length === 0) return;
        const storageInterval = this.getStorageInterval(interval);
        const normalized = this.normalizeExternalCandles(candles);
        await this.persistLocalCandles({
            symbol,
            storageInterval,
            cacheCandles: normalized,
            sqliteCandles: normalized,
            providerLabel: this.getProviderStorageLabel(provider),
            sourceTrait: source,
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
        const {
            symbol,
            storageInterval,
            cacheCandles,
            sqliteCandles,
            providerLabel,
            sourceTrait,
            cacheKey,
            updateSyncTime = false,
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
            this.cacheSyncAtByKey.set(cacheKey, Date.now());
        }
    }

    private getTwoHourCloseParity(): TwoHourCloseParity {
        return state.twoHourCloseParity === 'even' ? 'even' : 'odd';
    }

    private getResampleOptions(interval: string): ResampleOptions | undefined {
        const normalized = interval.trim().toLowerCase();
        const intervalSeconds = getIntervalSeconds(normalized);
        return intervalSeconds === 7200
            ? { twoHourCloseParity: this.getTwoHourCloseParity() }
            : undefined;
    }

    private getImportStorageIntervals(interval: string): string[] {
        if (interval.includes('@close-')) {
            return [interval];
        }
        if (getIntervalSeconds(interval) === 7200) {
            return [`${interval}@close-odd`, `${interval}@close-even`];
        }
        return [interval];
    }

    private getStorageInterval(interval: string): string {
        const normalized = interval.trim().toLowerCase();
        if (normalized.includes('@close-')) {
            return normalized;
        }
        if (getIntervalSeconds(normalized) === 7200) {
            return `${normalized}@close-${this.getTwoHourCloseParity()}`;
        }
        return normalized;
    }

    private takeLastCandles(candles: OHLCVData[], limit: number): OHLCVData[] {
        const normalizedLimit = Math.max(0, Math.floor(limit));
        if (normalizedLimit <= 0) {
            return [];
        }
        return candles.length > normalizedLimit ? candles.slice(-normalizedLimit) : candles;
    }

    private sliceToLookback(candles: OHLCVData[], lookbackBars: number | null): OHLCVData[] {
        return typeof lookbackBars === 'number' ? this.takeLastCandles(candles, lookbackBars) : candles;
    }

    private getBybitSeedOverlayBars(interval: string, seedData: OHLCVData[]): number {
        const intervalSeconds = getIntervalSeconds(interval);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            return 30;
        }

        const lastSeedTime = seedData.length > 0
            ? parseTimeToUnixSeconds(seedData[seedData.length - 1].time)
            : null;
        if (lastSeedTime === null) {
            return 30;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const gapSec = Math.max(0, nowSec - lastSeedTime);
        const estimatedGapBars = Math.ceil(gapSec / intervalSeconds);
        return Math.max(12, Math.min(240, estimatedGapBars + 10));
    }

    private async mergeBybitRecentIntoSeed(
        symbol: string,
        interval: string,
        seedData: OHLCVData[],
        signal?: AbortSignal,
        options?: ResampleOptions
    ): Promise<{ candles: OHLCVData[]; liveRefreshed: boolean }> {
        try {
            const overlayBars = this.getBybitSeedOverlayBars(interval, seedData);
            const recent = await fetchBybitTradFiDataWithLimit(symbol, interval, overlayBars, {
                signal,
                ...(options ?? {}),
            });
            if (recent.length === 0) {
                return { candles: seedData, liveRefreshed: false };
            }
            const merged = mergeCandles(seedData, recent);
            return {
                candles: merged,
                liveRefreshed: true,
            };
        } catch (error) {
            debugLogger.warn('data.bybit_tradfi.seed_overlay_failed', {
                symbol,
                interval,
                error: String(error),
            });
            return { candles: seedData, liveRefreshed: false };
        }
    }

    private shouldUseBinanceAlignedPolling(interval: string): boolean {
        return getIntervalSeconds(interval.trim().toLowerCase()) === 7200 && this.getTwoHourCloseParity() === 'even';
    }

    private isTwoHourParityAligned(candles: OHLCVData[], parity: TwoHourCloseParity): boolean {
        return isTwoHourParityAlignedFromTime(candles, parity);
    }

    private getIntervalAlignment(interval: string): { intervalSeconds: number; phaseOffsetSeconds: number } | null {
        const normalized = interval.trim().toLowerCase();
        const baseInterval = normalized.split('@')[0];
        const intervalSeconds = getIntervalSeconds(baseInterval);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            return null;
        }

        // Keep weekly/monthly anchors untouched to avoid provider-dependent boundary assumptions.
        if (intervalSeconds > 86400) {
            return null;
        }

        const phaseOffsetSeconds = intervalSeconds === 7200 && normalized.includes('@close-even')
            ? 3600
            : 0;
        return { intervalSeconds, phaseOffsetSeconds };
    }

    private isIntervalAlignedTime(timeSec: number, interval: string): boolean {
        if (!Number.isFinite(timeSec)) return false;
        const alignment = this.getIntervalAlignment(interval);
        if (!alignment) return true;

        const { intervalSeconds, phaseOffsetSeconds } = alignment;
        const remainder = ((timeSec - phaseOffsetSeconds) % intervalSeconds + intervalSeconds) % intervalSeconds;
        return remainder === 0;
    }

    private sanitizeBinanceCandles(
        symbol: string,
        interval: string,
        candles: OHLCVData[],
        source: string
    ): OHLCVData[] {
        if (candles.length <= 1) return candles.slice();

        // Pre-parse times once to avoid repeated parsing in sort and validation loops
        const timeCache = new Map<OHLCVData, number | null>();
        for (const candle of candles) {
            timeCache.set(candle, parseTimeToUnixSeconds(candle.time));
        }

        const sorted = candles
            .slice()
            .sort((a, b) => (timeCache.get(a) ?? 0) - (timeCache.get(b) ?? 0));

        const cleaned: OHLCVData[] = [];
        let dropped = 0;
        const maxRatio = DataManager.PRICE_JUMP_GUARD_RATIO;

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
            if (!this.isIntervalAlignedTime(timeSec, interval)) {
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

    private buildCacheKey(symbol: string, interval: string): string {
        return `${symbol.trim().toUpperCase()}::${this.getStorageInterval(interval)}`;
    }

    /**
     * Fetch Binance data with metadata about the source.
     * Source semantics:
     * - 'local': Data came from cache ONLY (imported, sqlite, indexeddb, or seed), no network call made
     * - 'network': Network was attempted (regardless of whether new data was returned)
     */
    private async fetchBinanceDataHybridWithMeta(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        options?: { maxBars?: number }
    ): Promise<{ data: OHLCVData[]; source: 'local' | 'network' }> {
        const result = await this.fetchBinanceDataHybridInternal(symbol, interval, signal, options);
        return { data: result.data, source: result.source };
    }

    /**
     * Shared internal implementation for Binance data fetching.
     * Eliminates logic drift between fetchBinanceDataHybrid and fetchBinanceDataHybridWithMeta.
     */
    private async fetchBinanceDataHybridInternal(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        options?: { maxBars?: number }
    ): Promise<{ data: OHLCVData[]; source: 'local' | 'network'; cached: { candles: OHLCVData[]; updatedAt: number; source: string } | null; hasSqliteBase: boolean; cacheKey: string; storageInterval: string; effectiveMaxBars: number }> {
        const requestedMaxBars = options?.maxBars;
        const hasMaxBars = typeof requestedMaxBars === 'number' && Number.isFinite(requestedMaxBars);
        const effectiveMaxBars = hasMaxBars
            ? Math.max(1, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(requestedMaxBars)))
            : DATA_CHART_TOTAL_LIMIT;
        const normalizedInterval = interval.trim().toLowerCase();
        const twoHourCloseParity = this.getTwoHourCloseParity();
        const requiresEven2hAlignment = getIntervalSeconds(normalizedInterval) === 7200 && twoHourCloseParity === 'even';
        const storageInterval = this.getStorageInterval(interval);
        const resampleOptions = this.getResampleOptions(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval);

        // Load local cache
        const imported = this.importedDataByKey.get(cacheKey);
        if (imported && imported.length > 0) {
            const data = this.takeLastCandles(
                this.sanitizeBinanceCandles(symbol, storageInterval, imported, 'imported'),
                effectiveMaxBars
            );
            return { data, source: 'local', cached: null, hasSqliteBase: false, cacheKey, storageInterval, effectiveMaxBars };
        }

        const sqliteRaw = await loadSqliteCandles(symbol, storageInterval, effectiveMaxBars);
        const sqliteLoadedCandles = sqliteRaw
            ? this.sanitizeBinanceCandles(symbol, storageInterval, sqliteRaw, 'sqlite')
            : null;
        const sqliteSanitized = Boolean(sqliteRaw && sqliteLoadedCandles && sqliteLoadedCandles.length < sqliteRaw.length);
        const sqliteCachedCandles = (requiresEven2hAlignment && sqliteLoadedCandles && !this.isTwoHourParityAligned(sqliteLoadedCandles, 'even'))
            ? null
            : sqliteLoadedCandles;
        const hasSqliteBase = Boolean(sqliteCachedCandles && sqliteCachedCandles.length > 0);

        let cached: { candles: OHLCVData[]; updatedAt: number; source: string } | null = hasSqliteBase
            ? { candles: sqliteCachedCandles!, updatedAt: Date.now(), source: 'sqlite' }
            : await loadCachedCandles(symbol, storageInterval);
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

        if (requiresEven2hAlignment && cached && !this.isTwoHourParityAligned(cached.candles, 'even')) {
            cached = null;
        }

        if (!cached || cached.candles.length === 0) {
            const seedCandles = requiresEven2hAlignment
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
                    symbol,
                    storageInterval,
                    cacheCandles: sanitizedSeedCandles,
                    sqliteCandles: sanitizedSeedCandles,
                    providerLabel: 'Binance',
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
        const lastSyncAt = this.cacheSyncAtByKey.get(cacheKey) ?? 0;
        const recentlySynced = now - lastSyncAt < DATA_CACHE_SYNC_MIN_MS;
        const hasCachedData = Boolean(cached && cached.candles.length > 0);
        // Return cache immediately when recently synced.
        if (hasCachedData && recentlySynced) {
            if (cachedSanitized) {
                await this.persistLocalCandles({
                    symbol,
                    storageInterval,
                    cacheCandles: cached!.candles,
                    sqliteCandles: cached!.candles,
                    providerLabel: 'Binance',
                    sourceTrait: 'sanitized',
                });
            }
            return {
                data: this.takeLastCandles(cached!.candles, effectiveMaxBars),
                source: 'local',
                cached,
                hasSqliteBase,
                cacheKey,
                storageInterval,
                effectiveMaxBars
            };
        }

        // Need network fetch
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
                ...(resampleOptions ?? {}),
            });
        } else {
            if (hasMaxBars) {
                remoteData = await fetchBinanceDataWithLimit(symbol, interval, effectiveMaxBars, {
                    signal,
                    requestDelayMs: 80,
                    maxRequests: 60,
                    ...(resampleOptions ?? {}),
                });
            } else {
                remoteData = await fetchBinanceData(symbol, interval, signal, resampleOptions);
            }
        }

        if (signal?.aborted) {
            return { data: [], source: 'network', cached, hasSqliteBase, cacheKey, storageInterval, effectiveMaxBars };
        }

        remoteData = this.sanitizeBinanceCandles(symbol, storageInterval, remoteData, hasCachedData ? 'binance-gap' : 'binance-full');

        // No cached data case: always network
        if (!hasCachedData) {
            const fresh = this.takeLastCandles(remoteData, effectiveMaxBars);
            if (fresh.length > 0) {
                await this.persistLocalCandles({
                    symbol,
                    storageInterval,
                    cacheCandles: fresh,
                    sqliteCandles: fresh,
                    providerLabel: 'Binance',
                    sourceTrait: 'binance-full',
                    cacheKey,
                    updateSyncTime: true,
                });
            }
            return { data: fresh, source: 'network', cached, hasSqliteBase, cacheKey, storageInterval, effectiveMaxBars };
        }

        // Have cached data, network returned nothing new
        if (remoteData.length === 0) {
            this.cacheSyncAtByKey.set(cacheKey, Date.now());
            return {
                data: this.takeLastCandles(cached!.candles, effectiveMaxBars),
                source: 'network',
                cached,
                hasSqliteBase,
                cacheKey,
                storageInterval,
                effectiveMaxBars
            };
        }

        // Have cached data, merge with network
        const merged = this.sanitizeBinanceCandles(
            symbol,
            storageInterval,
            this.takeLastCandles(mergeCandles(cached!.candles, remoteData), effectiveMaxBars),
            'merged'
        );
        if (merged.length > 0) {
            await this.persistLocalCandles({
                symbol,
                storageInterval,
                cacheCandles: merged,
                sqliteCandles: hasSqliteBase ? remoteData : merged,
                providerLabel: 'Binance',
                sourceTrait: 'binance-gap',
                cacheKey,
                updateSyncTime: true,
            });
        }
        return {
            data: merged.length > 0 ? merged : this.takeLastCandles(cached!.candles, effectiveMaxBars),
            source: 'network',
            cached,
            hasSqliteBase,
            cacheKey,
            storageInterval,
            effectiveMaxBars
        };
    }

    private queuePersistCandles(
        symbol: string,
        interval: string,
        candles: OHLCVData[],
        provider: DataProvider | '' = ''
    ): void {
        if (!symbol || !interval || candles.length === 0) return;
        const storageInterval = this.getStorageInterval(interval);
        const cacheKey = this.buildCacheKey(symbol, storageInterval);
        this.cachePersistPendingByKey.set(cacheKey, {
            symbol,
            storageInterval,
            candles,
        });

        const existingTimer = this.cachePersistTimers.get(cacheKey);
        if (existingTimer) return;

        const timer = setTimeout(() => {
            this.cachePersistTimers.delete(cacheKey);
            void (async () => {
                const pending = this.cachePersistPendingByKey.get(cacheKey);
                this.cachePersistPendingByKey.delete(cacheKey);
                if (!pending || pending.candles.length === 0) return;

                const snapshot = pending.candles.length > DATA_CHART_TOTAL_LIMIT
                    ? pending.candles.slice(-DATA_CHART_TOTAL_LIMIT)
                    : pending.candles.slice();
                const delta = snapshot.slice(-2);
                const sqliteResult = await storeSqliteCandles(
                    pending.symbol,
                    pending.storageInterval,
                    delta,
                    provider ? this.getProviderStorageLabel(provider) : 'Binance',
                    'stream'
                );
                const lastSync = this.cacheSyncAtByKey.get(cacheKey) ?? 0;
                const shouldPersistSnapshot = !sqliteResult || (Date.now() - lastSync >= DATA_CACHE_SYNC_MIN_MS);
                await this.persistLocalCandles({
                    symbol: pending.symbol,
                    storageInterval: pending.storageInterval,
                    cacheCandles: shouldPersistSnapshot ? snapshot : undefined,
                    providerLabel: provider ? this.getProviderStorageLabel(provider) : 'Binance',
                    sourceTrait: 'stream',
                    cacheKey,
                    updateSyncTime: true,
                });
            })();
        }, this.STREAM_PERSIST_DELAY_MS);
        this.cachePersistTimers.set(cacheKey, timer);
    }

    private notifyDataFallback(symbol: string, interval: string): void {
        uiManager.showToast(`Data unavailable for ${symbol} (${interval}). Using mock data.`, 'warning');
    }

    private connectBinanceStream(): void {
        const symbol = this.streamSymbol;
        const interval = this.streamInterval;
        const sessionId = this.streamSessionId;

        debugLogger.info('data.stream.connecting', { symbol, interval });

        try {
            this.ws = startBinanceStream(
                symbol,
                interval,
                (candle) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, 'binance')) return;
                    this.handleStreamUpdate(candle, sessionId, symbol, interval, 'binance');
                },
                (error) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, 'binance')) return;
                    debugLogger.error('data.stream.error', { error: String(error) });
                },
                (event) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, 'binance')) return;
                    this.handleStreamClose(event);
                }
            );

            // WebSocket state handled by browser API, we just assume connected for now or handle in callbacks
            this.isStreaming = true;
            debugLogger.event('data.stream.connected', { symbol, interval });
        } catch (error) {
            debugLogger.error('data.stream.connection_failed', { error: String(error) });
            this.attemptReconnect();
        }
    }

    private handleStreamUpdate(
        candle: OHLCVData,
        sessionId?: number,
        symbol?: string,
        interval?: string,
        provider?: DataProvider
    ): void {
        if (
            sessionId !== undefined &&
            symbol !== undefined &&
            interval !== undefined &&
            provider !== undefined &&
            !this.isActiveStreamContext(sessionId, symbol, interval, provider)
        ) {
            return;
        }
        const gapBars = this.applyRealtimeCandle(candle);
        if (gapBars > 0 && sessionId !== undefined && symbol !== undefined && interval !== undefined && provider !== undefined) {
            debugLogger.warn('data.stream.gap_detected', {
                symbol,
                interval,
                gapBars,
                latestTime: candle.time,
            });
            void this.backfillRealtimeGap(sessionId, symbol, interval, provider, candle.time);
        }

        const now = Date.now();
        if (!this.lastLogTime || now - this.lastLogTime > 10000) {
            this.lastLogTime = now;
            debugLogger.info('data.stream.update', {
                symbol: this.streamSymbol,
                close: candle.close
            });
        }
    }

    private handleStreamClose(event: CloseEvent): void {
        this.isStreaming = false;
        debugLogger.warn('data.stream.closed', { code: event.code, reason: event.reason });
        if (event.code !== 1000 && this.streamSymbol) {
            this.attemptReconnect();
        }
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= DATA_MAX_RECONNECT_ATTEMPTS) {
            debugLogger.error('data.stream.max_reconnects', { attempts: this.reconnectAttempts });
            return;
        }

        this.reconnectAttempts++;
        const delay = this.RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectAttempts - 1);

        debugLogger.info('data.stream.reconnecting', { attempt: this.reconnectAttempts, delay });

        this.reconnectTimeout = setTimeout(() => {
            if (this.streamSymbol && this.streamInterval && this.streamProvider === 'binance') {
                this.connectBinanceStream();
            }
        }, delay);
    }

    private startPolling(): void {
        this.isStreaming = true;
        this.isPolling = true;
        this.pollingInFlight = false;
        this.scheduleNextPoll(0);
        debugLogger.event('data.stream.polling_started', {
            symbol: this.streamSymbol,
            interval: this.streamInterval
        });
    }

    private scheduleNextPoll(delayMs?: number): void {
        if (!this.isPolling || !this.streamSymbol) return;

        if (this.pollTimeout) clearTimeout(this.pollTimeout);

        const delay = delayMs ?? this.getPollingDelayMs(this.streamInterval, this.streamProvider);
        this.pollTimeout = setTimeout(() => this.pollLatest(), delay);
    }

    private getPollingDelayMs(interval: string, provider: DataProvider | '' = ''): number {
        const seconds = getIntervalSeconds(interval);
        if (!Number.isFinite(seconds) || seconds <= 0) return 30000;
        if (provider === 'bybit-tradfi') {
            if (seconds <= 300) return 15000;
            if (seconds <= 3600) return 30000;
            return 60000;
        }
        if (seconds <= 60) return 15000;
        if (seconds <= 300) return 30000;
        if (seconds <= 3600) return 60000;
        return 300000;
    }

    private async pollLatest(): Promise<void> {
        if (!this.isPolling || !this.streamSymbol) return;
        if (this.pollingInFlight) {
            this.scheduleNextPoll();
            return;
        }

        this.pollingInFlight = true;
        if (this.pollAbort) this.pollAbort.abort();
        const abort = new AbortController();
        this.pollAbort = abort;

        const symbol = this.streamSymbol;
        const interval = this.streamInterval;
        const provider = this.streamProvider;
        const sessionId = this.streamSessionId;

        try {
            let candle: OHLCVData | null = null;
            const resampleOptions = this.getResampleOptions(interval);

            if (this.streamProvider === 'bybit-tradfi') {
                candle = await fetchBybitTradFiLatest(symbol, interval, abort.signal, resampleOptions);
            } else if (this.streamProvider === 'binance' && this.shouldUseBinanceAlignedPolling(interval)) {
                const latestSeries = await fetchBinanceDataWithLimit(symbol, interval, 2, {
                    signal: abort.signal,
                    maxRequests: 2,
                    ...(resampleOptions ?? {}),
                });
                candle = latestSeries[latestSeries.length - 1] ?? null;
            }

            if (abort.signal.aborted) return;

            if (candle && (provider === 'binance' || provider === 'bybit-tradfi' || provider === 'polymarket')) {
                if (provider === 'bybit-tradfi') {
                    uiManager.updateSymbolDataSource(
                        'Live: Bybit',
                        'live',
                        'Latest candle refresh from Bybit TradFi is active.'
                    );
                }
                this.handleStreamUpdate(candle, sessionId, symbol, interval, provider);
            }
        } catch (error) {
            debugLogger.warn('data.stream.poll_error', { error: String(error) });
            if (provider === 'bybit-tradfi') {
                uiManager.updateSymbolDataSource(
                    'Bybit refresh failed',
                    'warning',
                    'Latest refresh from Bybit TradFi failed. The chart is showing the last loaded data.'
                );
            }
        } finally {
            this.pollingInFlight = false;
            this.scheduleNextPoll();
        }
    }

    private async backfillRealtimeGap(
        sessionId: number,
        symbol: string,
        interval: string,
        provider: DataProvider,
        latestTime: unknown
    ): Promise<void> {
        if (provider !== 'binance') return;
        if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;

        const currentData = state.ohlcvData;
        const previousCandle = currentData[currentData.length - 2];
        if (!previousCandle) return;

        const fromTimeSec = parseTimeToUnixSeconds(previousCandle.time);
        const latestTimeSec = parseTimeToUnixSeconds(latestTime);
        if (fromTimeSec === null || latestTimeSec === null || latestTimeSec <= fromTimeSec) return;

        const gapKey = `${sessionId}|${symbol}|${interval}|${fromTimeSec}`;
        if (this.realtimeGapFillInFlight.has(gapKey)) return;
        this.realtimeGapFillInFlight.add(gapKey);

        try {
            const resampleOptions = this.getResampleOptions(interval);
            const storageInterval = this.getStorageInterval(interval);
            const fetched = await fetchBinanceDataAfter(symbol, interval, fromTimeSec, {
                maxRequests: 60,
                requestDelayMs: 80,
                ...(resampleOptions ?? {}),
            });
            const sanitized = this.sanitizeBinanceCandles(symbol, storageInterval, fetched, 'stream-gap-fill');
            if (sanitized.length === 0) return;
            if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;

            const merged = this.takeLastCandles(
                this.sanitizeBinanceCandles(
                    symbol,
                    storageInterval,
                    mergeCandles(state.ohlcvData, sanitized),
                    'stream-gap-merge'
                ),
                this.chartLookbackBars ?? DATA_CHART_TOTAL_LIMIT
            );

            commitOhlcvData(merged, 'realtime_gap_fill');
            this.queuePersistCandles(symbol, interval, merged, provider);

            debugLogger.event('data.stream.gap_filled', {
                symbol,
                interval,
                gapBars: countRealtimeGapBars(previousCandle.time, latestTime, interval),
                fetched: sanitized.length,
                candles: merged.length,
            });
        } catch (error) {
            debugLogger.warn('data.stream.gap_fill_failed', {
                symbol,
                interval,
                error: String(error),
            });
        } finally {
            this.realtimeGapFillInFlight.delete(gapKey);
        }
    }

    private applyRealtimeCandle(updatedCandle: OHLCVData): number {
        const streamInterval = this.streamInterval || state.currentInterval;
        const updatedTimeSec = parseTimeToUnixSeconds(updatedCandle.time);
        if (updatedTimeSec === null || !this.isIntervalAlignedTime(updatedTimeSec, streamInterval)) {
            debugLogger.warn('data.stream.rejected_misaligned_candle', {
                symbol: this.streamSymbol || state.currentSymbol,
                interval: streamInterval,
                time: updatedCandle.time,
            });
            return 0;
        }

        const currentData = state.ohlcvData;
        let changed = false;
        let gapBars = 0;
        if (currentData.length === 0) {
            state.set('ohlcvData', [updatedCandle]);
            changed = true;
        } else {
            const lastCandle = currentData[currentData.length - 1];
            const lastClose = Number(lastCandle.close);
            const nextClose = Number(updatedCandle.close);
            if (Number.isFinite(lastClose) && Number.isFinite(nextClose) && lastClose > 0 && nextClose > 0) {
                const ratio = nextClose / lastClose;
                if (ratio > DataManager.PRICE_JUMP_GUARD_RATIO || ratio < (1 / DataManager.PRICE_JUMP_GUARD_RATIO)) {
                    debugLogger.warn('data.stream.rejected_outlier_candle', {
                        symbol: this.streamSymbol || state.currentSymbol,
                        interval: this.streamInterval || state.currentInterval,
                        lastClose,
                        nextClose,
                        ratio,
                    });
                    return 0;
                }
            }
            if (lastCandle.time === updatedCandle.time) {
                currentData[currentData.length - 1] = updatedCandle;
                changed = true;
            } else if (updatedCandle.time > lastCandle.time) {
                gapBars = countRealtimeGapBars(lastCandle.time, updatedCandle.time, streamInterval);
                currentData.push(updatedCandle);
                const activeLimit = this.chartLookbackBars ?? DATA_CHART_TOTAL_LIMIT;
                if (currentData.length > activeLimit) {
                    const overflow = currentData.length - activeLimit;
                    currentData.splice(0, overflow);
                }
                changed = true;
            }
        }

        if (!changed) return 0;

        if (state.candlestickSeries) {
            state.candlestickSeries.update(updatedCandle);
        }

        const persistedData = state.ohlcvData;
        const persistSymbol = this.streamSymbol || state.currentSymbol;
        const persistInterval = this.streamInterval || state.currentInterval;
        this.queuePersistCandles(
            persistSymbol,
            persistInterval,
            persistedData,
            this.streamProvider || this.getProvider(persistSymbol)
        );

        const now = Date.now();
        if (!this.lastUiUpdateTime || now - this.lastUiUpdateTime > 1000) {
            this.lastUiUpdateTime = now;
            uiManager.updatePriceDisplay();
        }

        return gapBars;
    }
}

export const dataManager = new DataManager();
