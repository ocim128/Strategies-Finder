import { expect } from "chai";
import { describe, it } from "node:test";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import {
    alignLegCloses,
    createBatchDatasetLoadDiagnostics,
    createBatchDatasetLoaderCore,
} from "../lib/batch-backtest/batch-dataset-loader-core";
import type { BatchDatasetLoadResult } from "../lib/batch-backtest/batch-dataset-loader-core";
import { SyntheticLegCache } from "../lib/batch-backtest/synthetic-leg-cache";
import {
    fetchServerHistoricalData,
    loadServerBatchDataset,
} from "../lib/batch-backtest/server-batch-data-loader";
import {
    fetchServerDetachedDataWithFetcher,
    fetchServerHistoricalDataWithFetcher,
} from "../lib/data/server-data-fetcher-factory";
import type { DataFetcher } from "../lib/data/data-fetcher";
import { withLocalIbkrFixture } from "./helpers/local-ibkr-fixture";
import { withLocalCryptoFixture, writeCryptoCsv } from "./helpers/local-crypto-fixture";
import type { OHLCVData, Time } from "../lib/types/strategies";

const APP_ROOT = process.cwd();
const BROWSER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "batch-backtest-loader.ts");
const SERVER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-data-loader.ts");
const SHARED_CORE = path.join(APP_ROOT, "lib", "batch-backtest", "batch-dataset-loader-core.ts");
const STREAM_TYPES = path.join(APP_ROOT, "lib", "batch-backtest", "batch-backtest-stream-types.ts");
const ROW_SCALARS = path.join(APP_ROOT, "lib", "batch-backtest", "batch-row-scalars.ts");
const SERVER_IBKR_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-ibkr-csv-loader.ts");
const SERVER_CACHE_BUDGET = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-cache-budget.ts");

function readSource(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`loader file missing: ${filePath}`);
    }
    return readFileSync(filePath, "utf8");
}

