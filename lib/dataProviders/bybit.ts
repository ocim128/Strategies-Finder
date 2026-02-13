
import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV, type ResampleOptions } from "../strategies/resample-utils";
import { debugLogger } from "../debug-logger";
import { BybitTradFiKline, BybitTradFiKlineResponse, HistoricalFetchOptions } from '../types/index';
import { getIntervalSeconds, wait } from "./utils";

const BYBIT_LIMIT_PER_REQUEST = 200;
const TOTAL_LIMIT = 30000;
const MAX_REQUESTS = 15;
const BYBIT_TRADFI_KLINE_URL = '/api/tradfi-kline';
const BYBIT_TRADFI_INTERVALS = new Set([
    '1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'
]);

// State for symbol resolution optimization
const bybitTradFiSymbolOverride = new Map<string, string>();

function getBybitTradFiSymbolKey(symbol: string): string {
    return symbol.trim().toUpperCase().replace(/(\.S|\+)$/i, '');
}

function isBybitPlusPreferredSymbol(symbol: string): boolean {
    const base = symbol.replace(/(\.S|\+)$/i, '');
    if (!base) return false;
    if (base.startsWith('XAU') || base.startsWith('XAG')) return true;
    return base.length === 6;
}

function getBybitTradFiSymbolCandidates(symbol: string): string[] {
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

    const override = bybitTradFiSymbolOverride.get(normalized)
        || bybitTradFiSymbolOverride.get(getBybitTradFiSymbolKey(normalized));
    if (override) {
        push(override);
    }

    const isFxOrMetal = isBybitPlusPreferredSymbol(raw);

    if (raw.toLowerCase().endsWith('.s')) {
        const base = raw.slice(0, -2);
        push(raw);
        if (isBybitPlusPreferredSymbol(base)) {
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

function getBybitTradFiRetCode(response: BybitTradFiKlineResponse): number {
    if (typeof response.ret_code === 'number') return response.ret_code;
    if (typeof response.retCode === 'number') return response.retCode;
    return -1;
}

function getBybitTradFiRetMsg(response: BybitTradFiKlineResponse): string {
    if (typeof response.ret_msg === 'string' && response.ret_msg) return response.ret_msg;
    if (typeof response.retMsg === 'string' && response.retMsg) return response.retMsg;
    return 'Bybit TradFi API error';
}

function mapToBybitTradFiInterval(interval: string): string {
    const minutes = Math.max(1, Math.floor(getIntervalSeconds(interval) / 60));
    return String(minutes);
}

function resolveBybitTradFiInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
    if (BYBIT_TRADFI_INTERVALS.has(interval)) {
        return { sourceInterval: interval, needsResample: false };
    }

    const targetSeconds = getIntervalSeconds(interval);
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
        return { sourceInterval: '1d', needsResample: false };
    }

    let bestInterval: string | null = null;
    let bestSeconds = 0;

    for (const candidate of BYBIT_TRADFI_INTERVALS) {
        const seconds = getIntervalSeconds(candidate);
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

function mapBybitTradFiToOHLCV(rawData: BybitTradFiKline[]): OHLCVData[] {
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

function resolveRawFetchLimit(
    targetBars: number,
    targetInterval: string,
    sourceInterval: string,
    needsResample: boolean
): { rawLimit: number; ratio: number } {
    if (!needsResample) {
        return { rawLimit: targetBars, ratio: 1 };
    }

    const targetSeconds = getIntervalSeconds(targetInterval);
    const sourceSeconds = getIntervalSeconds(sourceInterval);
    const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
        ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
        : 1;

    return { rawLimit: Math.max(targetBars, Math.ceil(targetBars * ratio)), ratio };
}

async function fetchBybitTradFiBatch(
    symbol: string,
    interval: string,
    limit: number,
    to?: number,
    signal?: AbortSignal
): Promise<BybitTradFiKline[]> {
    const intervalValue = mapToBybitTradFiInterval(interval);
    const intervalMs = Math.max(60_000, getIntervalSeconds(interval) * 1000);
    const effectiveTo = Number.isFinite(to)
        ? Math.floor(Number(to))
        : Math.floor(Date.now() / intervalMs) * intervalMs;
    const resolvedSymbols = getBybitTradFiSymbolCandidates(symbol);
    const requestLimit = String(Math.min(BYBIT_LIMIT_PER_REQUEST, Math.max(1, Math.floor(limit))));

    for (const requestSymbol of resolvedSymbols) {
        const params = new URLSearchParams({
            timeStamp: Date.now().toString(),
            symbol: requestSymbol,
            interval: intervalValue,
            limit: requestLimit,
            to: String(effectiveTo),
        });

        const response = await fetch(`${BYBIT_TRADFI_KLINE_URL}?${params.toString()}`, {
            signal,
            headers: {
                Accept: 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Bybit TradFi request failed: ${response.status}`);
        }

        const data: BybitTradFiKlineResponse = await response.json();
        const retCode = getBybitTradFiRetCode(data);
        const retMsg = getBybitTradFiRetMsg(data);

        if (retCode === 0) {
            const list = data.result?.list;
            if (!Array.isArray(list)) {
                return [];
            }

            const symbolKey = getBybitTradFiSymbolKey(symbol);
            const normalizedInput = symbol.trim();
            if (requestSymbol !== normalizedInput) {
                bybitTradFiSymbolOverride.set(normalizedInput.toUpperCase(), requestSymbol);
                bybitTradFiSymbolOverride.set(symbolKey, requestSymbol);
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

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
        return error.name === 'AbortError';
    }
    return (error as { name?: string }).name === 'AbortError';
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

export async function fetchBybitTradFiData(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    options?: ResampleOptions
): Promise<OHLCVData[]> {
    try {
        const batches: BybitTradFiKline[][] = [];
        const { sourceInterval, needsResample } = resolveBybitTradFiInterval(interval);
        let endTime: number | undefined;
        let requestCount = 0;
        let totalDataLength = 0;

        while (totalDataLength < TOTAL_LIMIT && requestCount < MAX_REQUESTS) {
            if (signal?.aborted) return [];
            const remaining = TOTAL_LIMIT - totalDataLength;
            const limit = Math.min(remaining, BYBIT_LIMIT_PER_REQUEST);

            const data = await fetchBybitTradFiBatch(symbol, sourceInterval, limit, endTime, signal);
            if (data.length === 0) break;

            batches.push(data);
            totalDataLength += data.length;
            endTime = Number(data[0][0]) - 1;
            requestCount++;

            if (data.length < limit) break;
        }

        const allRawData = batches.reverse().flat();
        const mapped = mapBybitTradFiToOHLCV(allRawData);
        return needsResample ? resampleOHLCV(mapped, interval, options) : mapped;
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.bybit_tradfi.error', {
            symbol,
            interval,
            error: formatError(error),
        });
        return [];
    }
}

export async function fetchBybitTradFiDataWithLimit(
    symbol: string,
    interval: string,
    totalBars: number,
    options?: HistoricalFetchOptions & ResampleOptions
): Promise<OHLCVData[]> {
    try {
        const targetBars = Math.max(1, Math.floor(totalBars));
        const { sourceInterval, needsResample } = resolveBybitTradFiInterval(interval);
        const { rawLimit, ratio } = resolveRawFetchLimit(targetBars, interval, sourceInterval, needsResample);
        const batches: BybitTradFiKline[][] = [];
        let endTime: number | undefined;
        let requestCount = 0;
        let totalDataLength = 0;
        const maxRequests = Math.min(
            options?.maxRequests ?? Math.ceil(rawLimit / BYBIT_LIMIT_PER_REQUEST),
            8000
        );

        while (totalDataLength < rawLimit && requestCount < maxRequests) {
            if (options?.signal?.aborted) return [];
            const remaining = rawLimit - totalDataLength;
            const limit = Math.min(remaining, BYBIT_LIMIT_PER_REQUEST);

            const data = await fetchBybitTradFiBatch(symbol, sourceInterval, limit, endTime, options?.signal);
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
                await wait(options.requestDelayMs);
            }
        }

        const allRawData = batches.reverse().flat();
        const mapped = mapBybitTradFiToOHLCV(allRawData);
        if (needsResample) {
            const resampled = resampleOHLCV(mapped, interval, options);
            return resampled.slice(-targetBars);
        }
        return mapped.slice(-targetBars);
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.bybit_tradfi.historical_error', {
            symbol,
            interval,
            error: formatError(error),
        });
        throw error;
    }
}

export async function fetchBybitTradFiLatest(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    options?: ResampleOptions
): Promise<OHLCVData | null> {
    const { sourceInterval, needsResample } = resolveBybitTradFiInterval(interval);
    const targetSeconds = getIntervalSeconds(interval);
    const sourceSeconds = getIntervalSeconds(sourceInterval);
    const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
        ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
        : 1;
    const limit = needsResample ? Math.max(8, ratio * 4) : 2;
    const batch = await fetchBybitTradFiBatch(symbol, sourceInterval, limit, undefined, signal);
    if (batch.length === 0) return null;
    const ohlcv = mapBybitTradFiToOHLCV(batch);
    if (ohlcv.length === 0) return null;
    const updatedSeries = needsResample ? resampleOHLCV(ohlcv, interval, options) : ohlcv;
    return updatedSeries[updatedSeries.length - 1] ?? null;
}


