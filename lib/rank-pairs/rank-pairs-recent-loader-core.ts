import { DATA_CHART_TOTAL_LIMIT, SYNTHETIC_TARGET_BARS } from "../data/constants";
import { parseIntervalSeconds } from "../interval-utils";
import { isStockMarketSymbol } from "../local-daily-datasets";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import type { OHLCVData } from "../types/strategies";
import {
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
    resolveSyntheticAvailableIntervals,
} from "../../scripts/lib/synthetic-pair";
import {
    buildRecentSyntheticPairCloseBars,
    normalizeRecentSyntheticLeg,
    type RecentSyntheticLeg,
} from "./recent-synthetic-pair";
import { RECENT_PAIR_WINDOW_BARS } from "./recent-pair-classifier";

const RECENT_LEG_CACHE_MAX = 512;

export interface RankPairsRecentLoaderStats {
    legHits: number;
    legMisses: number;
    legEvictions: number;
    legUpgrades: number;
    networkFallbacks: number;
    deepPairFallbacks: number;
    legCacheSize: number;
    legCacheMaxEntries: number;
}

export type RankPairsHistoricalFetcher = (
    symbol: string,
    interval: string,
    bars: number,
    options: { signal?: AbortSignal; offline?: boolean },
) => Promise<OHLCVData[]>;

export interface RankPairsRecentLoader {
    load(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        targetBars?: number,
    ): Promise<OHLCVData[] | null>;
    clear(): void;
    getStats(): RankPairsRecentLoaderStats;
}

export interface RankPairsRecentLoaderOptions {
    legCacheMaxEntries?: number;
}