describe("batch-backtest server loader parity", () => {
    it("aligns sorted leg closes without changing missing or duplicate-time semantics", () => {
        const pairBars: OHLCVData[] = [0, 30, 60, 120, 180].map((time) => ({
            time: time as Time,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
        }));
        const legBars: OHLCVData[] = [
            { time: 0 as Time, open: 1, high: 1, low: 1, close: 10, volume: 1 },
            { time: 0 as Time, open: 1, high: 1, low: 1, close: 11, volume: 1 },
            { time: 60 as Time, open: 1, high: 1, low: 1, close: 20, volume: 1 },
            { time: 120 as Time, open: 1, high: 1, low: 1, close: 30, volume: 1 },
        ];

        expect(alignLegCloses(pairBars, legBars, "1m")).to.deep.equal([11, null, 20, 30, null]);
    });

    it("derives standalone 1h/2h IBKR miner targets from 30m candles", async () => {
        const source: OHLCVData[] = [0, 1800, 3600, 5400].map((time) => ({
            time: time as Time,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
        }));
        const historicalIntervals: string[] = [];
        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => {
                throw new Error("target-interval fetch should not run when 30m IBKR seeds exist");
            },
            fetchHistorical: async (_symbol, interval) => {
                historicalIntervals.push(interval);
                return source;
            },
        });

        const oneHour = await loader.load("AAPL\u2022", "1h");
        const twoHour = await loader.load("AAPL\u2022", "2h");

        expect(historicalIntervals).to.deep.equal(["30m", "30m"]);
        expect(oneHour).to.have.length(2);
        expect(twoHour).to.have.length(1);
    });

    it("shares a bounded run leg cache across concurrent synthetic pairs", async () => {
        const source: OHLCVData[] = [0, 1800, 3600, 5400].map((time) => ({
            time: time as Time,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
        }));
        const fetches = new Map<string, number>();
        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async (symbol, interval) => {
                const key = `${symbol}|${interval}`;
                fetches.set(key, (fetches.get(key) ?? 0) + 1);
                return source;
            },
        });
        const context = {
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };

        await Promise.all([
            loader.load("BASE\u2022+QUOTE\u2022", "4h", undefined, context),
            loader.load("BASE\u2022+THIRD\u2022", "4h", undefined, context),
        ]);

        expect(fetches).to.deep.equal(new Map([
            ["BASE\u2022|30m", 1],
            ["QUOTE\u2022|30m", 1],
            ["THIRD\u2022|30m", 1],
        ]));
        expect(context.diagnostics.syntheticPairRequests).to.equal(2);
        expect(context.diagnostics.pairBuilds).to.equal(2);
        expect(context.diagnostics.legCacheMisses).to.equal(3);
        expect(context.diagnostics.legCacheHits).to.equal(1);
    });

    it("accepts a valid authoritative offline leg below the generic deep-history threshold", async () => {
        const source: OHLCVData[] = [0, 1800, 3600, 5400].map((time) => ({
            time: time as Time,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
        }));
        const calls: Array<{ symbol: string; offline: boolean }> = [];
        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async (symbol, _interval, _limit, options) => {
                calls.push({ symbol, offline: options?.offline === true });
                return source;
            },
            acceptOfflineThinData: () => true,
        });

        const data = await loader.load("BASE+QUOTE", "4h");

        expect(data).to.have.length(1);
        expect(calls).to.deep.equal([
            { symbol: "BASEUSDT", offline: true },
            { symbol: "QUOTEUSDT", offline: true },
        ]);
    });

    it("shares pair bars and aligned metadata across repeated batch iterations", async () => {
        const source: OHLCVData[] = [0, 1800, 3600, 5400].map((time) => ({
            time: time as Time,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
        }));
        let fetches = 0;
        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => {
                fetches += 1;
                return source;
            },
        });
        const pairCache = new SyntheticLegCache<OHLCVData[]>(8);
        const pairMetadataCache = new SyntheticLegCache<
            Pick<BatchDatasetLoadResult, "baseCloses" | "quoteCloses">
        >(8);
        const firstContext = {
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            pairCache,
            pairMetadataCache,
            preferInMemorySyntheticPairs: true,
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        await loader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, firstContext);

        const secondContext = {
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            pairCache,
            pairMetadataCache,
            preferInMemorySyntheticPairs: true,
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        await loader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, secondContext);

        expect(firstContext.diagnostics.pairBuilds).to.equal(1);
        expect(secondContext.diagnostics.pairCacheHits).to.equal(1);
        expect(secondContext.diagnostics.pairBuilds).to.equal(0);
        expect(fetches).to.equal(2);
    });

    it("measures resolved disk-cache hits and can bypass them for a scoped run", async () => {
        const source: OHLCVData[] = [0, 1800, 3600, 5400].map((time) => ({
            time: time as Time,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
        }));
        let fingerprintCalls = 0;
        let diskReads = 0;
        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => source,
            computeSyntheticPairFingerprint: async () => {
                fingerprintCalls += 1;
                return "test-fingerprint";
            },
            loadCachedSyntheticPair: async () => {
                diskReads += 1;
                await new Promise((resolve) => setTimeout(resolve, 5));
                return { bars: source };
            },
        });
        const diskContext = { diagnostics: createBatchDatasetLoadDiagnostics() };

        await loader.load("BASE\u2022+QUOTE\u2022", "4h", undefined, diskContext);

        expect(fingerprintCalls).to.equal(1);
        expect(diskReads).to.equal(1);
        expect(diskContext.diagnostics.diskCacheHits).to.equal(1);
        expect(diskContext.diagnostics.timingsMs.diskLookup).to.be.greaterThan(0);
        expect(diskContext.diagnostics.timingsMs.total).to.be.greaterThan(0);

        const bypassContext = {
            preferInMemorySyntheticPairs: true,
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        await loader.load("BASE\u2022+THIRD\u2022", "4h", undefined, bypassContext);

        expect(fingerprintCalls).to.equal(1);
        expect(diskReads).to.equal(1);
        expect(bypassContext.diagnostics.diskCacheBypasses).to.equal(1);
        expect(bypassContext.diagnostics.pairBuilds).to.equal(1);
        expect(bypassContext.diagnostics.sourceLoads).to.equal(2);
    });

    it("keeps browser and server loaders as wrappers around the shared core", () => {
        expect(existsSync(BROWSER_LOADER)).to.equal(true);
        expect(existsSync(SERVER_LOADER)).to.equal(true);
        expect(existsSync(SHARED_CORE)).to.equal(true);

        expect(readSource(BROWSER_LOADER)).to.include("createBatchDatasetLoaderCore");
        expect(readSource(SERVER_LOADER)).to.include("createBatchDatasetLoaderCore");
    });


    it("aligns subdivided cached-pair legs on the target interval like fresh builds", async () => {
        // Eight rising 30m candles per 4H bucket: the bucket's LAST close is
        // 108/116 and its opening 30m close is 101/109. Fresh builds resample
        // the leg to 4H, so aligned closes must carry the last-in-bucket price;
        // the disk-cache metadata path used to align on the source interval and
        // pick the bucket-open price instead.
        const times: number[] = [];
        for (let bucket = 0; bucket < 2; bucket += 1) {
            for (let i = 0; i < 8; i += 1) times.push(bucket * 8 * 1800 + i * 1800);
        }
        const source: OHLCVData[] = times.map((time, i) => ({
            time: time as Time,
            open: 100 + i,
            high: 100.5 + i,
            low: 99.5 + i,
            close: 101 + i,
            volume: 10,
        }));

        const coldLoader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => source,
            acceptOfflineThinData: () => true,
        });
        const coldContext = {
            preferInMemorySyntheticPairs: true,
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            pairCache: new SyntheticLegCache<OHLCVData[]>(8),
            pairMetadataCache: new SyntheticLegCache<
                Pick<BatchDatasetLoadResult, "baseCloses" | "quoteCloses">
            >(8),
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        const cold = await coldLoader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, coldContext);
        expect(coldContext.diagnostics.sourceLoads).to.equal(2);
        expect(cold.data.map((bar) => bar.time)).to.deep.equal([0, 14400]);
        expect(cold.baseCloses).to.deep.equal([108, 116]);
        expect(cold.quoteCloses).to.deep.equal([108, 116]);

        const cachedLoader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => source,
            loadCachedSyntheticPair: async () => ({ bars: cold.data }),
        });
        const cachedContext = { diagnostics: createBatchDatasetLoadDiagnostics() };
        const cached = await cachedLoader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, cachedContext);
        expect(cachedContext.diagnostics.diskCacheHits).to.equal(1);
        expect(cached.baseCloses).to.deep.equal(cold.baseCloses);
        expect(cached.quoteCloses).to.deep.equal(cold.quoteCloses);
    });

    it("keeps null alignment when a cached pair outlives its legs", async () => {
        // A cached pair bar with no matching resampled leg bar aligns to null
        // (the ledger must use null, never a proxy). Only the disk-cache path
        // can see this: a cold pair is built FROM its legs, so its bars always
        // have matching buckets.
        const times: number[] = [];
        for (let bucket = 0; bucket < 2; bucket += 1) {
            for (let i = 0; i < 8; i += 1) times.push(bucket * 8 * 1800 + i * 1800);
        }
        const source: OHLCVData[] = times.map((time, i) => ({
            time: time as Time,
            open: 100 + i,
            high: 100.5 + i,
            low: 99.5 + i,
            close: 101 + i,
            volume: 10,
        }));
        // Cached pair has a third bucket the truncated leg data cannot cover.
        const cachedBars: OHLCVData[] = [
            ...source.slice(0, 8).map((bar, i) => ({
                time: (i === 0 ? 0 : 14400) as Time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
            })),
            { time: 28800 as Time, open: 117, high: 117, low: 116, close: 117, volume: 10 },
        ];
        cachedBars[7]!.time = 0 as Time;
        cachedBars.splice(1, 7);

        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => source.slice(0, 8),
            acceptOfflineThinData: () => true,
            loadCachedSyntheticPair: async () => ({ bars: cachedBars }),
        });
        const context = { diagnostics: createBatchDatasetLoadDiagnostics() };
        const result = await loader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, context);
        expect(result.data).to.have.length(2);
        expect(result.baseCloses).to.deep.equal([108, null]);
    });

    it("builds one shared aligned series per leg across many pairs", async () => {
        const times: number[] = [];
        for (let bucket = 0; bucket < 2; bucket += 1) {
            for (let i = 0; i < 8; i += 1) times.push(bucket * 8 * 1800 + i * 1800);
        }
        const source: OHLCVData[] = times.map((time, i) => ({
            time: time as Time,
            open: 100 + i,
            high: 100.5 + i,
            low: 99.5 + i,
            close: 101 + i,
            volume: 10,
        }));

        const loader = createBatchDatasetLoaderCore({
            logPrefix: "batch.test",
            fetchDetached: async () => [],
            fetchHistorical: async () => source,
            acceptOfflineThinData: () => true,
        });

        // One metadata cache per partner pair, but a SHARED context leg cache
        // like the production Asset Opportunity batch path uses: BASE and QUOTE
        // each resample once, then every partner alignment reuses the series.
        const first = {
            legCache: new SyntheticLegCache<OHLCVData[]>(8),
            pairMetadataCache: new SyntheticLegCache<
                Pick<BatchDatasetLoadResult, "baseCloses" | "quoteCloses">
            >(8),
            preferInMemorySyntheticPairs: true,
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        const second = {
            legCache: first.legCache,
            pairMetadataCache: new SyntheticLegCache<
                Pick<BatchDatasetLoadResult, "baseCloses" | "quoteCloses">
            >(8),
            preferInMemorySyntheticPairs: true,
            diagnostics: createBatchDatasetLoadDiagnostics(),
        };
        await loader.loadWithMetadata("BASE\u2022+QUOTE\u2022", "4h", undefined, first);
        await loader.loadWithMetadata("BASE\u2022+THIRD\u2022", "4h", undefined, second);

        const builtSeries = (first.diagnostics.alignedSeriesMisses ?? 0)
            + (second.diagnostics.alignedSeriesMisses ?? 0);
        const reusedSeries = (first.diagnostics.alignedSeriesHits ?? 0)
            + (second.diagnostics.alignedSeriesHits ?? 0);
        // Three distinct legs across the two pairs (BASE, QUOTE, THIRD) build
        // one series each; BASE is shared, so the second pair's BASE alignment
        // reuses it instead of resampling a fourth time.
        expect(builtSeries).to.equal(3);
        expect(reusedSeries).to.equal(1);
    });

    it("keeps synced crypto CSVs authoritative for thin offline legs", () => {
        const server = readSource(SERVER_LOADER);
        expect(server).to.include("getCryptoCsvMtimeMs");
        expect(server).to.include("acceptOfflineThinData");
    });

    it("lets browser IBKR batches bypass redundant cache reads", () => {
        const browser = readSource(BROWSER_LOADER);
        expect(browser).to.include("isIbkrSymbol");
        expect(browser).to.include("loadSeedCandlesFromPriceData");
        expect(browser).to.include('"ibkr-local"');
        // The browser wrapper should use the same authoritative-seed boundary
        // as the server wrapper before falling back to DataManager history.
        expect(browser).to.include("return dataManager.fetchHistoricalData");
    });

    it("keeps synthetic-pair and cache behavior in the shared core", () => {
        const core = readSource(SHARED_CORE);
        for (const symbol of [
            "buildSyntheticPairFromLegs",
            "deriveSyntheticSymbol",
            "pickSourceInterval",
            "resolveSyntheticAvailableIntervals",
            "SyntheticLegCache",
            "buildLegCacheKey",
            "buildPairCacheKey",
            "SYNTHETIC_TARGET_BARS",
            "DATA_CHART_TOTAL_LIMIT",
        ]) {
            expect(core, `shared core must use ${symbol}`).to.include(symbol);
        }
        expect(core).to.include("STALE_FRAGMENT_MAX_THRESHOLD = 10_000");
        expect(core).to.include("STALE_FRAGMENT_MIN_THRESHOLD = 200");
        expect(core).to.include("options.legCacheMaxEntries ?? 24");
        expect(core).to.include("options.pairCacheMaxEntries ?? 16");
        expect(core).to.include("preferInMemorySyntheticPairs");
    });

    it("server loader bypasses browser-bound modules", () => {
        const server = readSource(SERVER_LOADER);
        const core = readSource(SHARED_CORE);
        expect(server.includes('from "../data-manager"')).to.equal(false);
        expect(server.includes('from "../finder-manager"')).to.equal(false);
        expect(core.includes('from "../finder-manager"')).to.equal(false);
        expect(core.includes('from "../synthetic-pair-token"')).to.equal(true);
        // The DataFetcher setup lives in the shared leaf factory
        // (server-data-fetcher-factory.ts), imported by both server loaders.
        expect(server.includes('from "../data/server-data-fetcher-factory"')).to.equal(true);
        expect(server.includes('from "../data/data-fetcher"')).to.equal(false);
    });

    it("clears the shared server data cache while parsed CSV caches self-invalidate by mtime", () => {
        const server = readSource(SERVER_LOADER);
        expect(server).to.include("clearServerBatchDatasetCaches");
        // The shared data cache is cleared through the factory helper.
        expect(server).to.include("clearServerDataCache()");
        expect(server).to.not.include("clearLocalDailyCsvCachesForSymbols()");
        expect(server).to.not.include("clearParsedIbkrCsvCache()");
        expect(server).to.not.include("clearParsedCryptoCsvCache()");
        // The IBKR/crypto disk routing lives in the shared factory policy, which
        // the loader delegates to instead of carrying its own copy.
        expect(server).to.include("fetchServerHistoricalDataWithFetcher");
        expect(server).to.include("fetchServerDetachedDataWithFetcher");
        expect(readSource(SERVER_IBKR_LOADER)).to.include('from "node:fs/promises"');
        expect(readSource(SERVER_CACHE_BUDGET)).to.include("HIGH_MEMORY_THRESHOLD_BYTES");
        // The factory helper owns the actual dataCache.clear() call and both
        // server loaders' disk-first data-source routing.
        const factory = readSource(path.join(APP_ROOT, "lib", "data", "server-data-fetcher-factory.ts"));
        expect(factory).to.include("dataCache.clear()");
        expect(factory).to.include("loadFreshIbkrCandlesFromDisk");
        expect(factory).to.include("loadFreshCryptoCandlesFromDisk");
    });

    it("keeps server wire-row scalars out of the full copy-summary formatter", () => {
        const streamTypes = readSource(STREAM_TYPES);
        const rowScalars = readSource(ROW_SCALARS);
        expect(streamTypes.includes("./batch-backtest-summary")).to.equal(false);
        expect(streamTypes.includes("./batch-row-scalars")).to.equal(true);
        expect(rowScalars.includes("finder-universe-metrics")).to.equal(false);
    });
});

