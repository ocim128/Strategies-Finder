/**
 * Node-side dataset loader for server-side Batch Backtest.
 *
 * Mirrors `lib/batch-backtest/batch-backtest-loader.ts` 1:1, but instantiates
 * `DataFetcher` directly instead of going through the browser-bound
 * `dataManager` singleton. The singleton wires UI callbacks that call
 * `uiManager.showToast(...)` etc. (see `lib/data-manager.ts`), which would
 * throw in Node.
 *
 * Same recipe as `DataFetcher.fetchDataDetached` (`lib/data/data-fetcher.ts`
 * :178-192): construct a fresh `DataFetcher` with empty `{}` UI callbacks.
 *
 * Same synthetic-pair pipeline as the browser loader
 * (`buildSyntheticPairFromLegs` + `pickSourceInterval` + per-leg LRU) so
 * bar-for-bar output matches the browser. The leg/pair LRUs are separate
 * module-scope instances — Node and browser are separate processes and must
 * not share cache state.
 *
 * NOTE on local API transport: `DataFetcher` ultimately calls
 * `loadSqliteCandles(...)` which goes through `fetchLocalApi("/api/sqlite/...")`.
 * In Node, relative `/api/...` URLs must be resolved against the dev-server
 * origin — that fix lives in `lib/local-api-transport.ts:resolveLocalApiUrl`.
 * Server-side batch therefore requires the dev server (Vite) to be the same
 * process that hosts `/api/sqlite/*`, which is always the case for this
 * plugin (it is registered as a Vite plugin in `vite.config.ts`).
 */

import { debugLogger } from "../debug-logger";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import { isIbkrSymbol, isMarkedLocalStockSymbol, isStockMarketSymbol } from "../local-daily-datasets";
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
    resolveSyntheticAvailableIntervals,
} from "../../scripts/lib/synthetic-pair";
import { SYNTHETIC_TARGET_BARS, DATA_CHART_TOTAL_LIMIT } from "../data/constants";
import { parseIntervalSeconds } from "../interval-utils";
import { DataCache } from "../data/data-cache";
import { DataFetcher } from "../data/data-fetcher";
import { DataPersistence } from "../data/data-persistence";
import { DataProviderRouter } from "../data/data-provider-router";
import type { OHLCVData } from "../types/strategies";
import {
    SyntheticLegCache,
    buildLegCacheKey,
    buildPairCacheKey,
} from "./synthetic-leg-cache";

// Each leg/pair entry holds a full OHLCV array (~5-10 MB at 100k bars). Match
// the browser loader's caps (commit 6401a53) so server-side steady-state
// retention is bounded the same way the browser path is.
const legCache = new SyntheticLegCache<OHLCVData[]>(24);
const pairCache = new SyntheticLegCache<OHLCVData[]>(16);

const STALE_FRAGMENT_MAX_THRESHOLD = 10_000;
const STALE_FRAGMENT_MIN_THRESHOLD = 200;

// One shared router/cache/persistence instance per dev-server process. These
// hold no UI references and are safe to share across batch runs. The
// `importedDataByKey` Map is empty in Node (no chart-imported datasets), and
// the lookback returns the same default the browser fetcher uses when no
// chart lookback has been set.
const providerRouter = new DataProviderRouter();
const dataCache = new DataCache();
const dataPersistence = new DataPersistence();
const emptyImportedData = new Map<string, OHLCVData[]>();

function createServerDataFetcher(): DataFetcher {
    return new DataFetcher(
        providerRouter,
        dataCache,
        dataPersistence,
        () => emptyImportedData,
        () => DATA_CHART_TOTAL_LIMIT,
        {},
    );
}

/**
 * Server-side equivalent of `loadBatchDataset(...)` in
 * `lib/batch-backtest/batch-backtest-loader.ts`. Returns the same OHLCV series
 * the browser loader would, so a parity test can assert bar-for-bar equality
 * (length, timestamps, OHLCV) between the two paths.
 *
 * Returns `[]` for an aborted load or a synthetic with no usable bars; callers
 * surface that as a per-pair load failure rather than throwing. Same contract
 * as the browser loader.
 */
export async function loadServerBatchDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    const synthParts = parseSyntheticPairToken(symbol);
    const effectiveInterval = resolveEffectiveIntervalForSynthetic(
        symbol,
        synthParts?.baseSymbol ?? null,
        synthParts?.quoteSymbol ?? null,
        interval,
    );
    if (synthParts) {
        return loadSyntheticPairForServerBatch(
            synthParts.baseSymbol,
            synthParts.quoteSymbol,
            effectiveInterval,
            signal,
        );
    }

    const fetcher = createServerDataFetcher();
    const data = await fetcher.fetchDataDetached(symbol, effectiveInterval, { signal, offline: true });
    if (signal?.aborted) return [];
    if (data.length === 0 && isIbkrSymbol(symbol)) {
        throw new Error(
            `No IBKR local candles found for ${symbol} ${effectiveInterval}. Batch uses the current chart interval; download that IBKR timeframe first or switch the chart interval to one that exists.`
        );
    }

    // Stale-fragment repair, mirroring the browser loader. The offline path
    // can return a streaming-leftover fragment when the pair was never fully
    // fetched; fall back to a deep offline read at the backtest target, then
    // to the remote gap-fill if SQLite genuinely doesn't have enough bars.
    const staleFragmentThreshold = resolveStaleFragmentBarThreshold(effectiveInterval);
    if (data.length > 0 && data.length < staleFragmentThreshold) {
        debugLogger.warn("batch.server.stale_fragment_refetch", {
            symbol, interval: effectiveInterval, cachedBars: data.length, threshold: staleFragmentThreshold,
        });
        const targetBars = DATA_CHART_TOTAL_LIMIT;
        const offlineDeep = await fetcher.fetchHistoricalData(symbol, effectiveInterval, targetBars, {
            signal,
            offline: true,
        });
        if (signal?.aborted) return [];
        if (offlineDeep.length >= staleFragmentThreshold) {
            return offlineDeep;
        }
        const refetched = await fetcher.fetchHistoricalData(symbol, effectiveInterval, targetBars, { signal });
        if (signal?.aborted) return [];
        return Math.max(refetched.length, offlineDeep.length) === refetched.length
            ? refetched
            : offlineDeep;
    }

    return data;
}

