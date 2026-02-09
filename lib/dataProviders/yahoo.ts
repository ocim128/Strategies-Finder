
import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { resampleOHLCV } from "../strategies/resample-utils";
import { debugLogger } from "../debugLogger";
import { getIntervalSeconds } from "./utils";

function getYahooIntervalSeconds(interval: string): number {
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
        default: return getIntervalSeconds(interval);
    }
}

function resolveYahooInterval(interval: string): { sourceInterval: string; needsResample: boolean } {
    const supported = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d', '1w', '1M']);
    if (supported.has(interval)) {
        return { sourceInterval: interval, needsResample: false };
    }

    const targetSeconds = getIntervalSeconds(interval);
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
        return { sourceInterval: '1d', needsResample: false };
    }

    let bestInterval: string | null = null;
    let bestSeconds = 0;
    for (const candidate of supported) {
        if (candidate === '1M') continue;
        const seconds = getYahooIntervalSeconds(candidate);
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

function getYahooRangeCandidates(interval: string, minimal: boolean): string[] {
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

function mapToYahooSymbol(symbol: string): string {
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

function mapToYahooInterval(interval: string): string {
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

async function fetchYahooSeries(
    symbol: string,
    interval: string,
    range: string,
    signal?: AbortSignal
): Promise<OHLCVData[]> {
    const yahooSymbol = mapToYahooSymbol(symbol);
    const yahooInterval = mapToYahooInterval(interval);
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

export async function fetchYahooData(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
    try {
        const { sourceInterval, needsResample } = resolveYahooInterval(interval);
        const ranges = getYahooRangeCandidates(sourceInterval, false);
        for (const range of ranges) {
            if (signal?.aborted) return [];
            const ohlcv = await fetchYahooSeries(symbol, sourceInterval, range, signal);
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
        if (isAbortError(error)) {
            return [];
        }
        debugLogger.error('data.yahoo.error', {
            symbol,
            interval,
            error: formatError(error),
        });
        return [];
    }
}

export async function fetchYahooLatest(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData | null> {
    const { sourceInterval, needsResample } = resolveYahooInterval(interval);
    const ranges = getYahooRangeCandidates(sourceInterval, true);
    for (const range of ranges) {
        if (signal?.aborted) return null;
        try {
            const series = await fetchYahooSeries(symbol, sourceInterval, range, signal);
            if (series.length === 0) continue;
            const updatedSeries = needsResample ? resampleOHLCV(series, interval) : series;
            const latest = updatedSeries[updatedSeries.length - 1];
            if (latest) return latest;
        } catch {
            continue;
        }
    }
    return null;
}
