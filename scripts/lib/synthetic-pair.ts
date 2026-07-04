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
import { parseIntervalSeconds } from '../../lib/interval-utils';
import { SYNTHETIC_SOURCE_BARS_LIMIT } from '../../lib/data/constants';
import { getLocalDailyDatasetConfig, isIbkrSymbol, isMarkedLocalStockSymbol, isStockMarketSymbol } from '../../lib/local-daily-datasets';

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
    sourceInterval?: string;
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
    sourceInterval?: string;
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

    const aligned: Array<{ base: OHLCVData; quote: OHLCVData }> = [];

    // Dedup happens upstream in parseOhlcvBars (last-write-wins); here we only align.
    for (const baseBar of baseBars) {
        const time = Number(baseBar.time);
        if (!Number.isFinite(time)) {
            continue;
        }

        const quoteBar = quoteIndex.get(time);
        if (!quoteBar) {
            continue;
        }

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

        const volume = Math.min(
            Number.isFinite(baseBar.volume) ? baseBar.volume : 0,
            Number.isFinite(quoteBar.volume) ? quoteBar.volume : 0,
        );

        syntheticBars.push({
            time: baseBar.time as Time,
            open,
            high,
            low,
            close,
            volume: Math.max(0, volume),
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
    const { baseSymbol, quoteSymbol, interval, base, quote, minBars = 1, generatedAt, sourceInterval } = options;
    const normalizedBase = normalizeSymbol(baseSymbol);
    const normalizedQuote = normalizeSymbol(quoteSymbol);
    const symbol = normalizeSymbol(options.symbol ?? deriveSyntheticSymbol(normalizedBase, normalizedQuote));

    const buildInterval = sourceInterval ?? interval;
    const dataset = buildSyntheticPairDataset({ base, quote, interval: buildInterval, minBars });
    const finalBars = sourceInterval
        ? aggregateSyntheticBars(dataset.bars, interval)
        : dataset.bars;

    return {
        symbol,
        interval,
        provider: 'synthetic',
        generatedAt: generatedAt ?? new Date().toISOString(),
        source: {
            baseSymbol: normalizedBase,
            quoteSymbol: normalizedQuote,
            method: 'ratio',
            sourceInterval,
        },
        bars: finalBars.length,
        data: finalBars.map((bar) => ({
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

const SOURCE_INTERVAL_CANDIDATES = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];
const sourceIntervalCache = new Map<string, { sourceInterval: string; ratio: number } | null>();

export function pickSourceInterval(
    targetInterval: string,
    maxRatio = 12,
    /**
     * Optional allowlist of intervals that actually exist on disk for both
     * legs (e.g. IBKR's `supportedIntervals`). When supplied, candidates
     * outside this set are skipped. Default (undefined) keeps the original
     * crypto-path behavior where every divisible interval is fair game.
     */
    availableIntervals?: readonly string[],
): { sourceInterval: string; ratio: number } | null {
    const allowSet = availableIntervals ? new Set(availableIntervals) : null;
    const cacheKey = `${targetInterval}|${maxRatio}|${allowSet ? Array.from(allowSet).sort().join(",") : "*"}`;
    const cached = sourceIntervalCache.get(cacheKey);
    if (cached !== undefined) {
        return cached ? { ...cached } : null;
    }

    const targetSecs = parseIntervalSeconds(targetInterval);
    if (!targetSecs || targetSecs <= 0) {
        sourceIntervalCache.set(cacheKey, null);
        return null;
    }

    for (const candidate of SOURCE_INTERVAL_CANDIDATES) {
        if (allowSet && !allowSet.has(candidate)) continue;
        const candidateSecs = parseIntervalSeconds(candidate);
        if (!candidateSecs || candidateSecs <= 0) continue;
        if (candidateSecs >= targetSecs) continue;
        if (targetSecs % candidateSecs !== 0) continue;

        const ratio = targetSecs / candidateSecs;
        if (ratio <= maxRatio) {
            const result = { sourceInterval: candidate, ratio };
            sourceIntervalCache.set(cacheKey, result);
            return { ...result };
        }
    }

    sourceIntervalCache.set(cacheKey, null);
    return null;
}

export function resolveSyntheticSourceBars(targetBars: number, sourceRatio = 1): number {
    const normalizedTarget = Math.max(1, Math.floor(Number.isFinite(targetBars) ? targetBars : 1));
    const normalizedRatio = Math.max(1, Math.floor(Number.isFinite(sourceRatio) ? sourceRatio : 1));
    return Math.min(SYNTHETIC_SOURCE_BARS_LIMIT, normalizedTarget * normalizedRatio);
}

// ============================================================================
// Pipeline helper
// ============================================================================

/**
 * Returns IBKR's on-disk `supportedIntervals` allowlist when either leg is
 * IBKR-marked, so {@link pickSourceInterval} only considers seed intervals
 * that IBKR actually stores. Returns `undefined` for crypto/diamond legs so
 * the original behavior (any divisible interval) is preserved.
 *
 * Centralized here so all three gate sites (buildSyntheticPairFromLegs,
 * loadSyntheticPairForBatch, Finder loadSyntheticPairForUniverse) apply the
 * same disk-aware filter without re-deriving it.
 */
export function resolveSyntheticAvailableIntervals(
    baseSymbol: string,
    quoteSymbol: string,
): readonly string[] | undefined {
    if (!isIbkrSymbol(baseSymbol) && !isIbkrSymbol(quoteSymbol)) return undefined;
    const config = getLocalDailyDatasetConfig("ibkr-stock");
    return config?.supportedIntervals;
}

/**
 * Result of {@link buildSyntheticPairFromLegs}. Mirrors {@link SyntheticPairDataset}
 * with the resolved source interval so callers can emit diagnostics without
 * re-deriving it. The raw `base`/`quote` legs are returned for callers (e.g.
 * Portfolio Lab) that need per-leg diagnostics; other callers ignore them.
 */
export interface SyntheticPairFromLegsResult {
    bars: OHLCVData[];
    meta: SyntheticPairDatasetMeta;
    sourceInterval: string;
    base: OHLCVData[];
    quote: OHLCVData[];
}

/**
 * Shared pipeline for the 5 callsites that previously inlined:
 *   pickSourceInterval -> resolveSyntheticSourceBars ->
 *   Promise.all([fetchBase, fetchQuote]) ->
 *   buildSyntheticPairDataset -> aggregateSyntheticBars.
 *
 * Callers inject a `fetchLeg` function so the helper stays pure (no dependency
 * on dataManager, AbortSignal routing, caching, or worker env). Variations
 * that previously caused contract drift collapse to two options:
 *   - `sourceBarsCap` (finder caps at DATA_CHART_TOTAL_LIMIT; others don't)
 *   - `tailSliceBars` (worker slices to targetLimit; others don't)
 *
 * Note: signal-committee-service intentionally builds once and aggregates
 * per-member inside a loop; it does not use this helper.
 */
export async function buildSyntheticPairFromLegs(args: {
    baseSymbol: string;
    quoteSymbol: string;
    interval: string;
    targetBars: number;
    fetchLeg: (symbol: string, sourceInterval: string, sourceBars: number) => Promise<OHLCVData[]>;
    sourceBarsCap?: number;
    tailSliceBars?: number;
    minBars?: number;
    /**
     * When true, an empty base or quote leg yields an empty `bars` array
     * instead of throwing SyntheticAlignmentError / SyntheticQuoteError.
     * Lets callers (e.g. Data Mining) emit their own per-leg diagnostics
     * before deciding how to surface the failure.
     */
    allowEmptyLegs?: boolean;
}): Promise<SyntheticPairFromLegsResult> {
    const { interval, targetBars, fetchLeg, baseSymbol, quoteSymbol } = args;
    const minBars = args.minBars ?? 1;
    // Diamond-marked legs (offline stock_market_data) only have `1d` bars, so
    // source-interval subdivision would fetch legs at an interval that has no
    // data and every pair would fail. Bullet-marked IBKR legs CAN have
    // intraday bars (30m, 1h, 4h...), so they take the normal subdivision
    // path. The discriminator is the diamond marker specifically, not the
    // combined `isMarkedLocalStockSymbol`.
    const diamondLeg = isStockMarketSymbol(baseSymbol) || isStockMarketSymbol(quoteSymbol);
    // Disk-aware seed: when one or both legs are IBKR, restrict candidates to
    // intervals IBKR actually stores. pickSourceInterval('1d') would otherwise
    // pick '2h' (ratio 12) which no IBKR symbol has on disk — this filter
    // makes it skip 2h and fall back to the target interval itself when no
    // finer interval in `supportedIntervals` divides evenly within the cap.
    const available = resolveSyntheticAvailableIntervals(baseSymbol, quoteSymbol);
    const source = diamondLeg ? null : pickSourceInterval(interval, 12, available);
    const sourceInterval = source?.sourceInterval ?? interval;
    const rawSourceBars = resolveSyntheticSourceBars(targetBars, source?.ratio ?? 1);
    const sourceBars = args.sourceBarsCap
        ? Math.min(rawSourceBars, args.sourceBarsCap)
        : rawSourceBars;

    let [base, quote] = await Promise.all([
        fetchLeg(baseSymbol, sourceInterval, sourceBars),
        fetchLeg(quoteSymbol, sourceInterval, sourceBars),
    ]);
    // Track whether we actually subdivided. The fallback below may collapse
    // back to target-interval fetching, in which case no aggregation runs.
    let subdivided = source !== null;

    // Disk-aware fallback: when subdivision picked a finer seed interval
    // (e.g. 1d -> 4h seed) and either leg came back empty, the symbol likely
    // only has data at the target interval (e.g. AAPL has 1d but not 4h on
    // disk). Retry BOTH legs at the target interval so they end up at the
    // same resolution and the alignment step doesn't mix seed-interval bars
    // with target-interval bars. Asymmetric fallback (one leg at seed, one
    // at target) would produce silent data corruption because the alignment
    // step matches by exact timestamp and a 1h bar coincides with a 4h
    // boundary only one in four times.
    if (subdivided && (base.length === 0 || quote.length === 0)) {
        const [baseFallback, quoteFallback] = await Promise.all([
            fetchLeg(baseSymbol, interval, targetBars),
            fetchLeg(quoteSymbol, interval, targetBars),
        ]);
        // Only swap if BOTH legs returned data at the target interval;
        // otherwise we'd reintroduce the asymmetric-resolution hazard.
        if (baseFallback.length > 0 && quoteFallback.length > 0) {
            base = baseFallback;
            quote = quoteFallback;
            subdivided = false;
        }
    }

    if (args.allowEmptyLegs && (base.length === 0 || quote.length === 0)) {
        return { bars: [], meta: { baseBars: base.length, quoteBars: quote.length, alignedBars: 0, droppedBars: 0 }, sourceInterval, base, quote };
    }

    const effectiveInterval = subdivided ? sourceInterval : interval;
    const dataset = buildSyntheticPairDataset({ base, quote, interval: effectiveInterval, minBars });
    const bars = subdivided
        ? aggregateSyntheticBars(dataset.bars, interval)
        : dataset.bars;

    return {
        bars: args.tailSliceBars ? bars.slice(-Math.max(1, args.tailSliceBars)) : bars,
        meta: dataset.meta,
        sourceInterval: effectiveInterval,
        base,
        quote,
    };
}

export function aggregateSyntheticBars(
    bars: OHLCVData[],
    targetInterval: string,
): OHLCVData[] {
    const targetSecs = parseIntervalSeconds(targetInterval);
    if (!targetSecs || targetSecs <= 0) return bars;
    if (bars.length <= 1) return bars;

    const buckets = new Map<number, OHLCVData[]>();
    // The producer (buildSyntheticPairDataset) always returns ascending bars,
    // so each bucket's bars are already in chronological order and the
    // per-bucket re-sort is wasted work in the hot path. Track monotonicity
    // during bucketing so unsorted input (e.g. direct calls from tests or
    // ad-hoc callers) still gets sorted, preserving the documented contract.
    let inputAscending = true;
    let prevEpoch = -Infinity;

    for (const bar of bars) {
        const epoch = Number(bar.time);
        if (!Number.isFinite(epoch)) continue;
        if (epoch < prevEpoch) inputAscending = false;
        prevEpoch = epoch;

        const bucketStart = Math.floor(epoch / targetSecs) * targetSecs;
        const bucket = buckets.get(bucketStart);
        if (bucket) {
            bucket.push(bar);
            continue;
        }

        buckets.set(bucketStart, [bar]);
    }

    const result: OHLCVData[] = [];
    const sortedBucketStarts = Array.from(buckets.keys()).sort((left, right) => left - right);

    for (const bucketStart of sortedBucketStarts) {
        const chunk = buckets.get(bucketStart);
        if (!chunk || chunk.length === 0) continue;
        const sortedChunk = inputAscending || chunk.length === 1
            ? chunk
            : chunk.slice().sort((left, right) => Number(left.time) - Number(right.time));

        let high = -Infinity;
        let low = Infinity;
        let volume = 0;
        for (const subBar of sortedChunk) {
            if (subBar.high > high) high = subBar.high;
            if (subBar.low < low) low = subBar.low;
            volume += Number.isFinite(subBar.volume) ? subBar.volume : 0;
        }

        result.push({
            time: bucketStart as Time,
            open: sortedChunk[0].open,
            close: sortedChunk[sortedChunk.length - 1].close,
            high,
            low,
            volume,
        });
    }

    return result;
}

// ============================================================================
// Internal helpers
// ============================================================================

function normalizeSymbol(value: string): string {
    return value.trim().toUpperCase();
}

/**
 * Stock-market symbols (offline stock_market_data) only have `1d` bars. When
 * a marked symbol or synthetic leg is involved, the requested interval must be
 * coerced to `1d` or the local-daily loader returns empty and the whole
 * universe/batch load fails. Mixed pairs (e.g. BTCUSDT+AAPL♦) also coerce
 * because one daily-only leg forces the whole pair to daily resolution.
 *
 * Centralized here so Finder and Batch Backtest apply the same rule.
 */
export function resolveEffectiveIntervalForSynthetic(
    symbol: string,
    baseSymbol: string | null,
    quoteSymbol: string | null,
    interval: string,
): string {
    const involvesStockMarket =
        isStockMarketSymbol(symbol)
        || (baseSymbol !== null && isStockMarketSymbol(baseSymbol))
        || (quoteSymbol !== null && isStockMarketSymbol(quoteSymbol));
    return involvesStockMarket ? '1d' : interval;
}

export function deriveSyntheticSymbol(baseSymbol: string, quoteSymbol: string): string {
    // When either leg carries the diamond marker (offline stock_market_data
    // namespace), the suffix-stripping logic below would silently drop the
    // shared marker and produce an ambiguous bare-ticker synthetic. Switch to
    // an explicit `leg+leg` join so the result stays namespaced, e.g.
    // NVDA♦ + AAPL♦ => NVDA♦+AAPL♦.
    if (isMarkedLocalStockSymbol(baseSymbol) || isMarkedLocalStockSymbol(quoteSymbol)) {
        return `${baseSymbol}+${quoteSymbol}`;
    }

    const commonSuffixLen = longestCommonSuffix(baseSymbol, quoteSymbol);
    if (commonSuffixLen > 0) {
        const baseCore = baseSymbol.slice(0, baseSymbol.length - commonSuffixLen);
        const quoteCore = quoteSymbol.slice(0, quoteSymbol.length - commonSuffixLen);
        return `${baseCore}${quoteCore}`;
    }

    return `${baseSymbol}${quoteSymbol}`;
}

export function isSyntheticSymbol(
    symbol: string,
    known: { baseSymbol: string; quoteSymbol: string } | null,
): boolean {
    if (!known) return false;
    return normalizeSymbol(symbol) === deriveSyntheticSymbol(
        normalizeSymbol(known.baseSymbol),
        normalizeSymbol(known.quoteSymbol),
    );
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