export function createRankPairsRecentLoader(
    fetchHistorical: RankPairsHistoricalFetcher,
    options: RankPairsRecentLoaderOptions = {},
): RankPairsRecentLoader {
    interface CachedLeg {
        requestedBars: number;
        promise: Promise<RecentSyntheticLeg>;
    }
    const legCacheMaxEntries = Math.max(
        1,
        Math.floor(options.legCacheMaxEntries ?? RECENT_LEG_CACHE_MAX),
    );
    const legCache = new Map<string, CachedLeg>();
    let legHits = 0;
    let legMisses = 0;
    let legEvictions = 0;
    let legUpgrades = 0;
    let networkFallbacks = 0;
    let deepPairFallbacks = 0;

    const cacheKey = (symbol: string, interval: string): string =>
        `${symbol.trim().toUpperCase()}|${interval.trim().toLowerCase()}`;

    const getCachedLeg = (key: string, requestedBars: number): Promise<RecentSyntheticLeg> | undefined => {
        const cached = legCache.get(key);
        if (!cached) return undefined;
        if (cached.requestedBars < requestedBars) {
            legCache.delete(key);
            legUpgrades += 1;
            return undefined;
        }
        legCache.delete(key);
        legCache.set(key, cached);
        legHits += 1;
        return cached.promise;
    };

    const cacheLeg = (
        key: string,
        requestedBars: number,
        promise: Promise<RecentSyntheticLeg>,
        signal?: AbortSignal,
    ): Promise<RecentSyntheticLeg> => {
        if (legCache.size >= legCacheMaxEntries) {
            const oldest = legCache.keys().next().value;
            if (oldest) {
                legCache.delete(oldest);
                legEvictions += 1;
            }
        }
        let cachedPromise: Promise<RecentSyntheticLeg>;
        cachedPromise = promise.then((series) => {
            if (signal?.aborted && legCache.get(key)?.promise === cachedPromise) {
                legCache.delete(key);
            }
            return series;
        }).catch((error) => {
            if (legCache.get(key)?.promise === cachedPromise) legCache.delete(key);
            throw error;
        });
        legCache.set(key, { requestedBars, promise: cachedPromise });
        return cachedPromise;
    };

    const loadLeg = async (
        symbol: string,
        interval: string,
        bars: number,
        targetBars: number,
        signal?: AbortSignal,
    ): Promise<RecentSyntheticLeg> => {
        const key = cacheKey(symbol, interval);
        const cached = getCachedLeg(key, bars);
        if (cached) return cached;
        legMisses += 1;

        const promise = (async () => {
            const offline = await fetchHistorical(symbol, interval, bars, {
                signal,
                offline: true,
            });
            if (signal?.aborted) return normalizeRecentSyntheticLeg([]);
            const minHealthyBars = Math.max(targetBars, Math.floor(bars * 0.25));
            let data = offline;
            if (offline.length < minHealthyBars) {
                networkFallbacks += 1;
                data = await fetchHistorical(symbol, interval, bars, { signal });
            }
            return normalizeRecentSyntheticLeg(data);
        })();
        return cacheLeg(key, bars, promise, signal);
    };

    const loadPairLegs = async (
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        sourceInterval: string,
        sourceBars: number,
        targetBars: number,
        signal?: AbortSignal,
    ): Promise<[RecentSyntheticLeg, RecentSyntheticLeg]> => {
        const [base, quote] = await Promise.all([
            loadLeg(baseSymbol, sourceInterval, sourceBars, targetBars, signal),
            loadLeg(quoteSymbol, sourceInterval, sourceBars, targetBars, signal),
        ]);
        if (signal?.aborted) {
            return [normalizeRecentSyntheticLeg([]), normalizeRecentSyntheticLeg([])];
        }
        if (sourceInterval === interval || (base.times.length > 0 && quote.times.length > 0)) {
            return [base, quote];
        }
        return Promise.all([
            loadLeg(baseSymbol, interval, sourceBars, targetBars, signal),
            loadLeg(quoteSymbol, interval, sourceBars, targetBars, signal),
        ]);
    };

    const recentSourceBars = (interval: string, ratio: number, targetBars: number): number => {
        const intervalSeconds = parseIntervalSeconds(interval) ?? 0;
        const targetSeconds = parseIntervalSeconds("1m") ?? 60;
        const minimum = Math.max(targetBars * 2, targetBars * ratio);
        const gapCushion = intervalSeconds > targetSeconds ? 2 : 1;
        return Math.min(Math.max(minimum * gapCushion, 400), DATA_CHART_TOTAL_LIMIT);
    };

    const load = async (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        requestedTargetBars = RECENT_PAIR_WINDOW_BARS,
    ): Promise<OHLCVData[] | null> => {
        const parts = parseSyntheticPairToken(symbol);
        if (!parts) return null;
        if (signal?.aborted) return [];
        const targetBars = Math.max(1, Math.floor(requestedTargetBars));

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
        const shallowBars = recentSourceBars(effectiveInterval, ratio, targetBars);
        const [base, quote] = await loadPairLegs(
            parts.baseSymbol,
            parts.quoteSymbol,
            effectiveInterval,
            sourceInterval,
            shallowBars,
            targetBars,
            signal,
        );
        let result = buildRecentSyntheticPairCloseBars(
            base,
            quote,
            sourceInterval,
            effectiveInterval,
            targetBars,
        );

        if (result.length < targetBars) {
            const fullSourceBars = Math.min(
                Math.max(SYNTHETIC_TARGET_BARS * ratio, targetBars * ratio),
                DATA_CHART_TOTAL_LIMIT,
            );
            if (fullSourceBars > shallowBars) {
                deepPairFallbacks += 1;
                const [deepBase, deepQuote] = await loadPairLegs(
                    parts.baseSymbol,
                    parts.quoteSymbol,
                    effectiveInterval,
                    sourceInterval,
                    fullSourceBars,
                    targetBars,
                    signal,
                );
                result = buildRecentSyntheticPairCloseBars(
                    deepBase,
                    deepQuote,
                    sourceInterval,
                    effectiveInterval,
                    targetBars,
                );
            }
        }
        return result;
    };

    return {
        load,
        clear: () => {
            legCache.clear();
            legHits = 0;
            legMisses = 0;
            legEvictions = 0;
            legUpgrades = 0;
            networkFallbacks = 0;
            deepPairFallbacks = 0;
        },
        getStats: () => ({
            legHits,
            legMisses,
            legEvictions,
            legUpgrades,
            networkFallbacks,
            deepPairFallbacks,
            legCacheSize: legCache.size,
            legCacheMaxEntries,
        }),
    };
}
