
import { OHLCVData } from "../types/index";
import type { DataProvider } from "../types/data-providers";
import {
    loadCachedCandles,
    loadSeedCandlesFromPriceData,
    mergeCandles,
    saveCachedCandles,
} from "../candle-cache";
import {
    loadSqliteCandles,
    storeSqliteCandles,
} from "../local-sqlite-api";
import {
    DATA_CACHE_SYNC_MIN_MS,
    DATA_CHART_TOTAL_LIMIT,
} from "./constants";
import {
    normalizeIbkrCandles,
    normalizeTradFiDailyCandles,
    takeLastCandles as trimToLastCandles,
} from "./data-interval-utils";
import { debugLogger } from "../debug-logger";
import { parseTimeToUnixSeconds } from "../time-normalization";

export type NonBinanceLocalSource = 'imported' | 'sqlite' | 'cache' | 'seed';
export type NonBinanceLocalCandidate = {
    candles: OHLCVData[];
    source: NonBinanceLocalSource;
    trusted?: boolean;
};

const NON_BINANCE_LOCAL_SOURCE_PRIORITY: Record<NonBinanceLocalSource, number> = {
    imported: 4,
    sqlite: 3,
    cache: 2,
    seed: 1,
};

export function selectBestNonBinanceLocalCandidate(
    candidates: NonBinanceLocalCandidate[],
    provider?: DataProvider
): NonBinanceLocalCandidate | null {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => {
        if (provider === 'ibkr-local' && a.source !== b.source) {
            if (a.source === 'imported') return -1;
            if (b.source === 'imported') return 1;
            if (a.source === 'seed') return -1;
            if (b.source === 'seed') return 1;
        }

        if (a.source !== 'imported' && b.source !== 'imported') {
            const lengthDelta = b.candles.length - a.candles.length;
            if (lengthDelta !== 0) return lengthDelta;
        }

        const priorityDelta = NON_BINANCE_LOCAL_SOURCE_PRIORITY[b.source] - NON_BINANCE_LOCAL_SOURCE_PRIORITY[a.source];
        if (priorityDelta !== 0) return priorityDelta;
        return b.candles.length - a.candles.length;
    });
    return sorted[0] ?? null;
}

export interface PersistenceContext {
    syncAtByKey: Map<string, number>;
    setCachedCandles: (cacheKey: string, candles: OHLCVData[], source: string) => void;
    /**
     * Whether the owning cache still retains this key. Sync-metadata updates
     * are gated on it after the async write settles, so a key evicted while a
     * write was pending (or an oversized snapshot the cache refused to admit)
     * does not regain an orphan sync timestamp.
     */
    hasCachedCandles?: (cacheKey: string) => boolean;
}

/** Capture an independent delta; only normalized, sorted stream callers opt in. */
export function selectStreamPersistenceDelta(
    candles: readonly OHLCVData[], cursor: number | undefined, sorted = false,
): OHLCVData[] {
    const start = Math.max(0, candles.length - DATA_CHART_TOTAL_LIMIT);
    if (cursor === undefined) return candles.slice(Math.max(start, candles.length - 2));
    if (sorted) {
        let first = candles.length;
        let newerTime = Infinity;
        let validTail = true;
        for (let i = candles.length - 1; i >= start; i--) {
            const time = parseTimeToUnixSeconds(candles[i]!.time);
            if (time === null || time > newerTime) {
                validTail = false;
                break;
            }
            if (time < cursor) break;
            first = i;
            newerTime = time;
        }
        if (validTail) return candles.slice(first);
    }
    // Preserve the full-filter behavior for callers without a sorted contract.
    return candles.slice(start).filter(c => {
        const time = parseTimeToUnixSeconds(c.time);
        return time !== null && time >= cursor;
    });
}

