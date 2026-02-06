import { Time } from "lightweight-charts";
import { OHLCVData } from "./strategies/index";
import { resampleOHLCV } from "./strategies/resample-utils";
import { state, type MockChartModel } from "./state";
import { debugLogger } from "./debugLogger";
import { uiManager } from "./uiManager";
import { tradfiSearchService } from "./tradfiSearchService";

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
type BybitTradFiKline = [string, string, string, string, string];
type DataProvider = 'binance' | 'bybit-tradfi' | 'twelvedata';

type HistoricalFetchProgress = {
    fetched: number;
    total: number;
    requestCount: number;
};

type HistoricalFetchOptions = {
    signal?: AbortSignal;
    onProgress?: (progress: HistoricalFetchProgress) => void;
    requestDelayMs?: number;
    maxRequests?: number;
};

interface BybitTradFiKlineResponse {
    ret_code?: number;
    ret_msg?: string;
    retCode?: number;
    retMsg?: string;
    result?: {
        list?: BybitTradFiKline[];
    };
}

type MockChartConfig = {
    barsCount: number;
    volatility: number;
    startPrice: number;
    intervalSeconds: number;
};

export class DataManager {
    private readonly LIMIT_PER_REQUEST = 1000;
    private readonly BYBIT_LIMIT_PER_REQUEST = 200;
    private readonly TOTAL_LIMIT = 30000;
    private readonly MAX_REQUESTS = 15;
    private readonly MIN_MOCK_BARS = 100;
    private readonly MAX_MOCK_BARS = 30000000;
    private readonly BINANCE_INTERVALS = new Set([
        '1m', '3m', '5m', '15m', '30m',
        '1h', '2h', '4h', '6h', '8h', '12h',
        '1d', '3d', '1w', '1M'
    ]);
    private readonly TWELVE_DATA_INTERVALS = new Set([
        '1m', '5m', '15m', '30m', '45m',
        '1h', '2h', '4h', '8h',
        '1d', '1w', '1M'
    ]);
    private readonly BYBIT_TRADFI_INTERVALS = new Set([
        '1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'
    ]);
    private currentAbort: AbortController | null = null;
    private currentLoadId = 0;
    // Only these are truly mock/simulated data now
    private readonly MOCK_SYMBOLS = new Set(['MOCK_STOCK', 'MOCK_CRYPTO', 'MOCK_FOREX']);
    private readonly nonBinanceProviderOverride = new Map<string, 'twelvedata' | 'yahoo'>();
    private readonly bybitTradFiSymbolOverride = new Map<string, string>();
    private lastDataFallbackKey: string | null = null;
    private readonly TWELVE_DATA_API_KEY_STORAGE = 'twelvedataApiKey';
    private readonly BYBIT_TRADFI_KLINE_URL = '/api/tradfi-kline';

    // Real-time WebSocket streaming
    private ws: WebSocket | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private isStreaming = false;
    private streamSymbol: string = '';
    private streamInterval: string = '';
    private streamProvider: DataProvider | '' = '';
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 10;
    private readonly RECONNECT_DELAY_BASE = 1000; // Base delay in ms
    private pollTimeout: ReturnType<typeof setTimeout> | null = null;
    private pollAbort: AbortController | null = null;
    private pollingInFlight = false;
    private isPolling = false;


