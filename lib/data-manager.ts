

import { OHLCVData } from "./types/index";
import { state } from "./state";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";
import {
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
import { HistoricalFetchOptions } from "./types/index";
import { getIntervalSeconds } from "./dataProviders/utils";

type DataProvider = 'binance' | 'bybit-tradfi';

export class DataManager {
    private nonBinanceProviderOverride: Map<string, DataProvider> = new Map();
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
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly RECONNECT_DELAY_BASE = 1000;

    // UI update throttling
    private lastLogTime: number = 0;
    private lastUiUpdateTime: number = 0;
    private readonly TOTAL_LIMIT = 50000;

    // ============================================================================
    // Public API
    // ============================================================================

    public isMockSymbol(symbol: string): boolean {
        return isMockSymbol(symbol);
    }

    public getProvider(symbol: string): DataProvider {
        if (this.nonBinanceProviderOverride.has(symbol)) {
            return this.nonBinanceProviderOverride.get(symbol)!;
        }
        if (symbol.includes('/') || symbol.length === 6) {
            // Likely forex/crypto pair
            // Could add more heuristics here
        }
        return 'binance';
    }

    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            await new Promise(resolve => setTimeout(resolve, 600)); // Simulate latency
            if (signal?.aborted) return [];
            return generateMockData(symbol, interval);
        }

        const provider = this.getProvider(symbol);

        if (provider === 'binance') {
            return fetchBinanceData(symbol, interval, signal);
        }

        if (provider === 'bybit-tradfi') {
            const data = await fetchBybitTradFiData(symbol, interval, signal);
            if (data.length > 0) return data;
            uiManager.showToast('Bybit TradFi returned no data.', 'error');
            return [];
        }

        // Fallback or explicit provider logic for others
        return this.fetchNonBinanceData(symbol, interval, signal);
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

        if (provider === 'binance') {
            return fetchBinanceDataWithLimit(symbol, interval, limit, options);
        }

        if (provider === 'bybit-tradfi') {
            return fetchBybitTradFiDataWithLimit(symbol, interval, limit, options);
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
        if (provider === 'binance' && !isBinanceInterval(interval)) {
            debugLogger.info('data.stream.skip_interval', { symbol, interval, provider });
            return;
        }

        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval && this.streamProvider === provider) {
            return;
        }

        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.streamProvider = provider;
        this.reconnectAttempts = 0;

        if (provider === 'binance') {
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
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
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
            let provider: string | null = null;

            if (this.streamProvider === 'bybit-tradfi') {
                candle = await fetchBybitTradFiLatest(symbol, interval, abort.signal);
            }

            if (abort.signal.aborted) return;

            if (candle) {
                if (provider) this.nonBinanceProviderOverride.set(symbol, provider as DataProvider);
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

        const currentData = [...state.ohlcvData];
        if (currentData.length === 0) {
            currentData.push(updatedCandle);
        } else {
            const lastCandle = currentData[currentData.length - 1];
            if (lastCandle.time === updatedCandle.time) {
                currentData[currentData.length - 1] = updatedCandle;
            } else if (updatedCandle.time > lastCandle.time) {
                currentData.push(updatedCandle);
                if (currentData.length > this.TOTAL_LIMIT) {
                    currentData.shift();
                }
            }
        }

        (state as any).ohlcvData = currentData;

        const now = Date.now();
        if (!this.lastUiUpdateTime || now - this.lastUiUpdateTime > 1000) {
            this.lastUiUpdateTime = now;
            uiManager.updatePriceDisplay();
        }
    }
}

export const dataManager = new DataManager();