export class DataPersistence {
    private cachePersistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private cachePersistPendingByKey: Map<string, { symbol: string; storageInterval: string; candles: OHLCVData[]; sorted: boolean }> = new Map();
    // Last bar time (unix seconds) successfully persisted to SQLite per cacheKey.
    // Tracked so burst updates on fast intervals don't drop intermediate candles.
    private lastStreamPersistedTimeByKey: Map<string, number> = new Map();
    private lastSnapshotPersistedAtByKey: Map<string, number> = new Map();
    private readonly STREAM_PERSIST_DELAY_MS = 1200;

    normalizeExternalCandles(candles: OHLCVData[], trusted = false): OHLCVData[] {
        return mergeCandles([], candles, trusted);
    }

    private normalizeProviderCandles(
        candles: OHLCVData[],
        interval: string,
        provider: DataProvider,
        trusted = false
    ): OHLCVData[] {
        const normalized = this.normalizeExternalCandles(candles, trusted);
        if (provider === 'ibkr-local') return normalizeIbkrCandles(normalized, interval);
        return provider === 'bybit-tradfi'
            ? normalizeTradFiDailyCandles(normalized, interval)
            : normalized;
    }

    async loadNonBinanceLocalData(deps: {
        symbol: string;
        interval: string;
        provider: DataProvider;
        maxBars: number;
        storageInterval: string;
        storageSymbol: string;
        cacheKey: string;
        importedCandles: OHLCVData[] | undefined;
        signal?: AbortSignal;
        ctx: PersistenceContext;
    }): Promise<{ candles: OHLCVData[]; source: NonBinanceLocalSource } | null> {
        const {
            symbol,
            interval,
            provider,
            maxBars,
            storageInterval,
            storageSymbol,
            cacheKey,
            importedCandles,
            signal,
            ctx,
        } = deps;

        const normalizedLimit = Math.max(1, Math.min(DATA_CHART_TOTAL_LIMIT, Math.floor(maxBars)));
        const candidates: NonBinanceLocalCandidate[] = [];
        const normalizeCandidate = (candidate: NonBinanceLocalCandidate) => ({
            ...candidate,
            candles: trimToLastCandles(
                this.normalizeProviderCandles(candidate.candles, interval, provider, candidate.trusted === true),
                normalizedLimit
            ),
        });
        const useCandidate = (candidate: NonBinanceLocalCandidate) => {
            ctx.setCachedCandles(cacheKey, candidate.candles, candidate.source);
            return candidate;
        };

        if (signal?.aborted) return null;
        // IBKR's explicit import/seed precedence makes fallback reads unnecessary
        // when either authoritative source is available. Bybit still compares all sources.
        if (provider === 'ibkr-local') {
            if (importedCandles?.length) {
                const imported = normalizeCandidate({ candles: importedCandles, source: 'imported' });
                if (imported.candles.length) return useCandidate(imported);
            }
            const seed = await loadSeedCandlesFromPriceData(symbol, interval, signal, provider).catch(() => null);
            if (signal?.aborted) return null;
            if (seed?.length) {
                const normalizedSeed = normalizeCandidate({ candles: seed, source: 'seed' });
                if (normalizedSeed.candles.length) return useCandidate(normalizedSeed);
            }
        }

        if (provider !== 'ibkr-local' && importedCandles && importedCandles.length > 0) {
            candidates.push({
                candles: importedCandles,
                source: 'imported',
            });
        }

        const [sqliteResult, cachedResult, seedResult] = await Promise.allSettled([
            loadSqliteCandles(storageSymbol, storageInterval, normalizedLimit),
            loadCachedCandles(storageSymbol, storageInterval),
            provider === 'ibkr-local' ? Promise.resolve(null) : loadSeedCandlesFromPriceData(symbol, interval, signal, provider),
        ]);
        if (signal?.aborted) return null;

        if (sqliteResult.status === 'fulfilled' && sqliteResult.value && sqliteResult.value.candles.length > 0) {
            candidates.push({
                candles: sqliteResult.value.candles,
                source: 'sqlite',
                trusted: sqliteResult.value.trusted,
            });
        }

        if (cachedResult.status === 'fulfilled' && cachedResult.value && cachedResult.value.candles.length > 0) {
            candidates.push({
                candles: cachedResult.value.candles,
                source: 'cache',
                trusted: cachedResult.value.trusted,
            });
        }

        if (seedResult.status === 'fulfilled' && seedResult.value && seedResult.value.length > 0) {
            candidates.push({
                candles: seedResult.value,
                source: 'seed',
            });
        }

        if (candidates.length === 0) {
            return null;
        }

        const best = selectBestNonBinanceLocalCandidate(candidates, provider);
        if (!best) return null;

        return useCandidate(normalizeCandidate(best));
    }

