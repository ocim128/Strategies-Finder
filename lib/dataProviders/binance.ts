
import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV, type ResampleOptions } from "../strategies/resample-utils";
import { debugLogger } from "../debug-logger";
import { DATA_PROVIDER_TOTAL_LIMIT } from "../data/constants";
import { BinanceKline, HistoricalFetchOptions } from '../types/index';
import { getIntervalSeconds, wait } from "./utils";
import {
    findBestDivisibleInterval,
    formatProviderError,
    isAbortError,
    resolveRawFetchLimit,
} from "./fetch-helpers";

const LIMIT_PER_REQUEST = 1000;
const MAX_REQUESTS = 15;
const BINANCE_INTERVALS = new Set([
    '1m', '3m', '5m', '15m', '30m',
    '1h', '2h', '4h', '6h', '8h', '12h',
    '1d', '3d', '1w', '1M'
]);

export function isBinanceInterval(interval: string): boolean {
    return BINANCE_INTERVALS.has(interval);
}

function normalizeTwoHourParity(options?: ResampleOptions): 'odd' | 'even' {
    return options?.twoHourCloseParity === 'even' ? 'even' : 'odd';
}

function parseCustomMinutes(interval: string): number | null {
    if (isBinanceInterval(interval)) return null;
    if (!interval.endsWith('m')) return null;
    const minutes = parseInt(interval.slice(0, -1), 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return minutes;
}

export function resolveFetchInterval(
    interval: string,
    options?: ResampleOptions
): { sourceInterval: string; needsResample: boolean } {
    const intervalSeconds = getIntervalSeconds(interval);
    if (intervalSeconds === 7200 && normalizeTwoHourParity(options) === 'even') {
        return { sourceInterval: '1h', needsResample: true };
    }
    if (isBinanceInterval(interval)) {
        return { sourceInterval: interval, needsResample: false };
    }
    const customMinutes = parseCustomMinutes(interval);
    if (customMinutes) {
        const targetSeconds = customMinutes * 60;
        const bestInterval = findBestDivisibleInterval(
            targetSeconds,
            [...BINANCE_INTERVALS].filter((candidate) => candidate !== '1M')
        ) ?? '1m';
        return { sourceInterval: bestInterval, needsResample: true };
    }
    return { sourceInterval: interval, needsResample: false };
}

type FetchKlinesBatchOptions = {
    startTime?: number;
    endTime?: number;
    signal?: AbortSignal;
};

async function fetchKlinesBatch(
    symbol: string,
    interval: string,
    limit: number,
    options?: FetchKlinesBatchOptions
): Promise<BinanceKline[]> {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const startTime = options?.startTime;
    const endTime = options?.endTime;
    if (typeof startTime === 'number' && Number.isFinite(startTime)) url += `&startTime=${Math.floor(startTime)}`;
    if (typeof endTime === 'number' && Number.isFinite(endTime)) url += `&endTime=${Math.floor(endTime)}`;

    const response = await fetch(url, { signal: options?.signal });
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

function mapToOHLCV(rawData: BinanceKline[]): OHLCVData[] {
    return rawData.map(d => ({
        time: (d[0] / 1000) as Time,
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
    }));
}

export async function fetchBinanceData(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    options?: ResampleOptions
): Promise<OHLCVData[]> {
    try {
        const batches: BinanceKline[][] = [];
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        let endTime: number | undefined;
        let requestCount = 0;
        let totalDataLength = 0;

        while (totalDataLength < DATA_PROVIDER_TOTAL_LIMIT && requestCount < MAX_REQUESTS) {
            if (signal?.aborted) return [];
            const remaining = DATA_PROVIDER_TOTAL_LIMIT - totalDataLength;
            const limit = Math.min(remaining, LIMIT_PER_REQUEST);

            const data = await fetchKlinesBatch(symbol, sourceInterval, limit, { endTime, signal });

            if (data.length === 0) break;

            batches.push(data);
            totalDataLength += data.length;
            endTime = data[0][0] - 1;
            requestCount++;

            if (data.length < limit) break;
        }

        const allRawData = batches.reverse().flat();
        const mapped = mapToOHLCV(allRawData);

        if (needsResample) {
            const resampled = resampleOHLCV(mapped, interval, options);
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
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.fetch.error', {
            symbol,
            interval,
            error: formatProviderError(error),
        });
        console.error('Failed to fetch data:', error);
        return [];
    }
}

export async function fetchBinanceDataWithLimit(
    symbol: string,
    interval: string,
    totalBars: number,
    options?: HistoricalFetchOptions & ResampleOptions
): Promise<OHLCVData[]> {
    try {
        const targetBars = Math.max(1, Math.floor(totalBars));
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const { rawLimit, ratio } = resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
        const batches: BinanceKline[][] = [];
        let endTime: number | undefined;
        let requestCount = 0;
        let totalDataLength = 0;
        const maxRequests = Math.min(
            options?.maxRequests ?? Math.ceil(rawLimit / LIMIT_PER_REQUEST),
            5000
        );

        while (totalDataLength < rawLimit && requestCount < maxRequests) {
            if (options?.signal?.aborted) return [];
            const remaining = rawLimit - totalDataLength;
            const limit = Math.min(remaining, LIMIT_PER_REQUEST);

            const data = await fetchKlinesBatch(symbol, sourceInterval, limit, {
                endTime,
                signal: options?.signal,
            });
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
                await wait(options.requestDelayMs);
            }
        }

        const allRawData = batches.reverse().flat();
        const mapped = mapToOHLCV(allRawData);

        if (needsResample) {
            const resampled = resampleOHLCV(mapped, interval, options);
            return resampled.slice(-targetBars);
        }

        return mapped.slice(-targetBars);
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.fetch.historical_error', {
            symbol,
            interval,
            error: formatProviderError(error),
        });
        throw error;
    }
}

