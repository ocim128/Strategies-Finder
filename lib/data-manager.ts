

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
    generateMockData,
    isMockSymbol
} from "./dataProviders/mock";
import { tradfiSearchService } from "./tradfi-search-service";
import { HistoricalFetchOptions } from "./types/index";
import { getIntervalSeconds } from "./dataProviders/utils";
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
import {
    DATA_CACHE_SYNC_MIN_MS,
    DATA_CHART_TOTAL_LIMIT,
    DATA_MAX_RECONNECT_ATTEMPTS,
} from "./data/constants";

type DataProvider = 'binance' | 'bybit-tradfi';

export class DataManager {
    private nonBinanceProviderOverride: Map<string, DataProvider> = new Map();
    private autoReloadSuppressCount = 0;
    private ws: WebSocket | null = null;
    public isStreaming: boolean = false;
    public streamSymbol: string = '';
    public streamInterval: string = '';
    public streamProvider: string = '';

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

    public getChartLookbackBars(): number | null {
        return this.chartLookbackBars;
    }

    public getProvider(symbol: string): DataProvider {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (this.nonBinanceProviderOverride.has(normalizedSymbol)) {
            return this.nonBinanceProviderOverride.get(normalizedSymbol)!;
        }
        if (tradfiSearchService.isTradFiSymbol(normalizedSymbol)) {
            this.nonBinanceProviderOverride.set(normalizedSymbol, 'bybit-tradfi');
            return 'bybit-tradfi';
        }

        return 'binance';
    }

    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        const lookbackBars = this.chartLookbackBars;
        const resampleOptions = this.getResampleOptions(interval);

        if (this.isMockSymbol(symbol)) {
            await new Promise(resolve => setTimeout(resolve, 600)); // Simulate latency
            if (signal?.aborted) return [];
            const mockData = generateMockData(symbol, interval);
            return typeof lookbackBars === 'number' ? mockData.slice(-lookbackBars) : mockData;
        }

        const provider = this.getProvider(symbol);

        if (provider === 'binance') {
            return this.fetchBinanceDataHybrid(symbol, interval, signal, {
                maxBars: lookbackBars ?? undefined,
            });
        }

        if (provider === 'bybit-tradfi') {
            const data = typeof lookbackBars === 'number'
                ? await fetchBybitTradFiDataWithLimit(symbol, interval, lookbackBars, {
                    signal,
                    ...(resampleOptions ?? {}),
                })
                : await fetchBybitTradFiData(symbol, interval, signal, resampleOptions);
            if (data.length > 0) return data;
            uiManager.showToast('Bybit TradFi returned no data.', 'error');
            return [];
        }

