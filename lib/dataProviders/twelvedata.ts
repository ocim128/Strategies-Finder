
import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV } from "../strategies/resample-utils";
import { debugLogger } from "../debugLogger";
import { getIntervalSeconds } from "./utils";

const TWELVE_DATA_API_KEY_STORAGE = 'twelvedataApiKey';
const TWELVE_DATA_INTERVALS = new Set([
    '1m', '5m', '15m', '30m', '45m',
    '1h', '2h', '4h', '8h',
    '1d', '1w', '1M'
]);

function getTwelveDataApiKey(): string | null {
    try {
        const envKey = (import.meta as ImportMeta).env?.VITE_TWELVE_DATA_API_KEY;
        if (envKey && envKey.trim()) return envKey.trim();
        if (typeof window !== 'undefined' && window.localStorage) {
            const key = window.localStorage.getItem(TWELVE_DATA_API_KEY_STORAGE);
            if (key && key.trim()) return key.trim();
        }
    } catch {
        // Ignore storage access errors
    }
    return null;
}

function mapToTwelveDataInterval(interval: string): string {
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

function normalizeTwelveDataSymbol(symbol: string): string {
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

function resolveTwelveDataInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
    if (TWELVE_DATA_INTERVALS.has(interval)) {
        return { sourceInterval: interval, needsResample: false };
    }

    const targetSeconds = getIntervalSeconds(interval);
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
        return { sourceInterval: '1d', needsResample: false };
    }

    let bestInterval: string | null = null;
    let bestSeconds = 0;

    for (const candidate of TWELVE_DATA_INTERVALS) {
        if (candidate === '1M') continue;
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

async function fetchTwelveDataSeries(
    symbol: string,
    interval: string,
    outputsize: number,
    signal?: AbortSignal
): Promise<OHLCVData[]> {
    const apiKey = getTwelveDataApiKey();
    if (!apiKey) {
        debugLogger.warn('data.twelvedata.missing_key', { symbol });
        return [];
    }
    const twelveInterval = mapToTwelveDataInterval(interval);
    const resolvedSymbol = normalizeTwelveDataSymbol(symbol);
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

export async function fetchTwelveData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
    try {
        const { sourceInterval, needsResample } = resolveTwelveDataInterval(interval);
        const ohlcv = await fetchTwelveDataSeries(symbol, sourceInterval, 5000, signal);
        const result = needsResample ? resampleOHLCV(ohlcv, interval) : ohlcv;

        debugLogger.info('data.twelvedata.success', {
            symbol,
            interval,
            sourceInterval,
            bars: result.length,
        });

        return result;
    } catch (error) {
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.twelvedata.error', {
            symbol,
            interval,
            error: formatError(error),
        });
        console.warn('Twelve Data fetch failed:', error);
        return [];
    }
}

export async function fetchTwelveDataLatest(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData | null> {
    const { sourceInterval, needsResample } = resolveTwelveDataInterval(interval);
    const targetSeconds = getIntervalSeconds(interval);
    const sourceSeconds = getIntervalSeconds(sourceInterval);
    const ratio = Number.isFinite(targetSeconds) && Number.isFinite(sourceSeconds) && sourceSeconds > 0
        ? Math.max(1, Math.round(targetSeconds / sourceSeconds))
        : 1;
    const outputsize = needsResample ? Math.max(6, ratio * 4) : 2;
    try {
        const series = await fetchTwelveDataSeries(symbol, sourceInterval, outputsize, signal);
        if (series.length === 0) return null;
        const updatedSeries = needsResample ? resampleOHLCV(series, interval) : series;
        return updatedSeries[updatedSeries.length - 1] ?? null;
    } catch (error) {
        return null;
    }
}
