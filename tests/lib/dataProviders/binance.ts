
import type { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV, type ResampleOptions } from "../strategies/resample-utils";
import type { BinanceMarketType } from "../binance-market";
import { debugLogger } from "../debug-logger";
import { DATA_PROVIDER_TOTAL_LIMIT } from "../data/constants";
import { BinanceKline, HistoricalFetchOptions } from '../types/index';
import { getIntervalSeconds, wait } from "./utils";
import { BINANCE_INTERVALS } from "../binance-market-data-utils";
import { resolveBinanceApiBases } from "../binance-api-bases";
import {
    fetchWithTimeoutAndRetry,
    findBestDivisibleInterval,
    formatProviderError,
    isAbortError,
    resolveRawFetchLimit,
} from "./fetch-helpers";

const LIMIT_PER_REQUEST = 1000;
const MAX_REQUESTS = 70;
const BINANCE_WS_BASES: Record<BinanceMarketType, string> = {
    spot: "wss://stream.binance.com:9443",
    futures: "wss://fstream.binance.com",
};
const BINANCE_FETCH_MAX_ATTEMPTS = 3;
const BINANCE_FETCH_RETRY_DELAY_MS = 250;

export function isBinanceInterval(interval: string): boolean {
    return BINANCE_INTERVALS.has(interval);
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
    _options?: ResampleOptions
): { sourceInterval: string; needsResample: boolean } {
    const intervalSeconds = getIntervalSeconds(interval);
    if (intervalSeconds === 7200) {
        // Match the Worker path exactly: always compose 2H from 1H candles so
        // odd/even parity is deterministic and does not depend on exchange-native 2H bars.
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
    marketType?: BinanceMarketType;
};

type FetchKlinePagesResult = {
    rows: BinanceKline[];
    requestCount: number;
};

async function fetchKlinesBatch(
    symbol: string,
    interval: string,
    limit: number,
    options?: FetchKlinesBatchOptions
): Promise<BinanceKline[]> {
    const marketType = options?.marketType ?? "spot";
    const endpointPath = marketType === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
    const endpointErrors: string[] = [];

    for (const base of resolveBinanceApiBases(marketType)) {
        const url = new URL(`${base}${endpointPath}`);
        url.searchParams.set("symbol", symbol);
        url.searchParams.set("interval", interval);
        url.searchParams.set("limit", String(limit));
        const startTime = options?.startTime;
        const endTime = options?.endTime;
        if (typeof startTime === 'number' && Number.isFinite(startTime)) {
            url.searchParams.set("startTime", String(Math.floor(startTime)));
        }
        if (typeof endTime === 'number' && Number.isFinite(endTime)) {
            url.searchParams.set("endTime", String(Math.floor(endTime)));
        }

        try {
            const response = await fetchWithTimeoutAndRetry(url, {}, {
                signal: options?.signal,
                maxAttempts: BINANCE_FETCH_MAX_ATTEMPTS,
                baseDelayMs: BINANCE_FETCH_RETRY_DELAY_MS,
            });
            if (!response.ok) {
                endpointErrors.push(`${base}:${response.status}`);
                debugLogger.warn('data.fetch.http_error', {
                    symbol,
                    interval,
                    marketType,
                    base,
                    status: response.status,
                });
                continue;
            }

            const data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            endpointErrors.push(`${base}:${formatProviderError(error)}`);
        }
    }

    throw new Error(`Binance API unavailable: ${endpointErrors.join(' | ') || 'all endpoints failed'}`);
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

function logBinanceFetchSummary(args: {
    mode: string;
    symbol: string;
    interval: string;
    sourceInterval: string;
    marketType?: BinanceMarketType;
    requestCount: number;
    rows: number;
    durationMs: number;
}): void {
    debugLogger.event('data.fetch.binance_summary', args);
}

async function fetchBackwardKlinePages(args: {
    mode: string;
    symbol: string;
    interval: string;
    sourceInterval: string;
    rawLimit: number;
    initialEndTime?: number;
    signal?: AbortSignal;
    marketType?: BinanceMarketType;
    requestDelayMs?: number;
    maxRequests?: number;
    targetBars?: number;
    ratio?: number;
    onProgress?: (progress: { fetched: number; total: number; requestCount: number }) => void;
}): Promise<FetchKlinePagesResult> {
    const startedAt = Date.now();
    const batches: BinanceKline[][] = [];
    let endTime = args.initialEndTime;
    let requestCount = 0;
    let totalDataLength = 0;
    const maxRequests = Math.min(
        args.maxRequests ?? Math.ceil(args.rawLimit / LIMIT_PER_REQUEST),
        5000
    );

    while (totalDataLength < args.rawLimit && requestCount < maxRequests) {
        if (args.signal?.aborted) return { rows: [], requestCount };
        const remaining = args.rawLimit - totalDataLength;
        const limit = Math.min(remaining, LIMIT_PER_REQUEST);

        const data = await fetchKlinesBatch(args.symbol, args.sourceInterval, limit, {
            endTime,
            signal: args.signal,
            marketType: args.marketType,
        });
        if (data.length === 0) break;

        batches.push(data);
        totalDataLength += data.length;
        endTime = data[0][0] - 1;
        requestCount++;

        if (args.targetBars !== undefined) {
            const ratio = Math.max(1, args.ratio ?? 1);
            const fetched = Math.min(args.targetBars, Math.floor(totalDataLength / ratio));
            args.onProgress?.({ fetched, total: args.targetBars, requestCount });
        }

        if (data.length < limit) break;
        if (args.requestDelayMs) {
            await wait(args.requestDelayMs);
        }
    }

    const rows = batches.reverse().flat();
    logBinanceFetchSummary({
        mode: args.mode,
        symbol: args.symbol,
        interval: args.interval,
        sourceInterval: args.sourceInterval,
        marketType: args.marketType,
        requestCount,
        rows: rows.length,
        durationMs: Date.now() - startedAt,
    });
    return { rows, requestCount };
}

async function fetchForwardKlinePages(args: {
    mode: string;
    symbol: string;
    interval: string;
    sourceInterval: string;
    initialStartTime: number;
    signal?: AbortSignal;
    marketType?: BinanceMarketType;
    requestDelayMs?: number;
    maxRequests?: number;
    onProgress?: (progress: { fetched: number; total: number; requestCount: number }) => void;
}): Promise<FetchKlinePagesResult> {
    const startedAt = Date.now();
    const maxRequests = Math.min(args.maxRequests ?? 30, 5000);
    const batches: BinanceKline[][] = [];
    let requestCount = 0;
    let cursorMs = args.initialStartTime;

    while (requestCount < maxRequests) {
        if (args.signal?.aborted) return { rows: [], requestCount };

        const data = await fetchKlinesBatch(args.symbol, args.sourceInterval, LIMIT_PER_REQUEST, {
            startTime: cursorMs,
            signal: args.signal,
            marketType: args.marketType,
        });
        if (data.length === 0) break;

        batches.push(data);
        requestCount++;
        args.onProgress?.({ fetched: requestCount, total: maxRequests, requestCount });

        const lastOpenMs = Number(data[data.length - 1]?.[0]);
        if (!Number.isFinite(lastOpenMs)) break;
        const nextCursorMs = lastOpenMs + 1;
        if (nextCursorMs <= cursorMs) break;
        cursorMs = nextCursorMs;

        if (data.length < LIMIT_PER_REQUEST) break;
        if (args.requestDelayMs) {
            await wait(args.requestDelayMs);
        }
    }

    const rows = batches.flat();
    logBinanceFetchSummary({
        mode: args.mode,
        symbol: args.symbol,
        interval: args.interval,
        sourceInterval: args.sourceInterval,
        marketType: args.marketType,
        requestCount,
        rows: rows.length,
        durationMs: Date.now() - startedAt,
    });
    return { rows, requestCount };
}

export async function fetchBinanceData(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    options?: ResampleOptions & { marketType?: BinanceMarketType }
): Promise<OHLCVData[]> {
    try {
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const { rows: allRawData } = await fetchBackwardKlinePages({
            mode: 'full',
            symbol,
            interval,
            sourceInterval,
            rawLimit: DATA_PROVIDER_TOTAL_LIMIT,
            maxRequests: MAX_REQUESTS,
            signal,
            marketType: options?.marketType,
        });
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
        return [];
    }
}

export async function fetchBinanceDataWithLimit(
    symbol: string,
    interval: string,
    totalBars: number,
    options?: HistoricalFetchOptions & ResampleOptions & { marketType?: BinanceMarketType }
): Promise<OHLCVData[]> {
    try {
        const targetBars = Math.max(1, Math.floor(totalBars));
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const { rawLimit, ratio } = resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
        const { rows: allRawData } = await fetchBackwardKlinePages({
            mode: 'historical',
            symbol,
            interval,
            sourceInterval,
            rawLimit,
            maxRequests: options?.maxRequests,
            requestDelayMs: options?.requestDelayMs,
            signal: options?.signal,
            marketType: options?.marketType,
            targetBars,
            ratio: needsResample ? ratio : 1,
            onProgress: options?.onProgress,
        });
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

export async function fetchBinanceDataBefore(
    symbol: string,
    interval: string,
    beforeTimeSec: number,
    totalBars: number,
    options?: HistoricalFetchOptions & ResampleOptions & { marketType?: BinanceMarketType }
): Promise<OHLCVData[]> {
    try {
        const targetBars = Math.max(1, Math.floor(totalBars));
        const beforeSec = Math.max(0, Math.floor(beforeTimeSec || 0));
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const { rawLimit, ratio } = resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
        const { rows: allRawData } = await fetchBackwardKlinePages({
            mode: 'historical-prefix',
            symbol,
            interval,
            sourceInterval,
            rawLimit,
            initialEndTime: Math.max(0, beforeSec * 1000 - 1),
            maxRequests: options?.maxRequests,
            requestDelayMs: options?.requestDelayMs,
            signal: options?.signal,
            marketType: options?.marketType,
            targetBars,
            ratio: needsResample ? ratio : 1,
            onProgress: options?.onProgress,
        });
        const mapped = mapToOHLCV(allRawData);
        const beforeTime = beforeSec;
        const filtered = mapped.filter(bar => Number(bar.time) < beforeTime);

        if (needsResample) {
            const resampled = resampleOHLCV(filtered, interval, options);
            return resampled.slice(-targetBars);
        }

        return filtered.slice(-targetBars);
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.fetch.historical_prefix_error', {
            symbol,
            interval,
            error: formatProviderError(error),
        });
        return [];
    }
}

export async function fetchBinanceDataAfter(
    symbol: string,
    interval: string,
    fromTimeSec: number,
    options?: HistoricalFetchOptions & ResampleOptions & { marketType?: BinanceMarketType }
): Promise<OHLCVData[]> {
    try {
        const fromSec = Math.max(0, Math.floor(fromTimeSec || 0));
        const { sourceInterval, needsResample } = resolveFetchInterval(interval, options);
        const targetSeconds = Math.max(1, getIntervalSeconds(interval));
        const sourceSeconds = Math.max(1, getIntervalSeconds(sourceInterval));
        const overlapSeconds = Math.max(targetSeconds, sourceSeconds);
        const { rows } = await fetchForwardKlinePages({
            mode: 'gap',
            symbol,
            interval,
            sourceInterval,
            initialStartTime: Math.max(0, fromSec - overlapSeconds) * 1000,
            maxRequests: options?.maxRequests,
            requestDelayMs: options?.requestDelayMs,
            signal: options?.signal,
            marketType: options?.marketType,
            onProgress: options?.onProgress,
        });
        const mapped = mapToOHLCV(rows);
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
    onClose?: (event: CloseEvent) => void,
    marketType: BinanceMarketType = "spot"
): WebSocket {
    const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
    const wsUrl = `${BINANCE_WS_BASES[marketType]}/ws/${streamName}`;
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