/**
 * Behavioral parity for the disk-first routing both server loaders share. This
 * block mirrors the same cases in `tests/finder-server-loader-parity.spec.ts`:
 * source-text assertions above prove delegation, these prove the routing
 * contract itself (IBKR historical vs detached misses, crypto precedence,
 * aborts, empty tails, tail limits, and mtime invalidation) with the calling
 * loader's DataFetcher replaced by scoped stubs.
 */
describe("shared server data-source routing", () => {
    const fallbackBars: OHLCVData[] = [{ time: 1 as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 }];

    function makeBars(count: number, dayOffset: number): OHLCVData[] {
        return Array.from({ length: count }, (_, index) => ({
            time: (1_700_000_000 + (dayOffset * 1_000 + index) * 1_800) as Time,
            open: 100 + index,
            high: 102 + index,
            low: 99 + index,
            close: 101 + index,
            volume: 1_000,
        }));
    }

    type RecordedCall = {
        method: "historical" | "detached";
        symbol: string;
        interval: string;
        limit?: number;
        signal?: AbortSignal;
        offline?: boolean;
    };

    function recordingDataFetcher(returned: OHLCVData[]): { fetcher: DataFetcher; calls: RecordedCall[] } {
        const calls: RecordedCall[] = [];
        const fetcher = {
            fetchHistoricalData: async (
                symbol: string,
                interval: string,
                limit: number,
                options?: { signal?: AbortSignal; offline?: boolean },
            ) => {
                calls.push({
                    method: "historical",
                    symbol,
                    interval,
                    limit,
                    signal: options?.signal,
                    offline: options?.offline,
                });
                return returned;
            },
            fetchDataDetached: async (
                symbol: string,
                interval: string,
                options?: { signal?: AbortSignal; offline?: boolean },
            ) => {
                calls.push({
                    method: "detached",
                    symbol,
                    interval,
                    signal: options?.signal,
                    offline: options?.offline,
                });
                return returned;
            },
        } as unknown as DataFetcher;
        return { fetcher, calls };
    }

    it("historical IBKR: a local hit serves CSV candles with the tail limit; a null read returns [] without the fetcher", async () => {
        const bars = makeBars(6, 0);
        await withLocalIbkrFixture("30m", { AAPL: bars }, async () => {
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const hit = await fetchServerHistoricalDataWithFetcher(fetcher, "AAPL\u2022", "30m", 4);
            expect(hit.map((bar) => Number(bar.time))).to.deep.equal(bars.slice(-4).map((bar) => Number(bar.time)));
            const miss = await fetchServerHistoricalDataWithFetcher(fetcher, "MISSING\u2022", "30m", 4);
            expect(miss).to.deep.equal([]);
            expect(calls).to.deep.equal([]);
        });
    });

    it("detached IBKR: a local hit serves CSV candles; a null read continues to the fallback fetcher", async () => {
        const bars = makeBars(3, 1);
        await withLocalIbkrFixture("30m", { AAPL: bars }, async () => {
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const hit = await fetchServerDetachedDataWithFetcher(fetcher, "AAPL\u2022", "30m");
            expect(hit.map((bar) => Number(bar.time))).to.deep.equal(bars.map((bar) => Number(bar.time)));
            expect(calls).to.deep.equal([]);
            const miss = await fetchServerDetachedDataWithFetcher(fetcher, "MISSING\u2022", "30m");
            expect(miss).to.equal(fallbackBars);
            expect(calls).to.deep.equal([
                { method: "detached", symbol: "MISSING\u2022", interval: "30m", signal: undefined, offline: undefined },
            ]);
        });
    });

    it("offline crypto: a synced CSV wins before the fetcher; a miss falls back with the same options", async () => {
        const bars = makeBars(5, 2);
        await withLocalCryptoFixture("30m", { BTCUSDT: bars }, async () => {
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const hit = await fetchServerHistoricalDataWithFetcher(fetcher, "BTCUSDT", "30m", 2, { offline: true });
            expect(hit.map((bar) => Number(bar.time))).to.deep.equal(bars.slice(-2).map((bar) => Number(bar.time)));
            const miss = await fetchServerHistoricalDataWithFetcher(fetcher, "ETHUSDT", "30m", 4, { offline: true });
            expect(miss).to.equal(fallbackBars);
            expect(calls).to.deep.equal([
                {
                    method: "historical",
                    symbol: "ETHUSDT",
                    interval: "30m",
                    limit: 4,
                    signal: undefined,
                    offline: true,
                },
            ]);
        });
    });

    it("online non-IBKR: the retained DataFetcher serves the request even when a synced CSV exists", async () => {
        const bars = makeBars(5, 3);
        await withLocalCryptoFixture("30m", { BTCUSDT: bars }, async () => {
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const result = await fetchServerHistoricalDataWithFetcher(fetcher, "BTCUSDT", "30m", 7);
            expect(result).to.equal(fallbackBars);
            expect(calls).to.deep.equal([
                {
                    method: "historical",
                    symbol: "BTCUSDT",
                    interval: "30m",
                    limit: 7,
                    signal: undefined,
                    offline: undefined,
                },
            ]);
        });
    });

    it("offline crypto: a non-null empty tail (limit 0) is still a local hit", async () => {
        const bars = makeBars(3, 4);
        await withLocalCryptoFixture("30m", { BTCUSDT: bars }, async () => {
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const empty = await fetchServerHistoricalDataWithFetcher(fetcher, "BTCUSDT", "30m", 0, { offline: true });
            expect(empty).to.deep.equal([]);
            expect(calls).to.deep.equal([]);
        });
    });

    it("abort forwarding: a pre-aborted signal short-circuits IBKR historical reads and reaches detached fallbacks", async () => {
        const bars = makeBars(4, 5);
        await withLocalIbkrFixture("30m", { AAPL: bars }, async () => {
            const controller = new AbortController();
            controller.abort();
            const { fetcher, calls } = recordingDataFetcher(fallbackBars);
            const historical = await fetchServerHistoricalDataWithFetcher(
                fetcher,
                "AAPL\u2022",
                "30m",
                2,
                { signal: controller.signal },
            );
            expect(historical).to.deep.equal([]);
            const detached = await fetchServerDetachedDataWithFetcher(
                fetcher,
                "AAPL\u2022",
                "30m",
                { signal: controller.signal },
            );
            expect(detached).to.equal(fallbackBars);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]!.method).to.equal("detached");
            expect(calls[0]!.signal?.aborted).to.equal(true);
        });
    });

    it("rewrites a synced crypto CSV between reads without clearing caches (mtime invalidation)", async () => {
        const first = makeBars(3, 6);
        const second = makeBars(5, 6);
        await withLocalCryptoFixture("30m", { BTCUSDT: first }, async ({ csvDir }) => {
            const { fetcher } = recordingDataFetcher(fallbackBars);
            const before = await fetchServerHistoricalDataWithFetcher(fetcher, "BTCUSDT", "30m", 2, { offline: true });
            expect(before.map((bar) => Number(bar.time))).to.deep.equal(first.slice(-2).map((bar) => Number(bar.time)));
            writeCryptoCsv(csvDir, "BTCUSDT", second);
            const forcedMtime = (Date.now() + 60_000) / 1000;
            utimesSync(path.join(csvDir, "BTCUSDT.csv"), forcedMtime, forcedMtime);
            const after = await fetchServerHistoricalDataWithFetcher(fetcher, "BTCUSDT", "30m", 2, { offline: true });
            expect(after.map((bar) => Number(bar.time))).to.deep.equal(second.slice(-2).map((bar) => Number(bar.time)));
        });
    });

    it("batch loader keeps serving standalone IBKR targets through the shared routing", async () => {
        const bars = makeBars(4, 7);
        await withLocalIbkrFixture("30m", { AAPL: bars }, async () => {
            const wrapper = await fetchServerHistoricalData("AAPL\u2022", "30m", 2);
            expect(wrapper.map((bar) => Number(bar.time))).to.deep.equal(bars.slice(-2).map((bar) => Number(bar.time)));
            const loaded = await loadServerBatchDataset("AAPL\u2022", "30m");
            expect(loaded.map((bar) => Number(bar.time))).to.deep.equal(bars.map((bar) => Number(bar.time)));
        });
    });
});
