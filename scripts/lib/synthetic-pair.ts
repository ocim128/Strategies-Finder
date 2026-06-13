/**
 * Synthetic pair generation helpers.
 *
 * Builds a research-only OHLCV series from two real symbols, typically
 * expressed as a ratio pair such as BNBUSDT / PAXGUSDT => BNBPAXG.
 *
 * The resulting series is designed for backtest and Finder experimentation,
 * not for traded-market fidelity.
 */

import type { Time } from 'lightweight-charts';
import type { OHLCVData } from '../../lib/types/strategies';
import { parseOhlcvBars } from './ohlcv-file';

// ============================================================================
// Public types
// ============================================================================

export type SyntheticMethod = 'ratio';

export interface SyntheticPairDatasetMeta {
    baseBars: number;
    quoteBars: number;
    alignedBars: number;
    droppedBars: number;
}

export interface SyntheticPairDataset {
    bars: OHLCVData[];
    meta: SyntheticPairDatasetMeta;
}

export interface SyntheticPairPayloadSource {
    baseSymbol: string;
    quoteSymbol: string;
    method: SyntheticMethod;
}

export interface SyntheticPairPayload {
    symbol: string;
    interval: string;
    provider: 'synthetic';
    generatedAt: string;
    source: SyntheticPairPayloadSource;
    bars: number;
    data: Array<{
        time: number;
        datetime: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
}

export interface BuildSyntheticPairDatasetOptions {
    base: unknown;
    quote: unknown;
    interval: string;
    minBars?: number;
}

export interface BuildSyntheticPairPayloadOptions {
    baseSymbol: string;
    quoteSymbol: string;
    symbol?: string;
    interval: string;
    base: unknown;
    quote: unknown;
    minBars?: number;
    generatedAt?: string;
}

// ============================================================================
// Errors
// ============================================================================

export class SyntheticQuoteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyntheticQuoteError';
    }
}

export class SyntheticAlignmentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyntheticAlignmentError';
    }
}

// ============================================================================
// Public API
// ============================================================================

export function buildSyntheticPairDataset(
    options: BuildSyntheticPairDatasetOptions
): SyntheticPairDataset {
    const { base, quote, minBars = 1 } = options;

    const baseBars = parseOhlcvBars(base);
    const quoteBars = parseOhlcvBars(quote);

    if (quoteBars.length === 0) {
        throw new SyntheticQuoteError('Quote bars must contain at least one aligned candle.');
    }

    const quoteIndex = new Map<number, OHLCVData>();

    if (baseBars.length === 0) {
        throw new SyntheticAlignmentError('Base bars must contain at least one aligned bar.');
    }

    for (const bar of quoteBars) {
        const time = Number(bar.time);
        if (Number.isFinite(time)) {
            quoteIndex.set(time, bar);
        }
    }

    const usedTimes = new Set<number>();
    const aligned: Array<{ base: OHLCVData; quote: OHLCVData }> = [];

    for (const baseBar of baseBars) {
        const time = Number(baseBar.time);
        if (!Number.isFinite(time)) {
            continue;
        }
        if (usedTimes.has(time)) {
            continue;
        }

        const quoteBar = quoteIndex.get(time);
        if (!quoteBar) {
            continue;
        }

        usedTimes.add(time);
        aligned.push({ base: baseBar, quote: quoteBar });
    }

    aligned.sort((left, right) => Number(left.base.time) - Number(right.base.time));

    const syntheticBars: OHLCVData[] = [];

    for (const { base: baseBar, quote: quoteBar } of aligned) {
        const open = safeDiv(baseBar.open, quoteBar.open);
        const close = safeDiv(baseBar.close, quoteBar.close);

        if (!Number.isFinite(open) || !Number.isFinite(close)) {
            continue;
        }

        // Compute the ratio at each OHLC point using same-instant prices.
        // The old formula (base.high/quote.low) conflated extremes from
        // different moments, inflating the bar range by 3-18× for correlated
        // legs and creating phantom TP/SL fills in backtests.
        const rHigh = safeDiv(baseBar.high, quoteBar.high);
        const rLow = safeDiv(baseBar.low, quoteBar.low);
        const finiteRatios = [open, close, rHigh, rLow].filter(Number.isFinite);

        const high = Math.max(...finiteRatios);
        const low = Math.min(...finiteRatios);

        syntheticBars.push({
            time: baseBar.time as Time,
            open,
            high,
            low,
            close,
            volume: 0,
        });
    }

    if (syntheticBars.length < Math.max(1, minBars)) {
        if (aligned.length === 0) {
            throw new SyntheticAlignmentError('No overlapping bars between base and quote symbol data.');
        }

        throw new SyntheticAlignmentError(
            `Only ${syntheticBars.length} aligned bars available, but at least ${Math.max(1, minBars)} are required.`
        );
    }

    return {
        bars: syntheticBars,
        meta: {
            baseBars: baseBars.length,
            quoteBars: quoteBars.length,
            alignedBars: syntheticBars.length,
            droppedBars: baseBars.length - syntheticBars.length,
        },
    };
}

export function buildSyntheticPairPayload(
    options: BuildSyntheticPairPayloadOptions
): SyntheticPairPayload {
    const { baseSymbol, quoteSymbol, interval, base, quote, minBars = 1, generatedAt } = options;
    const normalizedBase = normalizeSymbol(baseSymbol);
    const normalizedQuote = normalizeSymbol(quoteSymbol);
    const symbol = normalizeSymbol(options.symbol ?? deriveSyntheticSymbol(normalizedBase, normalizedQuote));

    const dataset = buildSyntheticPairDataset({ base, quote, interval, minBars });

    return {
        symbol,
        interval,
        provider: 'synthetic',
        generatedAt: generatedAt ?? new Date().toISOString(),
        source: {
            baseSymbol: normalizedBase,
            quoteSymbol: normalizedQuote,
            method: 'ratio',
        },
        bars: dataset.bars.length,
        data: dataset.bars.map((bar) => ({
            time: Number(bar.time),
            datetime: new Date(Number(bar.time) * 1000).toISOString(),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
        })),
    };
}

// ============================================================================
// Internal helpers
// ============================================================================

function normalizeSymbol(value: string): string {
    return value.trim().toUpperCase();
}

export function deriveSyntheticSymbol(baseSymbol: string, quoteSymbol: string): string {
    const commonSuffixLen = longestCommonSuffix(baseSymbol, quoteSymbol);
    if (commonSuffixLen > 0) {
        const baseCore = baseSymbol.slice(0, baseSymbol.length - commonSuffixLen);
        const quoteCore = quoteSymbol.slice(0, quoteSymbol.length - commonSuffixLen);
        return `${baseCore}${quoteCore}`;
    }

    return `${baseSymbol}${quoteSymbol}`;
}

function longestCommonSuffix(a: string, b: string): number {
    const maxLen = Math.min(a.length, b.length);
    let commonLen = 0;
    for (let i = 1; i <= maxLen; i++) {
        if (a[a.length - i] === b[b.length - i]) {
            commonLen = i;
        } else {
            break;
        }
    }

    return commonLen;
}

function safeDiv(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return NaN;
    }

    return numerator / denominator;
}
