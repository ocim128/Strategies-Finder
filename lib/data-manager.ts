
import { OHLCVData, HistoricalFetchOptions } from "./types/index";
import type { DataProvider } from "./types/data-providers";
import {
    getBinanceMarketTypeForProvider,
    isBinanceDataProvider,
    type BinanceDataProvider,
} from "./binance-market";
import { state } from "./state";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";
import {
    fetchBinanceDataAfter,
    fetchBinanceDataWithLimit,
    isBinanceInterval,
    startBinanceStream
} from "./dataProviders/binance";
import {
    fetchBybitTradFiLatest
} from "./dataProviders/bybit";
import {
    isMockSymbol
} from "./dataProviders/mock";
import { getIntervalSeconds } from "./dataProviders/utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { countRealtimeGapBars } from "./realtime-gap-utils";
import { mergeCandles } from "./candle-cache";
import type { ResampleOptions } from "./strategies/resample-utils";
import {
    DATA_CHART_TOTAL_LIMIT,
    DATA_MAX_RECONNECT_ATTEMPTS,
} from "./data/constants";
import {
    getImportStorageIntervals as resolveImportStorageIntervals,
    getStorageInterval as resolveStorageInterval,
    isIntervalAlignedTime as checkIntervalAlignedTime,
    takeLastCandles as trimToLastCandles,
} from "./data/data-interval-utils";
import { commitOhlcvData, setMarketSelection } from "./state-actions";
import { DataProviderRouter } from "./data/data-provider-router";
import { DataCache } from "./data/data-cache";
import { DataPersistence } from "./data/data-persistence";
import { DataFetcher } from "./data/data-fetcher";

export type { DataLoadReporter } from "./data/data-fetcher";

export class DataManager {
    private static readonly PRICE_JUMP_GUARD_RATIO = 8;
    private providerRouter = new DataProviderRouter();
    private cache = new DataCache();
    private persistence = new DataPersistence();
    private fetcher = new DataFetcher(
        this.providerRouter,
        this.cache,
        this.persistence,
        () => this.importedDataByKey,
        () => this.chartLookbackBars,
        {
            updateSymbolDataSource: (label, tone, title) => uiManager.updateSymbolDataSource(label, tone, title),
            showToast: (message, tone) => uiManager.showToast(message, tone),
        },
    );
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
    private realtimeGapFillInFlight: Set<string> = new Set();
    private loadedSymbol: string | null = null;
    private loadedInterval: string | null = null;
    private loadedBinanceMarketType = state.binanceMarketType;

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

