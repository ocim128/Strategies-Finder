import { expect } from "chai";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
    alignLegCloses,
    createBatchDatasetLoadDiagnostics,
    createBatchDatasetLoaderCore,
} from "../lib/batch-backtest/batch-dataset-loader-core";
import type { BatchDatasetLoadResult } from "../lib/batch-backtest/batch-dataset-loader-core";
import { SyntheticLegCache } from "../lib/batch-backtest/synthetic-leg-cache";
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
            "resolveEffectiveIntervalForSynthetic",
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
        expect(server).to.include("loadFreshIbkrCandlesFromDisk");
        expect(readSource(SERVER_IBKR_LOADER)).to.include('from "node:fs/promises"');
        expect(readSource(SERVER_CACHE_BUDGET)).to.include("HIGH_MEMORY_THRESHOLD_BYTES");
        // The factory helper owns the actual dataCache.clear() call.
        const factory = readSource(path.join(APP_ROOT, "lib", "data", "server-data-fetcher-factory.ts"));
        expect(factory).to.include("dataCache.clear()");
    });

    it("keeps server wire-row scalars out of the full copy-summary formatter", () => {
        const streamTypes = readSource(STREAM_TYPES);
        const rowScalars = readSource(ROW_SCALARS);
        expect(streamTypes.includes("./batch-backtest-summary")).to.equal(false);
        expect(streamTypes.includes("./batch-row-scalars")).to.equal(true);
        expect(rowScalars.includes("finder-universe-metrics")).to.equal(false);
    });
});
