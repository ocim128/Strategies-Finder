import { dataManager } from "../data-manager";
import { DATA_CHART_TOTAL_LIMIT, SYNTHETIC_TARGET_BARS } from "../data/constants";
import { parseIntervalSeconds } from "../interval-utils";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import { isStockMarketSymbol } from "../local-daily-datasets";
import {
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
    resolveSyntheticAvailableIntervals,
} from "../../scripts/lib/synthetic-pair";
import type { OHLCVData } from "../types/strategies";
import {
    buildRecentSyntheticPairCloseBars,
    normalizeRecentSyntheticLeg,
    type RecentSyntheticLeg,
} from "./recent-synthetic-pair";

const RECENT_TARGET_BARS = 200;
const RECENT_LEG_CACHE_MAX = 512;

type CachedLeg = Promise<RecentSyntheticLeg>;

const legCache = new Map<string, CachedLeg>();
let legHits = 0;
let legMisses = 0;

function cacheKey(symbol: string, interval: string, bars: number): string {
    return `${symbol}|${interval}|${bars}`;
}

function getCachedLeg(key: string): CachedLeg | undefined {
    const cached = legCache.get(key);
    if (!cached) return undefined;
    legCache.delete(key);
    legCache.set(key, cached);
    legHits += 1;
    return cached;
}

function cacheLeg(key: string, promise: CachedLeg, signal?: AbortSignal): CachedLeg {
    if (legCache.size >= RECENT_LEG_CACHE_MAX) {
        const oldest = legCache.keys().next().value;
        if (oldest) legCache.delete(oldest);
    }
    let cached: CachedLeg;
    cached = promise.then((series) => {
        if (signal?.aborted && legCache.get(key) === cached) {
            legCache.delete(key);
        }
        return series;
    }).catch((error) => {
        if (legCache.get(key) === cached) legCache.delete(key);
        throw error;
    });
    legCache.set(key, cached);
    return cached;
}

async function loadLeg(
    symbol: string,
    interval: string,
    bars: number,
    signal?: AbortSignal,
): Promise<RecentSyntheticLeg> {
    const key = cacheKey(symbol, interval, bars);
    const cached = getCachedLeg(key);
    if (cached) return cached;
    legMisses += 1;

    const promise = (async () => {
        const offline = await dataManager.fetchHistoricalData(symbol, interval, bars, {
            signal,
            offline: true,
        });
        if (signal?.aborted) return normalizeRecentSyntheticLeg([]);

        const minHealthyBars = Math.max(RECENT_TARGET_BARS, Math.floor(bars * 0.25));
        const data = offline.length >= minHealthyBars
            ? offline
            : await dataManager.fetchHistoricalData(symbol, interval, bars, { signal });
        return normalizeRecentSyntheticLeg(data);
    })();
    return cacheLeg(key, promise, signal);
}

async function loadPairLegs(
    baseSymbol: string,
    quoteSymbol: string,
    interval: string,
    sourceInterval: string,
    sourceBars: number,
    signal?: AbortSignal,
): Promise<[RecentSyntheticLeg, RecentSyntheticLeg]> {
    const [base, quote] = await Promise.all([
        loadLeg(baseSymbol, sourceInterval, sourceBars, signal),
        loadLeg(quoteSymbol, sourceInterval, sourceBars, signal),
    ]);
    if (signal?.aborted) return [normalizeRecentSyntheticLeg([]), normalizeRecentSyntheticLeg([])];
    if (sourceInterval === interval || (base.times.length > 0 && quote.times.length > 0)) {
        return [base, quote];
    }
    return Promise.all([
        loadLeg(baseSymbol, interval, sourceBars, signal),
        loadLeg(quoteSymbol, interval, sourceBars, signal),
    ]);
}

function recentSourceBars(interval: string, ratio: number): number {
    const intervalSeconds = parseIntervalSeconds(interval) ?? 0;
    const targetSeconds = parseIntervalSeconds("1m") ?? 60;
    const minimum = Math.max(RECENT_TARGET_BARS * 2, RECENT_TARGET_BARS * ratio);
    // Keep a small cushion for gaps while avoiding the 50,000-bar full build.
    const gapCushion = intervalSeconds > targetSeconds ? 2 : 1;
    return Math.min(Math.max(minimum * gapCushion, 400), DATA_CHART_TOTAL_LIMIT);
}

export interface RankPairsRecentLoaderStats {
    legHits: number;
    legMisses: number;
    legCacheSize: number;
}

export function getRankPairsRecentLoaderStats(): RankPairsRecentLoaderStats {
    return {
        legHits,
        legMisses,
        legCacheSize: legCache.size,
    };
}

export function clearRankPairsRecentLoaderCache(): void {
    legCache.clear();
    legHits = 0;
    legMisses = 0;
}

/**
 * Return only the latest 200 synthetic ratio closes. `null` means the token is
 * not a synthetic pair and the caller should use the normal Batch loader.
 */
export async function loadRecentRankPairDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[] | null> {
    const parts = parseSyntheticPairToken(symbol);
    if (!parts) return null;
    if (signal?.aborted) return [];

    const effectiveInterval = resolveEffectiveIntervalForSynthetic(
        symbol,
        parts.baseSymbol,
        parts.quoteSymbol,
        interval,
    );
    const diamondLeg =
        isStockMarketSymbol(parts.baseSymbol) || isStockMarketSymbol(parts.quoteSymbol);
    const available = resolveSyntheticAvailableIntervals(parts.baseSymbol, parts.quoteSymbol);
    const source = diamondLeg ? null : pickSourceInterval(effectiveInterval, 12, available);
    const sourceInterval = source?.sourceInterval ?? effectiveInterval;
    const ratio = source?.ratio ?? 1;
    const shallowBars = recentSourceBars(effectiveInterval, ratio);
    const [base, quote] = await loadPairLegs(
        parts.baseSymbol,
        parts.quoteSymbol,
        effectiveInterval,
        sourceInterval,
        shallowBars,
        signal,
    );
    let result = buildRecentSyntheticPairCloseBars(
        base,
        quote,
        sourceInterval,
        effectiveInterval,
        RECENT_TARGET_BARS,
    );

    if (result.length < RECENT_TARGET_BARS) {
        const fullSourceBars = Math.min(
            SYNTHETIC_TARGET_BARS * ratio,
            DATA_CHART_TOTAL_LIMIT,
        );
        if (fullSourceBars > shallowBars) {
            const [deepBase, deepQuote] = await loadPairLegs(
                parts.baseSymbol,
                parts.quoteSymbol,
                effectiveInterval,
                sourceInterval,
                fullSourceBars,
                signal,
            );
            result = buildRecentSyntheticPairCloseBars(
                deepBase,
                deepQuote,
                sourceInterval,
                effectiveInterval,
                RECENT_TARGET_BARS,
            );
        }
    }
    return result;
}
