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
    private readonly TOTAL_LIMIT = 10000;
    private readonly MAX_REQUESTS = 15;
    private currentAbort: AbortController | null = null;
    private currentLoadId = 0;
    private readonly MOCK_SYMBOLS = new Set(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'EURUSD', 'GBPUSD', 'USDJPY']);


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

}

export const dataManager = new DataManager();