        const storageIntervals = resolveImportStorageIntervals(normalizedInterval);
        const provider = this.getProvider(normalizedSymbol);
        const now = Date.now();
        for (const storageInterval of storageIntervals) {
            const cacheKey = this.fetcher.buildCacheKey(normalizedSymbol, storageInterval, provider);
            this.importedDataByKey.set(cacheKey, candles);
            this.cache.syncAtByKey.set(cacheKey, now);
            this.setCachedCandles(cacheKey, candles, 'imported');
        }
    }

    public clearImportedData(): void {
        for (const key of this.importedDataByKey.keys()) {
            this.cache.delete(key);
        }
        this.importedDataByKey.clear();
    }

    public getChartLookbackBars(): number | null {
        return this.chartLookbackBars;
    }

    public getLoadedContextKey(): string | null {
        if (!this.loadedSymbol || !this.loadedInterval) return null;
        return `${this.loadedSymbol}|${this.loadedInterval}|${this.loadedBinanceMarketType}`;
    }

    public getProvider(symbol: string): DataProvider {
        return this.providerRouter.getProvider(symbol);
    }

    public setProviderOverride(symbol: string, provider: DataProvider | null): void {
        this.providerRouter.setProviderOverride(symbol, provider);
    }

    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        return this.fetcher.fetchData(symbol, interval, signal);
    }

    public async fetchDataDetached(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        return this.fetcher.fetchDataDetached(symbol, interval, signal);
    }

    public async fetchDataForScan(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<OHLCVData[]> {
        return this.fetcher.fetchDataForScan(symbol, interval, signal, lookbackBars);
    }

    public async fetchDataForScanWithMeta(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        lookbackBars?: number
    ): Promise<{ data: OHLCVData[]; source: 'mock' | 'local' | 'network' }> {
        return this.fetcher.fetchDataForScanWithMeta(symbol, interval, signal, lookbackBars);
    }

    public async fetchDataWithLimit(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        return this.fetcher.fetchDataWithLimit(symbol, interval, limit, options);
    }

    public async loadData(symbol: string = state.currentSymbol, interval: string = state.currentInterval): Promise<void> {
        await this.setSymbol(symbol, interval);
    }

    public async setSymbol(symbol: string, interval: string): Promise<OHLCVData[]> {
        this.clearImportedData();
        this.stopStreaming();
        setMarketSelection({ symbol, interval });

        uiManager.clearUI();
        uiManager.updateTimeframeUI(interval);

        const data = await this.fetchData(symbol, interval);
        commitOhlcvData(data, 'set_symbol_load');
        this.loadedSymbol = symbol;
        this.loadedInterval = interval;
        this.loadedBinanceMarketType = state.binanceMarketType;

        this.startStreaming(symbol, interval);

        return data;
    }

    public async fetchHistoricalData(
        symbol: string,
        interval: string,
        limit: number,
        options?: HistoricalFetchOptions & { onProgress?: (progress: { fetched: number; total: number; requestCount: number }) => void }
    ): Promise<OHLCVData[]> {
        return this.fetcher.fetchHistoricalData(symbol, interval, limit, options);
    }

    public startStreaming(symbol: string = state.currentSymbol, interval: string = state.currentInterval): void {
        if (this.isMockSymbol(symbol)) {
            debugLogger.info('data.stream.skip_mock', { symbol });
            return;
        }
        const provider = this.getProvider(symbol);
        if (!isBinanceDataProvider(provider)) {
            this.setProviderOverride(symbol, provider);
        }
        if (provider === 'polymarket') {
            debugLogger.info('data.stream.skip_polymarket', { symbol, interval });
            return;
        }
        if (isBinanceDataProvider(provider) && !isBinanceInterval(interval)) {
            debugLogger.info('data.stream.skip_interval', { symbol, interval, provider });
            return;
        }
        const useBinanceAlignedPolling = isBinanceDataProvider(provider) && this.shouldUseBinanceAlignedPolling();

        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval && this.streamProvider === provider) {
            return;
        }

        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.streamProvider = provider;
        this.streamSessionId += 1;
        this.reconnectAttempts = 0;

        if (isBinanceDataProvider(provider) && !useBinanceAlignedPolling) {
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

    private getResampleOptions(interval: string): ResampleOptions | undefined {
        const normalized = interval.trim().toLowerCase();
        const intervalSeconds = getIntervalSeconds(normalized);
        return intervalSeconds === 7200 ? {} : undefined;
    }

    private getStorageInterval(interval: string): string {
        return resolveStorageInterval(interval);
    }

    private takeLastCandles(candles: OHLCVData[], limit: number): OHLCVData[] {
        return trimToLastCandles(candles, limit);
    }

    private shouldUseBinanceAlignedPolling(): boolean {
        return false;
    }

    private isIntervalAlignedTime(timeSec: number, interval: string): boolean {
        return checkIntervalAlignedTime(timeSec, interval);
    }

    public invalidateCacheEntry(symbol: string, interval: string, provider?: DataProvider): void {
        const cacheKey = this.fetcher.buildCacheKey(symbol, interval, provider);
        this.cache.invalidate(cacheKey);
    }

    public updateCacheEntryFor(symbol: string, interval: string, candles: OHLCVData[]): void {
        const provider = this.getProvider(symbol);
        const cacheKey = this.fetcher.buildCacheKey(symbol, this.getStorageInterval(interval), provider);
        this.cache.updateCandles(cacheKey, candles);
    }

    private setCachedCandles(cacheKey: string, candles: OHLCVData[], source: string): void {
        this.cache.set(cacheKey, candles, source);
    }

    private connectBinanceStream(): void {
        const symbol = this.streamSymbol;
        const interval = this.streamInterval;
        const provider = this.streamProvider as BinanceDataProvider;
        const marketType = getBinanceMarketTypeForProvider(provider);
        const sessionId = this.streamSessionId;

        debugLogger.info('data.stream.connecting', { symbol, interval, provider });

        try {
            this.ws = startBinanceStream(
                symbol,
                interval,
                (candle) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;
                    this.handleStreamUpdate(candle, sessionId, symbol, interval, provider);
                },
                (error) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;
                    debugLogger.error('data.stream.error', { error: String(error) });
                },
                (event) => {
                    if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;
                    this.handleStreamClose(event);
                },
                marketType
            );

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
            if (this.streamSymbol && this.streamInterval && isBinanceDataProvider(this.streamProvider)) {
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
            } else if (isBinanceDataProvider(this.streamProvider) && this.shouldUseBinanceAlignedPolling()) {
                const latestSeries = await fetchBinanceDataWithLimit(symbol, interval, 2, {
                    signal: abort.signal,
                    maxRequests: 2,
                    marketType: getBinanceMarketTypeForProvider(this.streamProvider),
                    ...(resampleOptions ?? {}),
                });
                candle = latestSeries[latestSeries.length - 1] ?? null;
            }

            if (abort.signal.aborted) return;

            if (candle && (isBinanceDataProvider(provider) || provider === 'bybit-tradfi' || provider === 'polymarket')) {
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
        if (!isBinanceDataProvider(provider)) return;
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
                marketType: getBinanceMarketTypeForProvider(provider),
                ...(resampleOptions ?? {}),
            });
            const sanitized = this.fetcher.sanitizeBinanceCandles(symbol, storageInterval, fetched, 'stream-gap-fill');
            if (sanitized.length === 0) return;
            if (!this.isActiveStreamContext(sessionId, symbol, interval, provider)) return;

            const merged = this.takeLastCandles(
                this.fetcher.sanitizeBinanceCandles(
                    symbol,
                    storageInterval,
                    mergeCandles(state.ohlcvData, sanitized),
                    'stream-gap-merge'
                ),
                this.chartLookbackBars ?? DATA_CHART_TOTAL_LIMIT
            );

            commitOhlcvData(merged, 'realtime_gap_fill');
            this.fetcher.queuePersistCandles(symbol, interval, merged, provider);

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
            commitOhlcvData([updatedCandle], 'realtime_replace_empty');
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
        this.fetcher.queuePersistCandles(
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