export async function fetchBinanceDataAfter(
    symbol: string,
    interval: string,
    fromTimeSec: number,
    options?: HistoricalFetchOptions & ResampleOptions
): Promise<OHLCVData[]> {
    try {
        const fromSec = Math.max(0, Math.floor(fromTimeSec || 0));
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const targetSeconds = Math.max(1, getIntervalSeconds(interval));
        const sourceSeconds = Math.max(1, getIntervalSeconds(sourceInterval));
        const overlapSeconds = Math.max(targetSeconds, sourceSeconds);
        let cursorMs = Math.max(0, fromSec - overlapSeconds) * 1000;

        const maxRequests = Math.min(options?.maxRequests ?? 30, 5000);
        const batches: BinanceKline[][] = [];
        let requestCount = 0;

        while (requestCount < maxRequests) {
            if (options?.signal?.aborted) return [];

            const data = await fetchKlinesBatch(symbol, sourceInterval, LIMIT_PER_REQUEST, {
                startTime: cursorMs,
                signal: options?.signal,
            });
            if (data.length === 0) break;

            batches.push(data);
            requestCount++;
            options?.onProgress?.({ fetched: requestCount, total: maxRequests, requestCount });

            const lastOpenMs = Number(data[data.length - 1]?.[0]);
            if (!Number.isFinite(lastOpenMs)) break;
            const nextCursorMs = lastOpenMs + 1;
            if (nextCursorMs <= cursorMs) break;
            cursorMs = nextCursorMs;

            if (data.length < LIMIT_PER_REQUEST) break;
            if (options?.requestDelayMs) {
                await wait(options.requestDelayMs);
            }
        }

        const mapped = mapToOHLCV(batches.flat());
        const resampled = needsResample ? resampleOHLCV(mapped, interval, options) : mapped;
        return resampled.filter(bar => Number(bar.time) >= (fromSec - targetSeconds));
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.fetch.gap_error', {
            symbol,
            interval,
            error: formatProviderError(error),
        });
        return [];
    }
}

export function startBinanceStream(
    symbol: string,
    interval: string,
    onUpdate: (candle: OHLCVData) => void,
    onError?: (error: unknown) => void,
    onClose?: (event: CloseEvent) => void
): WebSocket {
    const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
    const wsUrl = `wss://stream.binance.com:9443/ws/${streamName}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.e === 'kline' && message.k) {
                const kline = message.k;
                const candle: OHLCVData = {
                    time: (kline.t / 1000) as Time,
                    open: parseFloat(kline.o),
                    high: parseFloat(kline.h),
                    low: parseFloat(kline.l),
                    close: parseFloat(kline.c),
                    volume: parseFloat(kline.v),
                };
                onUpdate(candle);
            }
        } catch (error) {
            onError?.(error);
        }
    };

    if (onError) ws.onerror = (e) => onError(e);
    if (onClose) ws.onclose = (e) => onClose(e);

    return ws;
}


