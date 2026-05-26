
import type { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV, type ResampleOptions } from "../strategies/resample-utils";
import { debugLogger } from "../debug-logger";
import { DATA_PROVIDER_TOTAL_LIMIT } from "../data/constants";
import { normalizeTradFiDailyCandles } from "../data/data-interval-utils";
import { BybitTradFiKline, BybitTradFiKlineResponse, HistoricalFetchOptions } from '../types/index';
import { getIntervalSeconds, wait } from "./utils";
import {
    createFetchTimeoutSignal,
    findBestDivisibleInterval,
    formatProviderError,
    isAbortError,
    resolveRawFetchLimit,
} from "./fetch-helpers";

const BYBIT_LIMIT_PER_REQUEST = 500;
const MAX_REQUESTS = 60;
const BYBIT_TRADFI_KLINE_URL = '/api/tradfi-kline';
const BYBIT_TRADFI_INTERVALS = new Set([
    // Bybit TradFi copymt5/kline supports these raw intervals.
    // Higher custom intervals are fetched from best divisible base + resampled.
    '1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'
]);

// State for symbol resolution optimization
const bybitTradFiSymbolOverride = new Map<string, string>();
const unsupportedBybitTradFiSymbols = new Set<string>();

export class BybitTradFiUnsupportedSymbolError extends Error {
    constructor(public readonly symbol: string) {
        super(`Bybit TradFi symbol is invalid: ${symbol}`);
        this.name = "BybitTradFiUnsupportedSymbolError";
    }
}

function markBybitTradFiSymbolUnsupported(symbol: string): void {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    unsupportedBybitTradFiSymbols.add(normalized);
    unsupportedBybitTradFiSymbols.add(getBybitTradFiSymbolKey(normalized));
}

export function isBybitTradFiSymbolKnownUnsupported(symbol: string): boolean {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return false;
    return unsupportedBybitTradFiSymbols.has(normalized)
        || unsupportedBybitTradFiSymbols.has(getBybitTradFiSymbolKey(normalized));
}

export function resetBybitTradFiSymbolSupportForTests(): void {
    bybitTradFiSymbolOverride.clear();
    unsupportedBybitTradFiSymbols.clear();
}

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

function normalizeBybitTradFiInterval(interval: string): string {
    const trimmed = interval.trim();
    if (!trimmed) return '';

    const minuteHourDayWeek = /^(\d+)([mhdw])$/i.exec(trimmed);
    if (minuteHourDayWeek) {
        return `${Number(minuteHourDayWeek[1])}${minuteHourDayWeek[2].toLowerCase()}`;
    }

    const month = /^(\d+)M$/.exec(trimmed);
    if (month) {
        return `${Number(month[1])}M`;
    }

    return trimmed.toLowerCase();
}

function mapToBybitTradFiInterval(interval: string): string {
    const normalized = normalizeBybitTradFiInterval(interval);
    if (normalized === '1d') return 'D+2';
    if (normalized === '1w') return 'W+2';
    if (normalized === '1M') return 'M+2';

    const minutes = Math.max(1, Math.floor(getIntervalSeconds(normalized) / 60));
    return String(minutes);
}

function resolveBybitTradFiInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
    const normalized = normalizeBybitTradFiInterval(interval);

    if (BYBIT_TRADFI_INTERVALS.has(normalized)) {
        return { sourceInterval: normalized, needsResample: false };
    }

    const targetSeconds = getIntervalSeconds(normalized);
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
        return { sourceInterval: '1d', needsResample: false };
    }

    const bestInterval = findBestDivisibleInterval(targetSeconds, BYBIT_TRADFI_INTERVALS);

    if (bestInterval) {
        return { sourceInterval: bestInterval, needsResample: true };
    }

    return { sourceInterval: '1m', needsResample: true };
}

function mapBybitTradFiToOHLCV(rawData: BybitTradFiKline[], interval: string): OHLCVData[] {
    const mapped = rawData
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
    return normalizeTradFiDailyCandles(mapped, interval);
}

async function fetchBybitTradFiBatch(
    symbol: string,
    interval: string,
    limit: number,
    to?: number,
    signal?: AbortSignal
): Promise<BybitTradFiKline[]> {
    if (isBybitTradFiSymbolKnownUnsupported(symbol)) {
        throw new BybitTradFiUnsupportedSymbolError(symbol);
    }

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

        const timeout = createFetchTimeoutSignal(signal);
        try {
            const response = await fetch(`${BYBIT_TRADFI_KLINE_URL}?${params.toString()}`, {
                signal: timeout.signal,
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
            if (retCode === 10001) {
                continue;
            }

            throw new Error(retMsg || `Bybit TradFi API error (${retCode})`);
        } finally {
            timeout.cleanup();
        }
    }

    markBybitTradFiSymbolUnsupported(symbol);
    throw new BybitTradFiUnsupportedSymbolError(symbol);
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

        while (totalDataLength < DATA_PROVIDER_TOTAL_LIMIT && requestCount < MAX_REQUESTS) {
            if (signal?.aborted) return [];
            const remaining = DATA_PROVIDER_TOTAL_LIMIT - totalDataLength;
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
        const mapped = mapBybitTradFiToOHLCV(allRawData, sourceInterval);
        return needsResample ? resampleOHLCV(mapped, interval, options) : mapped;
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        if (error instanceof BybitTradFiUnsupportedSymbolError) {
            return [];
        }
        debugLogger.error('data.bybit_tradfi.error', {
            symbol,
            interval,
            error: formatProviderError(error),
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
        const mapped = mapBybitTradFiToOHLCV(allRawData, sourceInterval);
        if (needsResample) {
            const resampled = resampleOHLCV(mapped, interval, options);
            return resampled.slice(-targetBars);
        }
        return mapped.slice(-targetBars);
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        if (error instanceof BybitTradFiUnsupportedSymbolError) {
            throw error;
        }
        debugLogger.error('data.bybit_tradfi.historical_error', {
            symbol,
            interval,
            error: formatProviderError(error),
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
    const ohlcv = mapBybitTradFiToOHLCV(batch, sourceInterval);
    if (ohlcv.length === 0) return null;
    const updatedSeries = needsResample ? resampleOHLCV(ohlcv, interval, options) : ohlcv;
    return updatedSeries[updatedSeries.length - 1] ?? null;
}