async function loadSyntheticPairForServerBatch(
    baseSymbol: string,
    quoteSymbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    if (signal?.aborted) return [];

    const syntheticSymbol = deriveSyntheticSymbol(baseSymbol, quoteSymbol);
    const diamondLeg = isStockMarketSymbol(baseSymbol) || isStockMarketSymbol(quoteSymbol);
    const available = resolveSyntheticAvailableIntervals(baseSymbol, quoteSymbol);
    const source = diamondLeg ? null : pickSourceInterval(interval, 12, available);
    const sourceInterval = source?.sourceInterval ?? interval;
    const sourceBars = Math.min(SYNTHETIC_TARGET_BARS * (source?.ratio ?? 1), DATA_CHART_TOTAL_LIMIT);
    const pairKey = buildPairCacheKey({
        syntheticSymbol,
        baseSymbol,
        quoteSymbol,
        interval,
        sourceInterval,
        sourceBars,
    });

    const cachedPair = pairCache.get(pairKey);
    if (cachedPair) {
        debugLogger.event("batch.server.synthetic_pair_cache_hit", {
            syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
        });
        return cachedPair;
    }

    const promise = (async (): Promise<OHLCVData[]> => {
        if (signal?.aborted) return [];
        const result = await buildSyntheticPairFromLegs({
            baseSymbol,
            quoteSymbol,
            interval,
            targetBars: SYNTHETIC_TARGET_BARS,
            sourceBarsCap: DATA_CHART_TOTAL_LIMIT,
            fetchLeg: (legSymbol, legInterval, legBars) =>
                getSourceSeriesForServerBatch(legSymbol, legInterval, legBars, signal),
        });
        if (signal?.aborted) return [];
        return result.bars;
    })();

    pairCache.set(pairKey, promise);
    return promise;
}

function getSourceSeriesForServerBatch(
    sourceSymbol: string,
    sourceInterval: string,
    sourceBars: number,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    const legKey = buildLegCacheKey(sourceSymbol, sourceInterval, sourceBars);
    const cached = legCache.get(legKey);
    if (cached) {
        debugLogger.event("batch.server.synthetic_leg_cache_hit", { sourceSymbol, sourceInterval, sourceBars });
        return cached;
    }

    const markedLeg = isMarkedLocalStockSymbol(sourceSymbol);
    const minHealthyLegBars = Math.max(1_000, Math.floor(sourceBars * 0.25));
    const fetcher = createServerDataFetcher();
    const fetchLeg = (offline: boolean): Promise<OHLCVData[]> =>
        fetcher.fetchHistoricalData(sourceSymbol, sourceInterval, sourceBars, {
            signal,
            ...(offline ? { offline: true } : {}),
        });
    const promise = markedLeg
        ? fetchLeg(true)
        : fetchLeg(true).then((data) =>
                data.length >= minHealthyLegBars
                    ? data
                    : (debugLogger.warn("batch.server.synthetic_leg_offline_thin", {
                            sourceSymbol,
                            sourceInterval,
                            returned: data.length,
                            expected: sourceBars,
                        }),
                        fetchLeg(false)),
            );
    legCache.set(legKey, promise);
    return promise;
}

function resolveStaleFragmentBarThreshold(interval: string): number {
    const intervalSeconds = parseIntervalSeconds(interval);
    if (intervalSeconds === null || intervalSeconds <= 0) {
        return STALE_FRAGMENT_MAX_THRESHOLD;
    }
    const oneYearBars = Math.ceil((365 * 24 * 60 * 60) / intervalSeconds);
    return Math.max(
        STALE_FRAGMENT_MIN_THRESHOLD,
        Math.min(STALE_FRAGMENT_MAX_THRESHOLD, oneYearBars),
    );
}

/**
 * Clear the server-side leg/pair LRU. Called by the plugin at run end (and on
 * Mine completion) so a 1000-pair run does not leave ~5 GB of resolved OHLCV
 * arrays pinned on the dev server. Mirrors `clearBatchDatasetCaches` in the
 * browser loader.
 */
export function clearServerBatchDatasetCaches(): void {
    legCache.clear();
    pairCache.clear();
}