    async persistNonBinanceData(deps: {
        symbol: string;
        interval: string;
        provider: DataProvider;
        candles: OHLCVData[];
        source: string;
        storageInterval: string;
        storageSymbol: string;
        providerLabel: string;
        cacheKey: string;
        ctx: PersistenceContext;
    }): Promise<void> {
        const {
            storageInterval,
            providerLabel,
            provider,
            source,
            candles,
            storageSymbol,
            cacheKey,
            ctx,
        } = deps;

        if (candles.length === 0) return;
        const normalized = this.normalizeProviderCandles(candles, storageInterval, provider, true);
        await this.persistLocalCandles({
            symbol: storageSymbol,
            storageInterval,
            cacheCandles: normalized,
            sqliteCandles: normalized,
            providerLabel,
            sourceTrait: source,
            cacheKey,
            trusted: true,
            ctx,
        });
    }

    async persistLocalCandles(args: {
        symbol: string;
        storageInterval: string;
        cacheCandles?: OHLCVData[];
        sqliteCandles?: OHLCVData[];
        trusted?: boolean;
        providerLabel: string;
        sourceTrait: string;
        cacheKey?: string;
        updateSyncTime?: boolean;
        ctx: PersistenceContext;
    }): Promise<void> {
        const {
            symbol,
            storageInterval,
            cacheCandles,
            sqliteCandles,
            trusted = false,
            providerLabel,
            sourceTrait,
            cacheKey,
            updateSyncTime = false,
            ctx,
        } = args;

        if (cacheCandles && cacheCandles.length > 0) {
            const saved = await saveCachedCandles(symbol, storageInterval, cacheCandles, sourceTrait, trusted);
            if (saved && cacheKey) {
                this.lastSnapshotPersistedAtByKey.set(cacheKey, Date.now());
            }
        }

        if (sqliteCandles && sqliteCandles.length > 0) {
            await storeSqliteCandles(
                symbol,
                storageInterval,
                sqliteCandles,
                providerLabel,
                sourceTrait
            );
        }

        if (updateSyncTime && cacheKey) {
            if (cacheCandles) {
                ctx.setCachedCandles(cacheKey, cacheCandles, sourceTrait);
            }
            // Sync metadata must respect retention at settlement time, not at
            // call time: a key evicted while this write was pending gains no
            // orphan sync timestamp, and an oversized snapshot the cache
            // refused to admit does not either. The cache is never re-admitted
            // merely to keep a timestamp.
            if (ctx.hasCachedCandles?.(cacheKey) !== false) {
                ctx.syncAtByKey.set(cacheKey, Date.now());
            }
        }
    }