    public async fetchData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            await new Promise(resolve => setTimeout(resolve, 600)); // Simulate latency
            if (signal?.aborted) return [];
            return this.generateMockData(symbol, interval);
        }

        // Determine provider based on symbol
        const provider = this.getProvider(symbol);

        if (provider === 'binance') {
            return this.fetchBinanceData(symbol, interval, signal);
        }

        if (provider === 'bybit-tradfi') {
            const tradFiData = await this.fetchBybitTradFiData(symbol, interval, signal);
            if (tradFiData.length > 0) {
                return tradFiData;
            }
            uiManager.showToast('Bybit TradFi returned no data for this symbol/interval.', 'error');
            return [];
        }

        const { data, provider: resolvedProvider } = await this.fetchNonBinanceData(symbol, interval, signal);
        if (data.length > 0 && resolvedProvider) {
            this.nonBinanceProviderOverride.set(symbol, resolvedProvider);
            return data;
        }

        this.notifyDataFallback(symbol, interval);
        return this.generateMockData(symbol, interval);
    }

    /**
     * Fetch a large historical dataset for export without modifying chart state.
     */
    public async fetchHistoricalData(
        symbol: string,
        interval: string,
        totalBars: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        if (this.isMockSymbol(symbol)) {
            throw new Error('Historical download is not available for mock symbols.');
        }

        const provider = this.getProvider(symbol);
        if (provider === 'binance') {
            return this.fetchBinanceDataWithLimit(symbol, interval, totalBars, options);
        }

        if (provider === 'bybit-tradfi') {
            return this.fetchBybitTradFiDataWithLimit(symbol, interval, totalBars, options);
        }

        throw new Error('Historical download is not supported for this provider.');
    }

    /**
     * Fetch data from Binance
     */
    private async fetchBinanceData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        try {
            const batches: BinanceKline[][] = [];
            const { sourceInterval, needsResample } = this.resolveFetchInterval(interval);
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;

            while (totalDataLength < this.TOTAL_LIMIT && requestCount < this.MAX_REQUESTS) {
                if (signal?.aborted) return [];
                const remaining = this.TOTAL_LIMIT - totalDataLength;
                const limit = Math.min(remaining, this.LIMIT_PER_REQUEST);

                const data = await this.fetchKlinesBatch(symbol, sourceInterval, limit, endTime, signal);

                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = data[0][0] - 1;
                requestCount++;

                if (data.length < limit) break;
            }

            const allRawData = batches.reverse().flat();
            const mapped = this.mapToOHLCV(allRawData);

            if (needsResample) {
                const resampled = resampleOHLCV(mapped, interval);
                debugLogger.info('data.resample', {
                    symbol,
                    interval,
                    sourceInterval,
                    sourceCandles: mapped.length,
                    targetCandles: resampled.length,
                });
                return resampled;
            }

            return mapped;
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

    private async fetchBinanceDataWithLimit(
        symbol: string,
        interval: string,
        totalBars: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        try {
            const targetBars = Math.max(1, Math.floor(totalBars));
            const { sourceInterval, needsResample } = this.resolveFetchInterval(interval);
            const { rawLimit, ratio } = this.resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
            const batches: BinanceKline[][] = [];
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;
            const maxRequests = Math.min(
                options?.maxRequests ?? Math.ceil(rawLimit / this.LIMIT_PER_REQUEST),
                5000
            );

            while (totalDataLength < rawLimit && requestCount < maxRequests) {
                if (options?.signal?.aborted) return [];
                const remaining = rawLimit - totalDataLength;
                const limit = Math.min(remaining, this.LIMIT_PER_REQUEST);

                const data = await this.fetchKlinesBatch(symbol, sourceInterval, limit, endTime, options?.signal);
                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = data[0][0] - 1;
                requestCount++;

                const fetchedTarget = needsResample
                    ? Math.min(targetBars, Math.floor(totalDataLength / Math.max(1, ratio)))
                    : Math.min(targetBars, totalDataLength);
                options?.onProgress?.({ fetched: fetchedTarget, total: targetBars, requestCount });

                if (data.length < limit) break;
                if (options?.requestDelayMs) {
                    await this.wait(options.requestDelayMs);
                }
            }

            const allRawData = batches.reverse().flat();
            const mapped = this.mapToOHLCV(allRawData);

            if (needsResample) {
                const resampled = resampleOHLCV(mapped, interval);
                return resampled.slice(-targetBars);
            }

            return mapped.slice(-targetBars);
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.fetch.historical_error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            throw error;
        }
    }

    /**
     * Fetch data from Bybit TradFi feed
     */
    private async fetchBybitTradFiData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        try {
            const batches: BybitTradFiKline[][] = [];
            const { sourceInterval, needsResample } = this.resolveBybitTradFiInterval(interval);
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;

            while (totalDataLength < this.TOTAL_LIMIT && requestCount < this.MAX_REQUESTS) {
                if (signal?.aborted) return [];
                const remaining = this.TOTAL_LIMIT - totalDataLength;
                const limit = Math.min(remaining, this.BYBIT_LIMIT_PER_REQUEST);

                const data = await this.fetchBybitTradFiBatch(symbol, sourceInterval, limit, endTime, signal);
                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = Number(data[0][0]) - 1;
                requestCount++;

                if (data.length < limit) break;
            }

            const allRawData = batches.reverse().flat();
            const mapped = this.mapBybitTradFiToOHLCV(allRawData);
            return needsResample ? resampleOHLCV(mapped, interval) : mapped;
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.bybit_tradfi.error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            return [];
        }
    }

    private async fetchBybitTradFiDataWithLimit(
        symbol: string,
        interval: string,
        totalBars: number,
        options?: HistoricalFetchOptions
    ): Promise<OHLCVData[]> {
        try {
            const targetBars = Math.max(1, Math.floor(totalBars));
            const { sourceInterval, needsResample } = this.resolveBybitTradFiInterval(interval);
            const { rawLimit, ratio } = this.resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
            const batches: BybitTradFiKline[][] = [];
            let endTime: number | undefined;
            let requestCount = 0;
            let totalDataLength = 0;
            const maxRequests = Math.min(
                options?.maxRequests ?? Math.ceil(rawLimit / this.BYBIT_LIMIT_PER_REQUEST),
                8000
            );

            while (totalDataLength < rawLimit && requestCount < maxRequests) {
                if (options?.signal?.aborted) return [];
                const remaining = rawLimit - totalDataLength;
                const limit = Math.min(remaining, this.BYBIT_LIMIT_PER_REQUEST);

                const data = await this.fetchBybitTradFiBatch(symbol, sourceInterval, limit, endTime, options?.signal);
                if (data.length === 0) break;

                batches.push(data);
                totalDataLength += data.length;
                endTime = Number(data[0][0]) - 1;
                requestCount++;

                const fetchedTarget = needsResample
                    ? Math.min(targetBars, Math.floor(totalDataLength / Math.max(1, ratio)))
                    : Math.min(targetBars, totalDataLength);
                options?.onProgress?.({ fetched: fetchedTarget, total: targetBars, requestCount });

                if (data.length < limit) break;
                if (options?.requestDelayMs) {
                    await this.wait(options.requestDelayMs);
                }
            }

            const allRawData = batches.reverse().flat();
            const mapped = this.mapBybitTradFiToOHLCV(allRawData);
            if (needsResample) {
                const resampled = resampleOHLCV(mapped, interval);
                return resampled.slice(-targetBars);
            }
            return mapped.slice(-targetBars);
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.bybit_tradfi.historical_error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            throw error;
        }
    }

    private async fetchBybitTradFiBatch(
        symbol: string,
        interval: string,
        limit: number,
        to?: number,
        signal?: AbortSignal
    ): Promise<BybitTradFiKline[]> {
        const intervalValue = this.mapToBybitTradFiInterval(interval);
        const intervalMs = Math.max(60_000, this.getIntervalSeconds(interval) * 1000);
        const effectiveTo = Number.isFinite(to)
            ? Math.floor(Number(to))
            : Math.floor(Date.now() / intervalMs) * intervalMs;
        const resolvedSymbols = this.getBybitTradFiSymbolCandidates(symbol);
        const requestLimit = String(Math.min(this.BYBIT_LIMIT_PER_REQUEST, Math.max(1, Math.floor(limit))));

        for (const requestSymbol of resolvedSymbols) {
            const params = new URLSearchParams({
                timeStamp: Date.now().toString(),
                symbol: requestSymbol,
                interval: intervalValue,
                limit: requestLimit,
                to: String(effectiveTo),
            });

            const response = await fetch(`${this.BYBIT_TRADFI_KLINE_URL}?${params.toString()}`, {
                signal,
                headers: {
                    Accept: 'application/json',
                },
            });
            if (!response.ok) {
                throw new Error(`Bybit TradFi request failed: ${response.status}`);
            }

            const data: BybitTradFiKlineResponse = await response.json();
            const retCode = this.getBybitTradFiRetCode(data);
            const retMsg = this.getBybitTradFiRetMsg(data);

            if (retCode === 0) {
                const list = data.result?.list;
                if (!Array.isArray(list)) {
                    return [];
                }

                const symbolKey = this.getBybitTradFiSymbolKey(symbol);
                const normalizedInput = symbol.trim();
                if (requestSymbol !== normalizedInput) {
                    this.bybitTradFiSymbolOverride.set(normalizedInput.toUpperCase(), requestSymbol);
                    this.bybitTradFiSymbolOverride.set(symbolKey, requestSymbol);
                }

                return list.filter((item): item is BybitTradFiKline =>
                    Array.isArray(item) && item.length >= 5
                );
            }

            // Invalid symbol on one alias -> try next candidate alias.
            if (retCode === 10001 && resolvedSymbols.length > 1) {
                continue;
            }

            throw new Error(retMsg || `Bybit TradFi API error (${retCode})`);
        }

        throw new Error(`Bybit TradFi symbol is invalid: ${symbol}`);
    }

    private mapBybitTradFiToOHLCV(rawData: BybitTradFiKline[]): OHLCVData[] {
        return rawData
            .map(d => ({
                time: (Number(d[0]) / 1000) as Time,
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: 0,
            }))
            .filter(bar =>
                Number.isFinite(bar.open) &&
                Number.isFinite(bar.high) &&
                Number.isFinite(bar.low) &&
                Number.isFinite(bar.close)
            );
    }

    /**
     * Fetch data from Twelve Data (stocks, forex, commodities)
     * Uses proxy to avoid CORS issues
     */
    private async fetchTwelveData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        try {
            const { sourceInterval, needsResample } = this.resolveTwelveDataInterval(interval);
            const ohlcv = await this.fetchTwelveDataSeries(symbol, sourceInterval, 5000, signal);
            const result = needsResample ? resampleOHLCV(ohlcv, interval) : ohlcv;

            debugLogger.info('data.twelvedata.success', {
                symbol,
                interval,
                sourceInterval,
                bars: result.length,
            });

            return result;
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.twelvedata.error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            console.warn('Twelve Data fetch failed:', error);
            return [];
        }
    }

    private async fetchTwelveDataSeries(
        symbol: string,
        interval: string,
        outputsize: number,
        signal?: AbortSignal
    ): Promise<OHLCVData[]> {
        const apiKey = this.getTwelveDataApiKey();
        if (!apiKey) {
            debugLogger.warn('data.twelvedata.missing_key', { symbol });
            return [];
        }
        const twelveInterval = this.mapToTwelveDataInterval(interval);
        const resolvedSymbol = this.normalizeTwelveDataSymbol(symbol);
        const size = Math.max(1, Math.floor(outputsize));

        // Use proxy to fetch from Twelve Data
        const apiUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(resolvedSymbol)}&interval=${twelveInterval}&outputsize=${size}&apikey=${encodeURIComponent(apiKey)}`;
        const proxyUrl = 'http://localhost:3030/api/proxy';
        const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: apiUrl }),
            signal,
        });

        if (!response.ok) {
            throw new Error(`Proxy request failed: ${response.status}`);
        }

        const data = await response.json();
        if (data.status === 'error') {
            const message = typeof data.message === 'string' ? data.message : 'Twelve Data error';
            throw new Error(message);
        }
        if (!data.values || !Array.isArray(data.values)) {
            return [];
        }

        return data.values
            .reverse() // Twelve Data returns newest first
            .map((bar: any) => ({
                time: (new Date(bar.datetime).getTime() / 1000) as Time,
                open: parseFloat(bar.open),
                high: parseFloat(bar.high),
                low: parseFloat(bar.low),
                close: parseFloat(bar.close),
                volume: parseFloat(bar.volume || '0'),
            }))
            .filter((bar: OHLCVData) =>
                !isNaN(bar.open) && !isNaN(bar.high) &&
                !isNaN(bar.low) && !isNaN(bar.close)
            );
    }

    private normalizeTwelveDataSymbol(symbol: string): string {
        const upper = symbol.toUpperCase();
        if (upper.includes('/')) return upper;
        if (/^[A-Z]{6}$/.test(upper)) {
            return `${upper.slice(0, 3)}/${upper.slice(3)}`;
        }
        if (upper === 'XAUUSD') return 'XAU/USD';
        if (upper === 'XAGUSD') return 'XAG/USD';
        if (upper === 'WTIUSD') return 'WTI/USD';
        return symbol;
    }

    private getTwelveDataApiKey(): string | null {
        try {
            const envKey = (import.meta as ImportMeta).env?.VITE_TWELVE_DATA_API_KEY;
            if (envKey && envKey.trim()) return envKey.trim();
            if (typeof window !== 'undefined' && window.localStorage) {
                const key = window.localStorage.getItem(this.TWELVE_DATA_API_KEY_STORAGE);
                if (key && key.trim()) return key.trim();
            }
        } catch {
            // Ignore storage access errors
        }
        return null;
    }

    /**
     * Map our interval format to Twelve Data interval format
     */
    private mapToTwelveDataInterval(interval: string): string {
        const mapping: { [key: string]: string } = {
            '1m': '1min',
            '3m': '3min',
            '5m': '5min',
            '15m': '15min',
            '30m': '30min',
            '45m': '45min',
            '1h': '1h',
            '2h': '2h',
            '4h': '4h',
            '8h': '8h',
            '1d': '1day',
            '1w': '1week',
            '1M': '1month',
        };
        return mapping[interval] || '1day';
    }

    private async fetchYahooData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        try {
            const { sourceInterval, needsResample } = this.resolveYahooInterval(interval);
            const ranges = this.getYahooRangeCandidates(sourceInterval, false);
            for (const range of ranges) {
                if (signal?.aborted) return [];
                const ohlcv = await this.fetchYahooSeries(symbol, sourceInterval, range, signal);
                if (ohlcv.length === 0) continue;
                const result = needsResample ? resampleOHLCV(ohlcv, interval) : ohlcv;
                if (result.length > 0) {
                    debugLogger.info('data.yahoo.success', {
                        symbol,
                        interval,
                        sourceInterval,
                        range,
                        bars: result.length,
                    });
                    return result;
                }
            }
            return [];
        } catch (error) {
            if (this.isAbortError(error)) {
                return [];
            }
            debugLogger.error('data.yahoo.error', {
                symbol,
                interval,
                error: this.formatError(error),
            });
            return [];
        }
    }

    private async fetchYahooSeries(
        symbol: string,
        interval: string,
        range: string,
        signal?: AbortSignal
    ): Promise<OHLCVData[]> {
        const yahooSymbol = this.mapToYahooSymbol(symbol);
        const yahooInterval = this.mapToYahooInterval(interval);
        const apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(yahooInterval)}&range=${encodeURIComponent(range)}&includePrePost=false&events=div%2Csplit`;
        const proxyUrl = 'http://localhost:3030/api/proxy';
        const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: apiUrl }),
            signal,
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const result = data?.chart?.result?.[0];
        if (!result || result.error) {
            return [];
        }

        const timestamps: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
        const quote = result.indicators?.quote?.[0];
        if (!quote || timestamps.length === 0) {
            return [];
        }

        const ohlcv: OHLCVData[] = [];
        for (let i = 0; i < timestamps.length; i++) {
            const time = timestamps[i];
            const open = quote.open?.[i];
            const high = quote.high?.[i];
            const low = quote.low?.[i];
            const close = quote.close?.[i];
            const volume = quote.volume?.[i] ?? 0;
            if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
                continue;
            }
            ohlcv.push({
                time: time as Time,
                open: Number(open),
                high: Number(high),
                low: Number(low),
                close: Number(close),
                volume: Number(volume ?? 0),
            });
        }

        return ohlcv;
    }

    private mapToYahooSymbol(symbol: string): string {
        const upper = symbol.toUpperCase();
        if (upper.includes('/')) {
            const compact = upper.replace('/', '');
            return `${compact}=X`;
        }
        if (upper.endsWith('USD') && /^[A-Z]{6}$/.test(upper)) {
            return `${upper}=X`;
        }
        if (upper === 'XAUUSD') return 'XAUUSD=X';
        if (upper === 'XAGUSD') return 'XAGUSD=X';
        if (upper === 'WTIUSD') return 'CL=F';
        return symbol;
    }

    private mapToYahooInterval(interval: string): string {
        const mapping: { [key: string]: string } = {
            '1m': '1m',
            '2m': '2m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '60m': '60m',
            '1h': '1h',
            '1d': '1d',
            '1w': '1wk',
            '1M': '1mo',
        };
        return mapping[interval] || '1d';
    }

    private resolveYahooInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
        const supported = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d', '1w', '1M']);
        if (supported.has(interval)) {
            return { sourceInterval: interval, needsResample: false };
        }

        const targetSeconds = this.getIntervalSeconds(interval);
        if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
            return { sourceInterval: '1d', needsResample: false };
        }

        let bestInterval: string | null = null;
        let bestSeconds = 0;
        for (const candidate of supported) {
            if (candidate === '1M') continue;
            const seconds = this.getYahooIntervalSeconds(candidate);
            if (!Number.isFinite(seconds) || seconds <= 0) continue;
            if (seconds > targetSeconds) continue;
            if (targetSeconds % seconds !== 0) continue;
            if (seconds > bestSeconds) {
                bestSeconds = seconds;
                bestInterval = candidate;
            }
        }

        if (bestInterval) {
            return { sourceInterval: bestInterval, needsResample: true };
        }

        return { sourceInterval: '1m', needsResample: true };
    }

    private getYahooIntervalSeconds(interval: string): number {
        switch (interval) {
            case '1m': return 60;
            case '2m': return 120;
            case '5m': return 300;
            case '15m': return 900;
            case '30m': return 1800;
            case '60m': return 3600;
            case '1h': return 3600;
            case '1d': return 86400;
            case '1w': return 604800;
            case '1M': return 2592000;
            default: return this.getIntervalSeconds(interval);
        }
    }

    private getYahooRangeCandidates(interval: string, minimal: boolean): string[] {
        if (interval === '1m') {
            return minimal ? ['1d', '5d'] : ['5d', '1mo'];
        }
        if (interval === '2m' || interval === '5m' || interval === '15m' || interval === '30m' || interval === '60m' || interval === '1h') {
            return minimal ? ['5d', '1mo'] : ['1mo', '3mo', '6mo'];
        }
        if (interval === '1d') {
            return minimal ? ['6mo', '1y'] : ['5y', '2y', '1y'];
        }
        if (interval === '1w') {
            return minimal ? ['2y', '5y'] : ['10y', '5y'];
        }
        if (interval === '1M') {
            return minimal ? ['10y', 'max'] : ['max', '10y'];
        }
        return minimal ? ['1mo'] : ['1y', '6mo'];
    }

    private async fetchNonBinanceData(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<{ data: OHLCVData[]; provider: 'twelvedata' | 'yahoo' | null }> {
        const order = this.getNonBinanceProviderOrder(symbol);
        for (const provider of order) {
            if (signal?.aborted) return { data: [], provider: null };
            const data = provider === 'twelvedata'
                ? await this.fetchTwelveData(symbol, interval, signal)
                : await this.fetchYahooData(symbol, interval, signal);
            if (data.length > 0) {
                return { data, provider };
            }
        }
        return { data: [], provider: null };
    }

    private getNonBinanceProviderOrder(symbol: string): Array<'twelvedata' | 'yahoo'> {
        const hasTwelveKey = !!this.getTwelveDataApiKey();
        const override = this.nonBinanceProviderOverride.get(symbol);
        if (override === 'yahoo') {
            return ['yahoo', 'twelvedata'];
        }
        if (override === 'twelvedata') {
            return ['twelvedata', 'yahoo'];
        }
        return hasTwelveKey ? ['twelvedata', 'yahoo'] : ['yahoo', 'twelvedata'];
    }

    private notifyDataFallback(symbol: string, interval: string): void {
        const key = `${symbol}|${interval}`;
        if (this.lastDataFallbackKey === key) return;
        this.lastDataFallbackKey = key;
        uiManager.showToast('Live data unavailable, showing simulated data.', 'error');
    }

    private resolveTwelveDataInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
        if (this.TWELVE_DATA_INTERVALS.has(interval)) {
            return { sourceInterval: interval, needsResample: false };
        }

        const targetSeconds = this.getIntervalSeconds(interval);
        if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
            return { sourceInterval: '1d', needsResample: false };
        }

        let bestInterval: string | null = null;
        let bestSeconds = 0;

        for (const candidate of this.TWELVE_DATA_INTERVALS) {
            if (candidate === '1M') continue;
            const seconds = this.getIntervalSeconds(candidate);
            if (!Number.isFinite(seconds) || seconds <= 0) continue;
            if (seconds > targetSeconds) continue;
            if (targetSeconds % seconds !== 0) continue;
            if (seconds > bestSeconds) {
                bestSeconds = seconds;
                bestInterval = candidate;
            }
        }

        if (bestInterval) {
            return { sourceInterval: bestInterval, needsResample: true };
        }

        return { sourceInterval: '1m', needsResample: true };
    }

    private resolveBybitTradFiInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
        if (this.BYBIT_TRADFI_INTERVALS.has(interval)) {
            return { sourceInterval: interval, needsResample: false };
        }

        const targetSeconds = this.getIntervalSeconds(interval);
        if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
            return { sourceInterval: '1d', needsResample: false };
        }

        let bestInterval: string | null = null;
        let bestSeconds = 0;

        for (const candidate of this.BYBIT_TRADFI_INTERVALS) {
            const seconds = this.getIntervalSeconds(candidate);
            if (!Number.isFinite(seconds) || seconds <= 0) continue;
            if (seconds > targetSeconds) continue;
            if (targetSeconds % seconds !== 0) continue;
            if (seconds > bestSeconds) {
                bestSeconds = seconds;
                bestInterval = candidate;
            }
        }

        if (bestInterval) {
            return { sourceInterval: bestInterval, needsResample: true };
        }

        return { sourceInterval: '1m', needsResample: true };
    }

    private mapToBybitTradFiInterval(interval: string): string {
        const minutes = Math.max(1, Math.floor(this.getIntervalSeconds(interval) / 60));
        return String(minutes);
    }

    private getBybitTradFiRetCode(response: BybitTradFiKlineResponse): number {
        if (typeof response.ret_code === 'number') return response.ret_code;
        if (typeof response.retCode === 'number') return response.retCode;
        return -1;
    }

    private getBybitTradFiRetMsg(response: BybitTradFiKlineResponse): string {
        if (typeof response.ret_msg === 'string' && response.ret_msg) return response.ret_msg;
        if (typeof response.retMsg === 'string' && response.retMsg) return response.retMsg;
        return 'Bybit TradFi API error';
    }

    private getBybitTradFiSymbolCandidates(symbol: string): string[] {
        const raw = symbol.trim();
        const normalized = raw.toUpperCase();
        const candidates: string[] = [];
        const seen = new Set<string>();

        const push = (candidate: string) => {
            const clean = candidate.trim();
            const key = clean.toUpperCase();
            if (!clean || seen.has(key)) return;
            seen.add(key);
            candidates.push(clean);
        };

        const override = this.bybitTradFiSymbolOverride.get(normalized)
            || this.bybitTradFiSymbolOverride.get(this.getBybitTradFiSymbolKey(normalized));
        if (override) {
            push(override);
        }

        const isFxOrMetal = this.isBybitPlusPreferredSymbol(raw);

        if (raw.toLowerCase().endsWith('.s')) {
            const base = raw.slice(0, -2);
            push(raw);
            if (this.isBybitPlusPreferredSymbol(base)) {
                push(`${base}+`);
            }
            push(`${base}.s`);
            push(base);
        } else if (raw.endsWith('+')) {
            const base = raw.slice(0, -1);
            push(raw);
            push(`${base}.s`);
            push(`${base}+`);
            push(`${base}.S`);
            push(base);
        } else {
            if (isFxOrMetal) {
                push(`${raw}+`);
            }
            push(`${raw}.s`);
            push(raw);
            push(`${raw}.S`);
        }

        return candidates;
    }

    private isBybitPlusPreferredSymbol(symbol: string): boolean {
        const base = symbol.replace(/(\.S|\+)$/i, '');
        if (!base) return false;
        if (base.startsWith('XAU') || base.startsWith('XAG')) return true;
        return base.length === 6;
    }

    private getBybitTradFiSymbolKey(symbol: string): string {
        return symbol.trim().toUpperCase().replace(/(\.S|\+)$/i, '');
    }

    /**
     * Determine which provider to use for a symbol
     */
    private getProvider(symbol: string): DataProvider {
        if (tradfiSearchService.isTradFiSymbol(symbol)) {
            return 'bybit-tradfi';
        }

        // Check if it looks like a Binance crypto symbol
        if (symbol.endsWith('USDT') || symbol.endsWith('BUSD') ||
            symbol.endsWith('BTC') || symbol.endsWith('ETH') ||
            symbol.endsWith('BNB')) {
            return 'binance';
        }

        // Everything else goes to Twelve Data (stocks, forex, commodities)
        return 'twelvedata';
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
        const rawBars = Number.isFinite(state.mockChartBars) ? Math.floor(state.mockChartBars) : this.TOTAL_LIMIT;
        const barsCount = Math.min(this.MAX_MOCK_BARS, Math.max(this.MIN_MOCK_BARS, rawBars));
        const config: MockChartConfig = {
            barsCount,
            volatility: 1.5,
            startPrice: this.getMockPrice(symbol),
            intervalSeconds: this.getIntervalSeconds(interval),
        };

        const model: MockChartModel = state.mockChartModel ?? 'simple';
        if (model === 'hard') {
            return this.generateChallengingMockData(config, this.createRandomSeed());
        }
        if (model === 'v3') {
            return this.generateAdversarialMockData(config, this.createRandomSeed());
        }
        if (model === 'v4') {
            return this.generateMarketRealismMockData(config, this.createRandomSeed());
        }
        if (model === 'v5') {
            return this.generateMarketRealismMockDataV5(config, this.createRandomSeed());
        }

        return this.generateSimpleMockData(config);
    }

    private generateSimpleMockData(config: MockChartConfig): OHLCVData[] {
        const data: OHLCVData[] = [];
        let price = config.startPrice;
        const now = Math.floor(Date.now() / 1000);

        // Start 'barsCount' periods ago
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        for (let i = 0; i < config.barsCount; i++) {
            const volatility = price * (config.volatility / 100);
            const change = (Math.random() - 0.5) * volatility;
            const open = price;
            const close = price + change;
            const high = Math.max(open, close) + Math.random() * volatility * 0.5;
            const low = Math.min(open, close) - Math.random() * volatility * 0.5;
            const volume = Math.floor(Math.random() * 1000000) + 100000;

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            price = close;
            if (price < config.startPrice * 0.1) {
                price = config.startPrice * 0.1;
            }
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    private generateChallengingMockData(config: MockChartConfig, seed: number): OHLCVData[] {
        type Regime = {
            length: number;
            drift: number;
            volMult: number;
            meanReversion: number;
            jumpProb: number;
            jumpSize: number;
            gapProb: number;
            gapStd: number;
            anchor: number;
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000003 + 0x9e3779b9);
        const baseVol = Math.max(0.0001, config.volatility / 100);
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 50);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);
        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            // Reduce extreme single-bar moves vs earlier versions.
            const limit = 0.22;
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let vol = baseVol;
        let prevRet = 0;

        const pickRegime = (): Regime => {
            const roll = rng();
            const length = this.randInt(rng, 120, 1400);
            const anchor = clampLog(logPrice + (rng() - 0.5) * baseVol * 10);

            if (roll < 0.25) {
                const dir = rng() < 0.5 ? -1 : 1;
                return {
                    length,
                    drift: dir * baseVol * 0.12,
                    volMult: 0.75,
                    meanReversion: 0.02,
                    jumpProb: 0.0015,
                    jumpSize: baseVol * 2.2,
                    gapProb: 0.002,
                    gapStd: baseVol * 1.1,
                    anchor
                };
            }

            if (roll < 0.55) {
                return {
                    length,
                    drift: 0,
                    volMult: 0.65,
                    meanReversion: 0.08,
                    jumpProb: 0.0006,
                    jumpSize: baseVol * 1.8,
                    gapProb: 0.0015,
                    gapStd: baseVol * 0.9,
                    anchor
                };
            }

            if (roll < 0.8) {
                return {
                    length,
                    drift: 0,
                    volMult: 1.2,
                    meanReversion: 0.01,
                    jumpProb: 0.0025,
                    jumpSize: baseVol * 3,
                    gapProb: 0.0035,
                    gapStd: baseVol * 1.6,
                    anchor
                };
            }

            return {
                length,
                drift: 0,
                volMult: 0.45,
                meanReversion: 0.03,
                jumpProb: 0.0003,
                jumpSize: baseVol * 1.5,
                gapProb: 0.0008,
                gapStd: baseVol * 0.8,
                anchor
            };
        };

        let regime = pickRegime();
        let regimeLeft = regime.length;

        const omega = baseVol * baseVol * 0.05;
        const alpha = 0.12;
        const beta = 0.85;

        for (let i = 0; i < config.barsCount; i++) {
            if (regimeLeft-- <= 0) {
                regime = pickRegime();
                regimeLeft = regime.length;
            }

            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const season =
                0.85 +
                0.3 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
                0.15 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = Math.max(0.4, season);

            vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

            const gap = rng() < regime.gapProb ? this.randNormal(rng) * regime.gapStd : 0;
            logPrice = clampLog(logPrice + gap);
            let open = Math.exp(logPrice);

            const eps = this.randNormal(rng);
            const meanRevert = regime.meanReversion * (regime.anchor - logPrice);
            let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * eps;

            if (rng() < regime.jumpProb) {
                const jumpDir = rng() < 0.5 ? -1 : 1;
                ret += jumpDir * regime.jumpSize * (0.5 + rng());
            }

            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }
            if (open < floor) open = floor;

            const rangeBase = Math.max(baseVol * 0.25, Math.abs(ret) + vol * 0.5);
            const wick = Math.abs(this.randNormal(rng)) * rangeBase * open;
            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            const volFactor = Math.min(5, 0.5 + Math.abs(ret) / baseVol);
            const volume = Math.floor(100000 * (1 + volFactor) * (0.7 + rng() * 0.6));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            prevRet = ret;
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    private generateAdversarialMockData(config: MockChartConfig, seed: number): OHLCVData[] {
        type Regime = {
            length: number;
            drift: number;
            meanReversion: number;
            volMult: number;
            antiPersist: number;
            trapProb: number;
            spikeProb: number;
            gapProb: number;
            gapStd: number;
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000003 + 0x85ebca6b);
        const baseVol = Math.max(0.0001, config.volatility / 100);
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 50);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);
        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            const limit = Math.max(0.08, baseVol * 8);
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let anchor = logPrice;
        let vol = baseVol;
        let prevRet = 0;
        let revertBias = 0;

        const pickRegime = (): Regime => {
            const roll = rng();
            const length = this.randInt(rng, 30, 220);

            if (roll < 0.45) {
                return {
                    length,
                    drift: 0,
                    meanReversion: 0.18,
                    volMult: 1.4,
                    antiPersist: 0.8,
                    trapProb: 0.85,
                    spikeProb: 0.06,
                    gapProb: 0.02,
                    gapStd: baseVol * 2.0
                };
            }

            if (roll < 0.75) {
                const dir = rng() < 0.5 ? -1 : 1;
                return {
                    length,
                    drift: dir * baseVol * 0.12,
                    meanReversion: 0.03,
                    volMult: 1.0,
                    antiPersist: 0.25,
                    trapProb: 0.4,
                    spikeProb: 0.03,
                    gapProb: 0.01,
                    gapStd: baseVol * 1.2
                };
            }

            return {
                length,
                drift: 0,
                meanReversion: 0.1,
                volMult: 1.8,
                antiPersist: 0.6,
                trapProb: 0.95,
                spikeProb: 0.08,
                gapProb: 0.025,
                gapStd: baseVol * 2.5
            };
        };

        let regime = pickRegime();
        let regimeLeft = regime.length;

        const omega = baseVol * baseVol * 0.08;
        const alpha = 0.18;
        const beta = 0.8;

        for (let i = 0; i < config.barsCount; i++) {
            if (regimeLeft-- <= 0) {
                regime = pickRegime();
                regimeLeft = regime.length;
            }

            anchor = clampLog(anchor + (rng() - 0.5) * baseVol * 0.25);

            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const season =
                0.9 +
                0.25 * Math.sin((2 * Math.PI * minuteOfDay) / 1440) +
                0.1 * Math.sin((4 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = Math.max(0.35, season);

            vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);

            const gap = rng() < regime.gapProb ? this.randNormal(rng) * regime.gapStd : 0;
            logPrice = clampLog(logPrice + gap);
            const open = Math.exp(logPrice);

            const dist = logPrice - anchor;
            const meanRevert = -regime.meanReversion * dist;
            let ret = regime.drift + meanRevert + (vol * regime.volMult * seasonMult) * this.randNormal(rng);

            if (revertBias !== 0) {
                ret += revertBias;
                revertBias *= 0.45;
                if (Math.abs(revertBias) < baseVol * 0.005) {
                    revertBias = 0;
                }
            }

            if (rng() < regime.antiPersist) {
                ret -= 0.6 * prevRet;
            }

            const band = baseVol * (2.5 + rng() * 3.5);
            if (dist > band && rng() < regime.trapProb) {
                ret -= Math.abs(dist) * (0.4 + rng() * 0.5);
            } else if (dist < -band && rng() < regime.trapProb) {
                ret += Math.abs(dist) * (0.4 + rng() * 0.5);
            }

            if (rng() < regime.spikeProb) {
                const spikeDir = rng() < 0.5 ? -1 : 1;
                const spike = spikeDir * baseVol * (2 + rng() * 5);
                ret += spike;
                revertBias = -spikeDir * baseVol * (1.2 + rng() * 2);
            }

            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }

            const rangeBase = Math.max(baseVol * 0.3, Math.abs(ret) + vol * 0.6);
            const wickNoise = Math.abs(this.randNormal(rng)) * rangeBase * open;
            const wickBoost = rng() < 0.05 ? 1.5 + rng() * 3 : 0;
            const wick = wickNoise * (1 + wickBoost);

            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            const volFactor = Math.min(6, 0.6 + Math.abs(ret) / baseVol);
            const volume = Math.floor(120000 * (1 + volFactor) * (0.5 + rng() * 0.7));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            prevRet = ret;
            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    /**
     * V4 "Market Realism" - Designed to produce the most realistic market simulation
     * that benefits strategies which work on live markets.
     * 
     * Key features:
     * - Multi-scale trends (nested higher timeframe bias)
     * - Realistic autocorrelation (short momentum, mid-term mean reversion)
     * - Stop hunting patterns (price probes levels before reversing)
     * - Liquidity events (gaps, sweeps, volatility clusters)
     * - Volume-price correlation (volume spikes on significant moves)
     * - Smart money patterns (accumulation/distribution phases)
     * - False breakouts that trap traders
     */
    private generateMarketRealismMockData(config: MockChartConfig, seed: number): OHLCVData[] {
        type MarketPhase = {
            length: number;
            type: 'accumulation' | 'markup' | 'distribution' | 'markdown' | 'ranging';
            trendStrength: number;      // 0-1 trend intensity
            volatilityBase: number;     // Base volatility multiplier
            trapProbability: number;    // Likelihood of false breakouts
            huntProbability: number;    // Likelihood of stop hunting sweeps
            gapProbability: number;     // Overnight gap probability
            momentum: number;           // Short-term momentum strength (0-1)
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000007 + 0xc0ffee42);
        const baseVol = Math.max(0.0001, config.volatility / 100);
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 100);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);

        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            const limit = Math.max(0.10, baseVol * 9);
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let vol = baseVol;

        // Multi-scale state tracking
        let higherTfBias = 0;              // -1 to 1, represents higher timeframe trend
        let higherTfBiasDecay = 0;
        let mediumTfAnchor = logPrice;
        let shortTermMomentum = 0;

        // Stop hunting tracking
        let recentHigh = logPrice;
        let recentLow = logPrice;
        let huntDirection = 0;             // +1 for upside hunt, -1 for downside hunt
        let huntPhase = 0;                 // 0=none, 1=hunting, 2=reverting

        // Accumulation/distribution tracking
        const priceHistory: number[] = [];
        const momentumHistory: number[] = [];
        const returnHistory: number[] = [];

        // GARCH volatility parameters
        const omega = baseVol * baseVol * 0.06;
        const alpha = 0.15;
        const beta = 0.82;

        const pickPhase = (): MarketPhase => {
            const roll = rng();
            const length = this.randInt(rng, 50, 400);

            // Accumulation phase - quiet, ranging with hidden buying
            if (roll < 0.20) {
                higherTfBias = 0.2 + rng() * 0.3;  // Slight bullish bias building
                higherTfBiasDecay = 0.0005;
                return {
                    length,
                    type: 'accumulation',
                    trendStrength: 0.04,
                    volatilityBase: 0.55,
                    trapProbability: 0.08,
                    huntProbability: 0.10,
                    gapProbability: 0.005,
                    momentum: 0.2
                };
            }

            // Markup phase - trending up with pullbacks
            if (roll < 0.40) {
                higherTfBias = 0.4 + rng() * 0.4;
                higherTfBiasDecay = 0.001;
                return {
                    length,
                    type: 'markup',
                    trendStrength: 0.10 + rng() * 0.06,
                    volatilityBase: 0.9,
                    trapProbability: 0.06,
                    huntProbability: 0.08,
                    gapProbability: 0.01,
                    momentum: 0.6
                };
            }

            // Distribution phase - topping, higher volatility, false breakouts
            if (roll < 0.55) {
                higherTfBias = -0.1 - rng() * 0.2;  // Bearish bias building
                higherTfBiasDecay = 0.0003;
                return {
                    length,
                    type: 'distribution',
                    trendStrength: 0.03,
                    volatilityBase: 1.1,
                    trapProbability: 0.16,
                    huntProbability: 0.14,
                    gapProbability: 0.012,
                    momentum: 0.35
                };
            }

            // Markdown phase - trending down with bounces
            if (roll < 0.75) {
                higherTfBias = -0.4 - rng() * 0.4;
                higherTfBiasDecay = 0.0012;
                return {
                    length,
                    type: 'markdown',
                    trendStrength: 0.08 + rng() * 0.08,
                    volatilityBase: 1.05,
                    trapProbability: 0.07,
                    huntProbability: 0.09,
                    gapProbability: 0.012,
                    momentum: 0.55
                };
            }

            // Ranging phase - choppy, mean reverting, high trap probability
            higherTfBias = (rng() - 0.5) * 0.2;
            higherTfBiasDecay = 0.0001;
            return {
                length,
                type: 'ranging',
                trendStrength: 0.02,
                volatilityBase: 0.8,
                trapProbability: 0.22,
                huntProbability: 0.16,
                gapProbability: 0.007,
                momentum: 0.15
            };
        };

        let phase = pickPhase();
        let phaseLeft = phase.length;
        mediumTfAnchor = logPrice;

        for (let i = 0; i < config.barsCount; i++) {
            if (phaseLeft-- <= 0) {
                phase = pickPhase();
                phaseLeft = phase.length;
                mediumTfAnchor = logPrice;
                recentHigh = logPrice;
                recentLow = logPrice;
            }

            // Update recent highs/lows for stop hunting
            if (priceHistory.length >= 20) {
                const recent = priceHistory.slice(-20);
                recentHigh = Math.max(...recent);
                recentLow = Math.min(...recent);
            }

            // Intraday volatility seasonality
            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const hourFactor = Math.sin((2 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = 0.7 + 0.4 * Math.abs(hourFactor) + 0.2 * (hourFactor > 0.5 ? 1 : 0);

            // GARCH volatility
            const lastRet = returnHistory.length > 0 ? returnHistory[returnHistory.length - 1] : 0;
            vol = Math.sqrt(omega + alpha * lastRet * lastRet + beta * vol * vol);

            // Gap generation
            let gap = 0;
            if (rng() < phase.gapProbability) {
                gap = this.randNormal(rng) * baseVol * (1.2 + rng() * 2.5);
            }
            logPrice = clampLog(logPrice + gap);
            let open = Math.exp(logPrice);

            // Base return components
            let ret = 0;

            // 1. Higher timeframe bias (slow trend)
            const htfContrib = higherTfBias * baseVol * 0.03;
            higherTfBias = higherTfBias * (1 - higherTfBiasDecay);
            ret += htfContrib;

            // 2. Medium timeframe mean reversion (anchor drift)
            const mtfDist = logPrice - mediumTfAnchor;
            const mtfRevert = -mtfDist * 0.03 * (phase.type === 'ranging' ? 2 : 1);
            ret += mtfRevert;

            // 3. Short-term momentum (autocorrelation)
            if (momentumHistory.length > 0) {
                const recentMom = momentumHistory.slice(-5);
                const avgMom = recentMom.reduce((a, b) => a + b, 0) / recentMom.length;
                shortTermMomentum = avgMom * phase.momentum;
            }
            ret += shortTermMomentum * 0.4;

            // 4. Phase-specific trend
            if (phase.type === 'markup') {
                ret += phase.trendStrength * baseVol;
            } else if (phase.type === 'markdown') {
                ret -= phase.trendStrength * baseVol;
            }

            // 5. Stop hunting behavior
            if (huntPhase === 0 && rng() < phase.huntProbability) {
                const upDist = recentHigh - logPrice;
                const downDist = logPrice - recentLow;
                huntDirection = upDist > downDist ? 1 : -1;
                huntPhase = 1;
            }

            if (huntPhase === 1) {
                // Hunting - push toward stop levels
                ret += huntDirection * baseVol * (1.0 + rng() * 1.5);
                if (rng() < 0.3) {
                    huntPhase = 2;  // Start reverting
                }
            } else if (huntPhase === 2) {
                // Reverting after hunt
                ret -= huntDirection * baseVol * (1.4 + rng() * 1.8);
                if (rng() < 0.5) {
                    huntPhase = 0;  // Back to normal
                }
            }

            // 6. False breakout traps
            if (rng() < phase.trapProbability) {
                const trapDir = rng() < 0.5 ? 1 : -1;
                const trapSize = baseVol * (0.7 + rng() * 1.4);
                ret += trapDir * trapSize;
                // Queue a reversal for next bars
                shortTermMomentum = -trapDir * trapSize * 0.5;
            }

            // 7. Random noise
            const noise = this.randNormal(rng) * vol * phase.volatilityBase * seasonMult;
            ret += noise;

            // Apply and clamp return
            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }
            if (open < floor) open = floor;

            // Wicks - more pronounced during volatile phases
            const wickBase = Math.max(baseVol * 0.15, Math.abs(ret) + vol * 0.3);
            const wickMultiplier = phase.type === 'distribution' ? 1.3 :
                phase.type === 'ranging' ? 1.1 : 1.0;
            const wick = Math.abs(this.randNormal(rng)) * wickBase * open * wickMultiplier;

            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            // Extra wick extension during hunts
            if (huntPhase === 1) {
                if (huntDirection > 0) {
                    high += wick * 0.4;
                } else {
                    low -= wick * 0.4;
                }
            }

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            // Volume - correlates with price movement and volatility
            const absRet = Math.abs(ret);
            const volFactor = Math.min(8, 0.4 + (absRet / baseVol) * 1.5 + (vol / baseVol) * 0.5);
            const huntVolBoost = huntPhase > 0 ? 1.8 : 1.0;
            const volume = Math.floor(100000 * (1 + volFactor) * huntVolBoost * (0.6 + rng() * 0.6));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            // Update history
            priceHistory.push(logPrice);
            momentumHistory.push(ret);
            returnHistory.push(ret);

            // Keep history bounded
            if (priceHistory.length > 100) priceHistory.shift();
            if (momentumHistory.length > 20) momentumHistory.shift();
            if (returnHistory.length > 50) returnHistory.shift();

            // Slowly drift medium anchor
            mediumTfAnchor = mediumTfAnchor * 0.995 + logPrice * 0.005;

            time = (Number(time) + config.intervalSeconds) as Time;
        }

        return data;
    }

    /**
     * V5 "Market Realism" - Less stylized, more like noisy live crypto/FX:
     * - Volatility clustering (GARCH-like)
     * - Regime switching between trend / range / chop
     * - Mild mean reversion around a drifting anchor
     * - Fat tails (jumps) without contrived stop-hunt patterns
     * - Volume correlated with absolute returns
     */
    private generateMarketRealismMockDataV5(config: MockChartConfig, seed: number): OHLCVData[] {
        type Regime = {
            length: number;
            drift: number;
            volTarget: number;
            meanReversion: number;
            ar: number;
            jumpProb: number;
            jumpScale: number;
            gapProb: number;
            sweepProb: number;
            volumeBias: number;
        };

        const data: OHLCVData[] = [];
        const now = Math.floor(Date.now() / 1000);
        let time = (now - (config.barsCount * config.intervalSeconds)) as Time;

        const rng = this.makeRng(seed * 1000013 + 0xa7f3c2b1);
        const baseVol = Math.max(0.00005, config.volatility / 100);
        const intervalMinutes = Math.max(1, config.intervalSeconds / 60);
        const volScale = Math.min(3, Math.pow(intervalMinutes, 0.45));
        const floor = Math.max(0.01, config.startPrice * 0.05);
        const ceiling = Math.max(floor * 2, config.startPrice * 80);
        const logFloor = Math.log(floor);
        const logCeil = Math.log(ceiling);
        const baseVolume = 110000;

        const clampLog = (value: number): number => {
            if (!Number.isFinite(value)) return logFloor;
            if (value < logFloor) return logFloor;
            if (value > logCeil) return logCeil;
            return value;
        };
        const clampReturn = (value: number): number => {
            const limit = Math.min(0.35, Math.max(0.08, baseVol * 10 * volScale));
            if (!Number.isFinite(value)) return 0;
            if (value < -limit) return -limit;
            if (value > limit) return limit;
            return value;
        };

        let logPrice = Math.log(Math.max(config.startPrice, floor));
        let vol = baseVol;
        let prevRet = 0;
        let anchor = logPrice;
        let macroTrend = (rng() - 0.5) * 0.4;
        let shortMom = 0;

        const omega = baseVol * baseVol * 0.08;
        const alpha = 0.08;
        const beta = 0.78;

        const regimeBars = (minMinutes: number, maxMinutes: number): number => {
            const minBars = Math.max(20, Math.round(minMinutes / intervalMinutes));
            const maxBars = Math.max(minBars + 5, Math.round(maxMinutes / intervalMinutes));
            return this.randInt(rng, minBars, maxBars);
        };

        const pickRegime = (): Regime => {
            const roll = rng();
            if (roll < 0.30) {
                return {
                    length: regimeBars(180, 2200),
                    drift: 0,
                    volTarget: 0.6,
                    meanReversion: 0.08,
                    ar: -0.15,
                    jumpProb: 0.001,
                    jumpScale: 1.2,
                    gapProb: 0.003,
                    sweepProb: 0.015,
                    volumeBias: 0.85,
                };
            }
            if (roll < 0.60) {
                const dir = rng() < 0.5 ? -1 : 1;
                return {
                    length: regimeBars(240, 3000),
                    drift: dir * baseVol * (0.04 + rng() * 0.03),
                    volTarget: 0.85,
                    meanReversion: 0.02,
                    ar: 0.18,
                    jumpProb: 0.0015,
                    jumpScale: 1.4,
                    gapProb: 0.004,
                    sweepProb: 0.025,
                    volumeBias: 1.05,
                };
            }
            if (roll < 0.85) {
                return {
                    length: regimeBars(120, 1400),
                    drift: 0,
                    volTarget: 1.05,
                    meanReversion: 0.03,
                    ar: 0.05,
                    jumpProb: 0.003,
                    jumpScale: 1.8,
                    gapProb: 0.006,
                    sweepProb: 0.035,
                    volumeBias: 1.15,
                };
            }
            return {
                length: regimeBars(60, 900),
                drift: 0,
                volTarget: 1.35,
                meanReversion: 0.04,
                ar: -0.05,
                jumpProb: 0.004,
                jumpScale: 2.2,
                gapProb: 0.008,
                sweepProb: 0.05,
                volumeBias: 1.35,
            };
        };

        let regime = pickRegime();
        let regimeLeft = regime.length;

        for (let i = 0; i < config.barsCount; i++) {
            if (regimeLeft-- <= 0) {
                regime = pickRegime();
                regimeLeft = regime.length;
                anchor = logPrice;
            }

            const minuteOfDay = ((Math.floor(Number(time) / 60) % 1440) + 1440) % 1440;
            const intraday = 0.75 + 0.35 * Math.sin((2 * Math.PI * minuteOfDay) / 1440);
            const seasonMult = config.intervalSeconds <= 3600 ? Math.max(0.5, intraday) : 1.0;

            vol = Math.sqrt(omega + alpha * prevRet * prevRet + beta * vol * vol);
            const targetVol = baseVol * regime.volTarget;
            vol = vol * 0.85 + targetVol * 0.15;

            macroTrend = macroTrend * 0.998 + this.randNormal(rng) * 0.0016;
            if (macroTrend > 1) macroTrend = 1;
            if (macroTrend < -1) macroTrend = -1;

            const gap = rng() < regime.gapProb ? this.randNormal(rng) * baseVol * 0.6 * volScale : 0;
            logPrice = clampLog(logPrice + gap);
            const open = Math.exp(logPrice);

            shortMom = shortMom * 0.7 + prevRet * 0.3;
            const meanRevert = -regime.meanReversion * (logPrice - anchor);
            const macroDrift = macroTrend * baseVol * 0.03;
            const noise = this.randNormal(rng) * vol * regime.volTarget * seasonMult * volScale;

            let ret = regime.drift + meanRevert + regime.ar * shortMom + macroDrift + noise;
            if (rng() < regime.jumpProb) {
                ret += this.randNormal(rng) * baseVol * regime.jumpScale * volScale;
            }

            ret = clampReturn(ret);
            logPrice = clampLog(logPrice + ret);
            let close = Math.exp(logPrice);

            if (close < floor) {
                close = floor;
                logPrice = Math.log(close);
            }

            const rangeBase = Math.max(baseVol * 0.15, Math.abs(ret) + vol * 0.35);
            const wick = Math.abs(this.randNormal(rng)) * rangeBase * open * 0.7;
            let high = Math.max(open, close) + wick;
            let low = Math.min(open, close) - wick;

            if (rng() < regime.sweepProb) {
                const sweep = Math.abs(this.randNormal(rng)) * rangeBase * open * (0.8 + rng());
                if (rng() < 0.5) {
                    high += sweep;
                } else {
                    low -= sweep;
                }
            }

            const lowFloor = floor * 0.8;
            const highCeil = ceiling * 1.2;
            if (low < lowFloor) low = lowFloor;
            if (high > highCeil) high = highCeil;
            if (high < low) high = Math.max(open, close);

            const absRet = Math.abs(ret);
            const volFactor = Math.min(8, 0.5 + (absRet / baseVol) * 1.1 + (vol / baseVol) * 0.5);
            const jumpBoost = absRet > baseVol * 3 ? 1.3 : 1.0;
            const volume = Math.floor(baseVolume * regime.volumeBias * (1 + volFactor) * jumpBoost * (0.6 + rng() * 0.6));

            data.push({
                time,
                open,
                high,
                low,
                close,
                volume,
            });

            prevRet = ret;
            anchor = anchor * 0.995 + logPrice * 0.005;
            time = (Number(time) + config.intervalSeconds) as Time;
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

    public isMockSymbol(symbol: string): boolean {
        return this.MOCK_SYMBOLS.has(symbol);
    }

    private isBinanceInterval(interval: string): boolean {
        return this.BINANCE_INTERVALS.has(interval);
    }

    private parseCustomMinutes(interval: string): number | null {
        if (this.isBinanceInterval(interval)) return null;
        if (!interval.endsWith('m')) return null;
        const minutes = parseInt(interval.slice(0, -1), 10);
        if (!Number.isFinite(minutes) || minutes <= 0) return null;
        return minutes;
    }

    private resolveFetchInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
        if (this.isBinanceInterval(interval)) {
            return { sourceInterval: interval, needsResample: false };
        }
        const customMinutes = this.parseCustomMinutes(interval);
        if (customMinutes) {
            const targetSeconds = customMinutes * 60;
            let bestInterval = '1m';
            let bestSeconds = 60;

            for (const candidate of this.BINANCE_INTERVALS) {
                if (candidate === '1M') continue;
                const seconds = this.getIntervalSeconds(candidate);
                if (!Number.isFinite(seconds) || seconds <= 0) continue;
                if (seconds > targetSeconds) continue;
                if (targetSeconds % seconds !== 0) continue;
                if (seconds > bestSeconds) {
                    bestSeconds = seconds;
                    bestInterval = candidate;
                }
            }

            return { sourceInterval: bestInterval, needsResample: true };
        }
        return { sourceInterval: interval, needsResample: false };
    }

    private resolveRawFetchLimit(
        targetBars: number,
        targetInterval: string,
        sourceInterval: string,
        needsResample: boolean
    ): { rawLimit: number; ratio: number } {
        if (!needsResample) {
            return { rawLimit: targetBars, ratio: 1 };
        }

        const targetSeconds = this.getIntervalSeconds(targetInterval);
        const sourceSeconds = this.getIntervalSeconds(sourceInterval);
        const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
            ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
            : 1;

        return { rawLimit: Math.max(targetBars, Math.ceil(targetBars * ratio)), ratio };
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

    private async wait(ms: number): Promise<void> {
        if (!Number.isFinite(ms) || ms <= 0) return;
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private createRandomSeed(): number {
        return Math.floor(Math.random() * 1000000000);
    }

    private makeRng(seed: number): () => number {
        let t = seed >>> 0;
        return () => {
            t += 0x6D2B79F5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    private randInt(rng: () => number, min: number, max: number): number {
        return Math.floor(rng() * (max - min + 1)) + min;
    }

    private randNormal(rng: () => number): number {
        let u = 0;
        let v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
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
        if (this.isMockSymbol(symbol)) {
            debugLogger.info('data.stream.skip_mock', { symbol });
            return;
        }
        const provider = this.getProvider(symbol);
        if (provider === 'binance' && !this.isBinanceInterval(interval)) {
            debugLogger.info('data.stream.skip_interval', { symbol, interval, provider });
            return;
        }

        // If already streaming the same symbol/interval, do nothing
        if (this.isStreaming && this.streamSymbol === symbol && this.streamInterval === interval && this.streamProvider === provider) {
            debugLogger.info('data.stream.already_active', { symbol, interval, provider });
            return;
        }

        // Stop any existing stream first
        this.stopStreaming();

        this.streamSymbol = symbol;
        this.streamInterval = interval;
        this.streamProvider = provider;
        this.reconnectAttempts = 0;

        if (provider === 'binance') {
            this.connectWebSocket();
            return;
        }

        this.startTwelveDataPolling();
    }

    /**
     * Stop the real-time streaming and clean up WebSocket connection
     */
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
            this.isStreaming = false;
            this.ws.close(1000, 'Stream stopped by user');
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

    private startTwelveDataPolling(): void {
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
        if (!this.isPolling || !this.streamSymbol || !this.streamInterval) return;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
        }
        const delay = delayMs ?? this.getPollingDelayMs(this.streamInterval);
        this.pollTimeout = setTimeout(() => {
            this.pollTwelveDataLatest();
        }, delay);
    }

    private getPollingDelayMs(interval: string): number {
        const seconds = this.getIntervalSeconds(interval);
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return 30000;
        }
        if (seconds <= 60) return 15000;
        if (seconds <= 300) return 30000;
        if (seconds <= 3600) return 60000;
        if (seconds <= 86400) return 300000;
        return 900000;
    }

    private async pollTwelveDataLatest(): Promise<void> {
        if (!this.isPolling || !this.streamSymbol || !this.streamInterval) return;
        if (this.pollingInFlight) {
            this.scheduleNextPoll();
            return;
        }

        const symbol = this.streamSymbol;
        const interval = this.streamInterval;

        this.pollingInFlight = true;
        if (this.pollAbort) {
            this.pollAbort.abort();
        }
        const abort = new AbortController();
        this.pollAbort = abort;

        try {
            const { candle, provider } = this.streamProvider === 'bybit-tradfi'
                ? { candle: await this.fetchBybitTradFiLatest(symbol, interval, abort.signal), provider: null }
                : await this.fetchNonBinanceLatest(symbol, interval, abort.signal);
            if (abort.signal.aborted) return;
            if (!this.isPolling || symbol !== this.streamSymbol || interval !== this.streamInterval) return;
            if (candle) {
                if (provider) {
                    this.nonBinanceProviderOverride.set(symbol, provider);
                }
                this.applyRealtimeCandle(candle);
            }
        } catch (error) {
            if (!this.isAbortError(error)) {
                debugLogger.warn('data.stream.poll_error', {
                    symbol,
                    interval,
                    error: this.formatError(error)
                });
            }
        } finally {
            this.pollingInFlight = false;
            this.scheduleNextPoll();
        }
    }

    private async fetchNonBinanceLatest(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<{ candle: OHLCVData | null; provider: 'twelvedata' | 'yahoo' | null }> {
        const order = this.getNonBinanceProviderOrder(symbol);
        for (const provider of order) {
            if (signal?.aborted) return { candle: null, provider: null };
            const candle = provider === 'twelvedata'
                ? await this.fetchTwelveDataLatest(symbol, interval, signal)
                : await this.fetchYahooLatest(symbol, interval, signal);
            if (candle) {
                return { candle, provider };
            }
        }
        return { candle: null, provider: null };
    }

    private async fetchTwelveDataLatest(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData | null> {
        const { sourceInterval, needsResample } = this.resolveTwelveDataInterval(interval);
        const targetSeconds = this.getIntervalSeconds(interval);
        const sourceSeconds = this.getIntervalSeconds(sourceInterval);
        const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
            ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
            : 1;
        const outputsize = needsResample ? Math.max(6, ratio * 4) : 2;
        const series = await this.fetchTwelveDataSeries(symbol, sourceInterval, outputsize, signal);
        if (series.length === 0) return null;
        const updatedSeries = needsResample ? resampleOHLCV(series, interval) : series;
        return updatedSeries[updatedSeries.length - 1] ?? null;
    }

    private async fetchBybitTradFiLatest(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData | null> {
        const { sourceInterval, needsResample } = this.resolveBybitTradFiInterval(interval);
        const targetSeconds = this.getIntervalSeconds(interval);
        const sourceSeconds = this.getIntervalSeconds(sourceInterval);
        const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
            ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
            : 1;
        const limit = needsResample ? Math.max(8, ratio * 4) : 2;
        const batch = await this.fetchBybitTradFiBatch(symbol, sourceInterval, limit, undefined, signal);
        if (batch.length === 0) return null;
        const ohlcv = this.mapBybitTradFiToOHLCV(batch);
        if (ohlcv.length === 0) return null;
        const updatedSeries = needsResample ? resampleOHLCV(ohlcv, interval) : ohlcv;
        return updatedSeries[updatedSeries.length - 1] ?? null;
    }

    private async fetchYahooLatest(
        symbol: string,
        interval: string,
        signal?: AbortSignal
    ): Promise<OHLCVData | null> {
        const { sourceInterval, needsResample } = this.resolveYahooInterval(interval);
        const ranges = this.getYahooRangeCandidates(sourceInterval, true);
        for (const range of ranges) {
            if (signal?.aborted) return null;
            const series = await this.fetchYahooSeries(symbol, sourceInterval, range, signal);
            if (series.length === 0) continue;
            const updatedSeries = needsResample ? resampleOHLCV(series, interval) : series;
            const latest = updatedSeries[updatedSeries.length - 1];
            if (latest) return latest;
        }
        return null;
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

                this.applyRealtimeCandle(updatedCandle);

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
    private lastUiUpdateTime: number = 0;

    private applyRealtimeCandle(updatedCandle: OHLCVData): void {
        if (state.replayMode) {
            return;
        }

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