        // Fallback or explicit provider logic for others
        const fallback = await this.fetchNonBinanceData(symbol, interval, signal);
        return typeof lookbackBars === 'number' ? fallback.slice(-lookbackBars) : fallback;
    }

    public async fetchDataForScan(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            if (signal?.aborted) return [];
            const mockData = generateMockData(symbol, interval);
            const maxBars = Number.isFinite(lookbackBars)
                ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
                : 1000;
            return mockData.slice(-maxBars);
        }

        const provider = this.getProvider(symbol);
        const maxBars = Number.isFinite(lookbackBars)
            ? Math.max(200, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(lookbackBars!)))
            : 1000;
        const resampleOptions = this.getResampleOptions(interval);
        if (provider === 'binance') {
            return this.fetchBinanceDataHybrid(symbol, interval, signal, {
                localOnlyIfPresent: true,
                maxBars,
            });
        }
        if (provider === 'bybit-tradfi') {
            return fetchBybitTradFiDataWithLimit(symbol, interval, maxBars, {
                signal,
                ...(resampleOptions ?? {}),
            });
        }
        const fallbackData = await this.fetchNonBinanceData(symbol, interval, signal);
        return fallbackData.slice(-maxBars);
    }

    public async fetchDataWithLimit(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            const data = generateMockData(symbol, interval);
            return data.slice(-limit);
        }

        const provider = this.getProvider(symbol);
        const resampleOptions = this.getResampleOptions(interval);

        if (provider === 'binance') {
            return fetchBinanceDataWithLimit(symbol, interval, limit, {
                ...options,
                ...(resampleOptions ?? {}),
            });
        }

        if (provider === 'bybit-tradfi') {
            return fetchBybitTradFiDataWithLimit(symbol, interval, limit, {
                ...options,
                ...(resampleOptions ?? {}),
            });
        }

        // For others, fall back to standard fetch (no specific limit optimization yet implemented for 12data/yahoo historical)
        // But we can implement wrapper logic if needed. For now just fetch standard.
        // Actually fetchTwelveData usually fetches 5000 bars.
        const data = await this.fetchNonBinanceData(symbol, interval, options?.signal);
        return data.slice(-limit);
    }

    public async loadData(symbol: string = state.currentSymbol, interval: string = state.currentInterval): Promise<void> {
        await this.setSymbol(symbol, interval);
        // Optional: Trigger any other side effects of loading data
    }

    public async setSymbol(symbol: string, interval: string): Promise<OHLCVData[]> {
        this.stopStreaming();
        state.set('currentSymbol', symbol);
        state.set('currentInterval', interval);

        uiManager.clearUI();
        uiManager.updateTimeframeUI(interval);

        const data = await this.fetchData(symbol, interval);
        state.set('ohlcvData', data);

        if (!state.replayMode) {
            this.startStreaming(symbol, interval);
        }

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
        this.reconnectAttempts = 0;

        if (provider === 'binance' && !useBinanceAlignedPolling) {
            this.connectBinanceStream();
        } else {
            this.startPolling();
        }
    }

    public stopStreaming(): void {
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

    // ============================================================================
    // Internal Logic
    // ============================================================================

    private async fetchNonBinanceData(symbol: string, interval: string, _signal?: AbortSignal): Promise<OHLCVData[]> {
        // Priority: Fallback to Mock
        this.notifyDataFallback(symbol, interval);
        return generateMockData(symbol, interval);
    }

    private getTwoHourCloseParity(): TwoHourCloseParity {
        if (typeof document === 'undefined') return 'odd';
        const select = document.getElementById('twoHourCloseParity') as HTMLSelectElement | null;
        return select?.value === 'even' ? 'even' : 'odd';
    }

    private getResampleOptions(interval: string): ResampleOptions | undefined {
        const normalized = interval.trim().toLowerCase();
        const intervalSeconds = getIntervalSeconds(normalized);
        return intervalSeconds === 7200
            ? { twoHourCloseParity: this.getTwoHourCloseParity() }
            : undefined;
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

    private shouldUseBinanceAlignedPolling(interval: string): boolean {
        return getIntervalSeconds(interval.trim().toLowerCase()) === 7200 && this.getTwoHourCloseParity() === 'even';
    }

    private isTwoHourParityAligned(candles: OHLCVData[], parity: TwoHourCloseParity): boolean {
        if (!candles.length) return true;
        const expectedRemainder = parity === 'even' ? 3600 : 0;
        const mod = ((Number(candles[0].time) % 7200) + 7200) % 7200;
        return mod === expectedRemainder;
    }

    private buildCacheKey(symbol: string, interval: string): string {
        return `${symbol.trim().toUpperCase()}::${this.getStorageInterval(interval)}`;
    }

    private async fetchBinanceDataHybrid(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        options?: { localOnlyIfPresent?: boolean; maxBars?: number }
    ): Promise<OHLCVData[]> {
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
        const sqliteLoadedCandles = await loadSqliteCandles(symbol, storageInterval, effectiveMaxBars);
        const sqliteCachedCandles = (requiresEven2hAlignment && sqliteLoadedCandles && !this.isTwoHourParityAligned(sqliteLoadedCandles, 'even'))
            ? null
            : sqliteLoadedCandles;
        const hasSqliteBase = Boolean(sqliteCachedCandles && sqliteCachedCandles.length > 0);
        let cached = hasSqliteBase
            ? {
                candles: sqliteCachedCandles!,
                updatedAt: Date.now(),
                source: 'sqlite',
            }
            : await loadCachedCandles(symbol, storageInterval);

        if (requiresEven2hAlignment && cached && !this.isTwoHourParityAligned(cached.candles, 'even')) {
            cached = null;
        }

        if (!cached || cached.candles.length === 0) {
            // Seed files are plain interval snapshots; for 2h-even they can be odd-aligned.
            const seedCandles = requiresEven2hAlignment
                ? null
                : await loadSeedCandlesFromPriceData(symbol, interval, signal);
            if (seedCandles && seedCandles.length > 0) {
                cached = {
                    candles: seedCandles,
                    updatedAt: Date.now(),
                    source: 'seed-file',
                };
                await saveCachedCandles(symbol, storageInterval, seedCandles, 'seed-file');
                await storeSqliteCandles(symbol, storageInterval, seedCandles, 'Binance', 'seed-file');
                debugLogger.event('data.cache.seed_loaded', {
                    symbol,
                    interval,
                    bars: seedCandles.length,
                });
            }
        }

        const now = Date.now();
        const lastSyncAt = this.cacheSyncAtByKey.get(cacheKey) ?? 0;
        const recentlySynced = now - lastSyncAt < DATA_CACHE_SYNC_MIN_MS;
        const hasCachedData = Boolean(cached && cached.candles.length > 0);
        const localOnlyIfPresent = Boolean(options?.localOnlyIfPresent);

        if (localOnlyIfPresent && hasCachedData && recentlySynced) {
            return cached!.candles.slice(-effectiveMaxBars);
        }
        if (hasCachedData && recentlySynced) {
            return cached!.candles.slice(-effectiveMaxBars);
        }

        let remoteData: OHLCVData[] = [];
        if (hasCachedData) {
            const cachedCandles = cached!.candles;
            const lastCachedTime = Number(cachedCandles[cachedCandles.length - 1]?.time ?? 0);
            remoteData = await fetchBinanceDataAfter(symbol, interval, lastCachedTime, {
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
            return [];
        }

        if (!hasCachedData) {
            const fresh = remoteData.slice(-effectiveMaxBars);
            if (fresh.length > 0) {
                await saveCachedCandles(symbol, storageInterval, fresh, 'binance-full');
                await storeSqliteCandles(symbol, storageInterval, fresh, 'Binance', 'binance-full');
                this.cacheSyncAtByKey.set(cacheKey, Date.now());
            }
            return fresh;
        }

        if (remoteData.length === 0) {
            this.cacheSyncAtByKey.set(cacheKey, Date.now());
            return cached!.candles.slice(-effectiveMaxBars);
        }

        const merged = mergeCandles(cached!.candles, remoteData).slice(-effectiveMaxBars);
        if (merged.length > 0) {
            await saveCachedCandles(symbol, storageInterval, merged, 'binance-gap');
            if (hasSqliteBase) {
                await storeSqliteCandles(symbol, storageInterval, remoteData, 'Binance', 'binance-gap');
            } else {
                await storeSqliteCandles(symbol, storageInterval, merged, 'Binance', 'binance-gap');
            }
            this.cacheSyncAtByKey.set(cacheKey, Date.now());
            return merged;
        }

        return cached!.candles.slice(-effectiveMaxBars);
    }

    private queuePersistCandles(symbol: string, interval: string, candles: OHLCVData[]): void {
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
                    'Binance',
                    'stream'
                );
                const lastSync = this.cacheSyncAtByKey.get(cacheKey) ?? 0;
                const shouldPersistSnapshot = !sqliteResult || (Date.now() - lastSync >= DATA_CACHE_SYNC_MIN_MS);
                if (shouldPersistSnapshot) {
                    await saveCachedCandles(pending.symbol, pending.storageInterval, snapshot, 'stream');
                }
                this.cacheSyncAtByKey.set(cacheKey, Date.now());
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

        debugLogger.info('data.stream.connecting', { symbol, interval });

        try {
            this.ws = startBinanceStream(
                symbol,
                interval,
                (candle) => this.handleStreamUpdate(candle),
                (error) => debugLogger.error('data.stream.error', { error: String(error) }),
                (event) => this.handleStreamClose(event)
            );

            // WebSocket state handled by browser API, we just assume connected for now or handle in callbacks
            this.isStreaming = true;
            debugLogger.event('data.stream.connected', { symbol, interval });
        } catch (error) {
            debugLogger.error('data.stream.connection_failed', { error: String(error) });
            this.attemptReconnect();
        }
    }

    private handleStreamUpdate(candle: OHLCVData): void {
        if (state.replayMode) return;

        this.applyRealtimeCandle(candle);

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

        const delay = delayMs ?? this.getPollingDelayMs(this.streamInterval);
        this.pollTimeout = setTimeout(() => this.pollLatest(), delay);
    }

    private getPollingDelayMs(interval: string): number {
        const seconds = getIntervalSeconds(interval);
        if (!Number.isFinite(seconds) || seconds <= 0) return 30000;
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

            if (candle) {
                // Ensure timestamp is strictly increasing or same? 
                // We trust applyRealtimeCandle specific logic.
                this.handleStreamUpdate(candle);
            }
        } catch (error) {
            debugLogger.warn('data.stream.poll_error', { error: String(error) });
        } finally {
            this.pollingInFlight = false;
            this.scheduleNextPoll();
        }
    }

    private applyRealtimeCandle(updatedCandle: OHLCVData): void {
        if (state.replayMode) return;

        if (state.candlestickSeries) {
            state.candlestickSeries.update(updatedCandle);
        }

        const currentData = state.ohlcvData;
        let changed = false;
        if (currentData.length === 0) {
            state.set('ohlcvData', [updatedCandle]);
            changed = true;
        } else {
            const lastCandle = currentData[currentData.length - 1];
            if (lastCandle.time === updatedCandle.time) {
                currentData[currentData.length - 1] = updatedCandle;
                changed = true;
            } else if (updatedCandle.time > lastCandle.time) {
                currentData.push(updatedCandle);
                const activeLimit = this.chartLookbackBars ?? DATA_CHART_TOTAL_LIMIT;
                if (currentData.length > activeLimit) {
                    const overflow = currentData.length - activeLimit;
                    currentData.splice(0, overflow);
                }
                changed = true;
            }
        }

        if (!changed) return;

        const persistedData = state.ohlcvData;
        const persistSymbol = this.streamSymbol || state.currentSymbol;
        const persistInterval = this.streamInterval || state.currentInterval;
        this.queuePersistCandles(persistSymbol, persistInterval, persistedData);

        const now = Date.now();
        if (!this.lastUiUpdateTime || now - this.lastUiUpdateTime > 1000) {
            this.lastUiUpdateTime = now;
            uiManager.updatePriceDisplay();
        }
    }
}

export const dataManager = new DataManager();
