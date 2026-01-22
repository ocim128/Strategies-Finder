import { Time } from "lightweight-charts";
import { OHLCVData } from "./strategies/index";
import { state } from "./state";
import { debugLogger } from "./debugLogger";

/**
 * Binance API Kline data format:
 * [
 *   0: Open time,
 *   1: Open,
 *   2: High,
 *   3: Low,
 *   4: Close,
 *   5: Volume,
 *   ...
 * ]
 */
type BinanceKline = [number, string, string, string, string, string, ...any[]];

export class DataManager {
    private readonly LIMIT_PER_REQUEST = 1000;
    private readonly TOTAL_LIMIT = 30000;
    private readonly MAX_REQUESTS = 15;
    private currentAbort: AbortController | null = null;
    private currentLoadId = 0;
    private readonly MOCK_SYMBOLS = new Set(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'WTIUSD']);

    // Real-time WebSocket streaming
    private ws: WebSocket | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private isStreaming = false;
    private streamSymbol: string = '';
    private streamInterval: string = '';
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 10;
    private readonly RECONNECT_DELAY_BASE = 1000; // Base delay in ms


    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        if (this.MOCK_SYMBOLS.has(symbol)) {
            await new Promise(resolve => setTimeout(resolve, 600)); // Simulate latency
            if (signal?.aborted) return [];
            return this.generateMockData(symbol, interval);
        }

        try {
            const batches: BinanceKline[][] = [];
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;

            while (totalDataLength < this.TOTAL_LIMIT && requestCount < this.MAX_REQUESTS) {
                if (signal?.aborted) return [];
                const remaining = this.TOTAL_LIMIT - totalDataLength;
                const limit = Math.min(remaining, this.LIMIT_PER_REQUEST);

                const data = await this.fetchKlinesBatch(symbol, interval, limit, endTime, signal);

                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = data[0][0] - 1;
                requestCount++;

                if (data.length < limit) break;
            }

            const allRawData = batches.reverse().flat();
            return this.mapToOHLCV(allRawData);
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.fetch.error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            console.error('Failed to fetch data:', error);
            return [];
        }
    }

    private async fetchKlinesBatch(
        symbol: string,
        interval: string,
        limit: number,
        endTime?: number,
        signal?: AbortSignal
    ): Promise<BinanceKline[]> {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;

        const response = await fetch(url, { signal });
        if (!response.ok) {
            debugLogger.warn('data.fetch.http_error', {
                symbol,
                interval,
                status: response.status,
            });
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    private mapToOHLCV(rawData: BinanceKline[]): OHLCVData[] {
        return rawData.map(d => ({
            time: (d[0] / 1000) as Time,
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
        }));
    }

    public async loadData(symbol: string = state.currentSymbol, interval: string = state.currentInterval) {
        const loadId = ++this.currentLoadId;
        const startedAt = Date.now();
        debugLogger.event('data.load.start', { loadId, symbol, interval });

        // Stop any existing stream when loading new data
        this.stopStreaming();

        if (this.currentAbort) {
            this.currentAbort.abort();
        }
        const abortController = new AbortController();
        this.currentAbort = abortController;

        const data = await this.fetchData(symbol, interval, abortController.signal);
        const durationMs = Date.now() - startedAt;
        if (this.currentAbort === abortController) {
            this.currentAbort = null;
        }
        if (abortController.signal.aborted || loadId !== this.currentLoadId) {
            debugLogger.warn('data.load.aborted', { loadId, symbol, interval, durationMs });
            return;
        }
        if (symbol !== state.currentSymbol || interval !== state.currentInterval) {
            debugLogger.warn('data.load.stale', { loadId, symbol, interval, durationMs });
            return;
        }
        if (data.length === 0) return;

        debugLogger.event('data.load.success', {
            loadId,
            symbol,
            interval,
            candles: data.length,
            durationMs,
        });
        state.set('ohlcvData', data);

        // Start real-time streaming after data is loaded
        this.startStreaming(symbol, interval);
    }

    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === 'AbortError';
        }
        return (error as { name?: string }).name === 'AbortError';
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return `${error.name}: ${error.message}`;
        }
        return String(error);
    }

    private generateMockData(symbol: string, interval: string): OHLCVData[] {
        const count = this.TOTAL_LIMIT;
        const data: OHLCVData[] = [];
        let price = this.getMockPrice(symbol);
        const now = Math.floor(Date.now() / 1000);
        const intervalSeconds = this.getIntervalSeconds(interval);

        // Start 'count' periods ago
        let time = (now - (count * intervalSeconds)) as Time;

        for (let i = 0; i < count; i++) {
            const volatility = price * 0.015; // 1.5% volatility
            const change = (Math.random() - 0.5) * volatility;
            const open = price;
            const close = price + change;
            const high = Math.max(open, close) + Math.random() * volatility * 0.5;
            const low = Math.min(open, close) - Math.random() * volatility * 0.5;
            const volume = Math.floor(Math.random() * 1000000) + 100000;

            data.push({
                time: time,
                open,
                high,
                low,
                close,
                volume,
            });

            price = close;
            time = (Number(time) + intervalSeconds) as Time;
        }

        return data;
    }

    private getMockPrice(symbol: string): number {
        switch (symbol) {
            case 'AAPL': return 175;
            case 'GOOGL': return 140;
            case 'MSFT': return 380;
            case 'TSLA': return 220;
            case 'EURUSD': return 1.09;
            case 'GBPUSD': return 1.27;
            case 'USDJPY': return 148;
            case 'XAUUSD': return 2050;
            case 'XAGUSD': return 23.5;
            case 'WTIUSD': return 75;
            default: return 100;
        }
    }

    private getIntervalSeconds(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1)) || 1;
        switch (unit) {
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            case 'w': return value * 604800;
            default: return 86400; // Default to 1d
        }
    }

    // ============================================================================
    // Real-time WebSocket Streaming for Live Candle Updates
    // ============================================================================

    /**
     * Start real-time streaming for the given symbol and interval
     * Uses Binance WebSocket stream for live kline/candlestick updates
     */
    public startStreaming(symbol: string = state.currentSymbol, interval: string = state.currentInterval): void {
        // Don't stream for mock symbols
        if (this.MOCK_SYMBOLS.has(symbol)) {
            debugLogger.info('data.stream.skip_mock', { symbol });
            return;
        }

        // If already streaming the same symbol/interval, do nothing
        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval) {
            debugLogger.info('data.stream.already_active', { symbol, interval });
            return;
        }

        // Stop any existing stream first
        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.reconnectAttempts = 0;
        this.connectWebSocket();
    }

    /**
     * Stop the real-time streaming and clean up WebSocket connection
     */
    public stopStreaming(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.isStreaming = false;
            this.ws.close(1000, 'Stream stopped by user');
            this.ws = null;
            debugLogger.info('data.stream.stopped', {
                symbol: this.streamSymbol,
                interval: this.streamInterval
            });
        }

        this.streamSymbol = '';
        this.streamInterval = '';
        this.reconnectAttempts = 0;
    }

    /**
     * Connect to Binance WebSocket stream
     */
    private connectWebSocket(): void {
        const symbol = this.streamSymbol.toLowerCase();
        const interval = this.streamInterval;
        const streamName = `${symbol}@kline_${interval}`;
        const wsUrl = `wss://stream.binance.com:9443/ws/${streamName}`;

        debugLogger.info('data.stream.connecting', { symbol: this.streamSymbol, interval, wsUrl });

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this.isStreaming = true;
                this.reconnectAttempts = 0;
                debugLogger.event('data.stream.connected', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval
                });
            };

            this.ws.onmessage = (event) => {
                this.handleStreamMessage(event.data);
            };

            this.ws.onerror = (error) => {
                debugLogger.error('data.stream.error', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval,
                    error: String(error)
                });
            };

            this.ws.onclose = (event) => {
                this.isStreaming = false;
                debugLogger.warn('data.stream.closed', {
                    symbol: this.streamSymbol,
                    interval: this.streamInterval,
                    code: event.code,
                    reason: event.reason
                });

                // Attempt reconnection if not intentionally closed
                if (event.code !== 1000 && this.streamSymbol && this.streamInterval) {
                    this.attemptReconnect();
                }
            };
        } catch (error) {
            debugLogger.error('data.stream.connection_failed', {
                error: this.formatError(error)
            });
            this.attemptReconnect();
        }
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            debugLogger.error('data.stream.max_reconnects', {
                attempts: this.reconnectAttempts
            });
            return;
        }

        this.reconnectAttempts++;
        const delay = this.RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectAttempts - 1);

        debugLogger.info('data.stream.reconnecting', {
            attempt: this.reconnectAttempts,
            delayMs: delay
        });

        this.reconnectTimeout = setTimeout(() => {
            if (this.streamSymbol && this.streamInterval) {
                this.connectWebSocket();
            }
        }, delay);
    }

    /**
     * Handle incoming WebSocket message and update chart data
     */
    private handleStreamMessage(data: string): void {
        try {
            const message = JSON.parse(data);

            // Binance kline stream format
            if (message.e === 'kline' && message.k) {
                const kline = message.k;

                // Skip updates during replay mode
                if (state.replayMode) {
                    return;
                }

                // Create OHLCV data from the stream
                const updatedCandle: OHLCVData = {
                    time: (kline.t / 1000) as Time, // Open time in seconds
                    open: parseFloat(kline.o),
                    high: parseFloat(kline.h),
                    low: parseFloat(kline.l),
                    close: parseFloat(kline.c),
                    volume: parseFloat(kline.v),
                };

                // Check if symbol/interval still matches
                if (kline.s !== this.streamSymbol || kline.i !== this.streamInterval) {
                    return;
                }

                // Update the candlestick series directly for real-time updates
                if (state.candlestickSeries) {
                    state.candlestickSeries.update(updatedCandle);
                }

                // Also update the state data array
                const currentData = [...state.ohlcvData];
                if (currentData.length > 0) {
                    const lastCandle = currentData[currentData.length - 1];

                    // Check if this is the same candle (update) or a new candle
                    if (lastCandle.time === updatedCandle.time) {
                        // Update the last candle
                        currentData[currentData.length - 1] = updatedCandle;
                    } else if (updatedCandle.time > lastCandle.time) {
                        // This is a new candle, append it
                        currentData.push(updatedCandle);

                        // Keep the array size manageable (optional: trim old data)
                        if (currentData.length > this.TOTAL_LIMIT) {
                            currentData.shift();
                        }
                    }

                    // Update state without triggering full re-render
                    // Using direct assignment to avoid state listener overhead for high-frequency updates
                    (state as any).ohlcvData = currentData;
                }

                // Log occasional updates (every 10 seconds based on time)
                const now = Date.now();
                if (!this.lastLogTime || now - this.lastLogTime > 10000) {
                    this.lastLogTime = now;
                    debugLogger.info('data.stream.update', {
                        symbol: kline.s,
                        interval: kline.i,
                        close: updatedCandle.close,
                        isClosed: kline.x, // Whether this candle is closed
                    });
                }
            }
        } catch (error) {
            debugLogger.error('data.stream.parse_error', {
                error: this.formatError(error)
            });
        }
    }

    private lastLogTime: number = 0;

}

export const dataManager = new DataManager();