    queuePersistCandles(deps: {
        symbol: string;
        interval: string;
        candles: OHLCVData[];
        resolvedProvider: DataProvider;
        storageSymbol: string;
        storageInterval: string;
        cacheKey: string;
        providerLabel: string;
        ctx: PersistenceContext;
        sorted?: boolean;
    }): void {
        const {
            symbol,
            interval,
            candles,
            storageSymbol,
            storageInterval,
            cacheKey,
            providerLabel,
            ctx,
        } = deps;

        if (!symbol || !interval || candles.length === 0) return;
        this.cachePersistPendingByKey.set(cacheKey, {
            symbol: storageSymbol,
            storageInterval,
            candles,
            sorted: deps.sorted === true,
        });

        const existingTimer = this.cachePersistTimers.get(cacheKey);
        if (existingTimer) return;

        const persistence = this;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const pending = persistence.cachePersistPendingByKey.get(cacheKey);
                    persistence.cachePersistPendingByKey.delete(cacheKey);
                    if (!pending || pending.candles.length === 0) return;

                    // Replay the cursor candle because live OHLCV changes at the same
                    // timestamp. On the first flush, persist the latest two candles.
                    const lastPersistedTime = persistence.lastStreamPersistedTimeByKey.get(cacheKey);
                    const delta = selectStreamPersistenceDelta(pending.candles, lastPersistedTime, pending.sorted);
                    // Capture the cursor and due snapshot before awaiting a write:
                    // the live array may append or replace bars during that await.
                    const lastTime = parseTimeToUnixSeconds(pending.candles[pending.candles.length - 1]?.time);
                    const lastSnapshot = persistence.lastSnapshotPersistedAtByKey.get(cacheKey);
                    const snapshotDue = lastSnapshot === undefined || Date.now() - lastSnapshot >= DATA_CACHE_SYNC_MIN_MS;
                    let snapshot = snapshotDue ? pending.candles.slice(-DATA_CHART_TOTAL_LIMIT) : undefined;
                    const sqliteResult = await storeSqliteCandles(
                        pending.symbol,
                        pending.storageInterval,
                        delta,
                        providerLabel,
                        'stream'
                    );
                    const sqliteSucceeded = sqliteResult?.ok === true;
                    if (sqliteSucceeded && lastTime !== null) {
                        persistence.lastStreamPersistedTimeByKey.set(
                            cacheKey,
                            lastTime
                        );
                    }
                    if (sqliteResult && !sqliteSucceeded) {
                        debugLogger.warn('data.persist.sqlite_failed', { cacheKey, error: sqliteResult.error ?? 'Write rejected' });
                    }
                    // Recheck the snapshot clock after a slow write. A deferred
                    // snapshot can use the latest view without advancing SQLite's
                    // cursor beyond the delta that was actually acknowledged.
                    const snapshotNowDue = lastSnapshot === undefined || Date.now() - lastSnapshot >= DATA_CACHE_SYNC_MIN_MS;
                    if (!snapshot && (!sqliteSucceeded || snapshotNowDue)) snapshot = pending.candles.slice(-DATA_CHART_TOTAL_LIMIT);
                    await persistence.persistLocalCandles({
                        symbol: pending.symbol,
                        storageInterval: pending.storageInterval,
                        cacheCandles: snapshot,
                        trusted: true,
                        providerLabel,
                        sourceTrait: 'stream',
                        cacheKey,
                        updateSyncTime: true,
                        ctx,
                    });
                } catch (error) {
                    // Stream persistence runs as a fire-and-forget timer on every
                    // streamed bar; without this guard a transient SQLite/IDB
                    // failure becomes an unhandled rejection (and a silent gap in
                    // the local candle cache). Surface it so operators can see it.
                    debugLogger.warn('data.persist.stream_failed', { cacheKey, error: String(error) });
                } finally {
                    // Keep the timer registered while writes run so flushes for one
                    // series cannot race their cursor or overwrite a newer snapshot.
                    persistence.cachePersistTimers.delete(cacheKey);
                    const pending = persistence.cachePersistPendingByKey.get(cacheKey);
                    if (pending) persistence.queuePersistCandles({ ...deps, candles: pending.candles, sorted: pending.sorted });
                }
            })();
        }, this.STREAM_PERSIST_DELAY_MS);
        this.cachePersistTimers.set(cacheKey, timer);
    }
}
