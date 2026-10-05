import type { UTCTimestamp } from "lightweight-charts";
import { expect } from "chai";
import { withLocalIbkrFixture } from "./helpers/local-ibkr-fixture";
import { withLocalCryptoFixture, writeCryptoCsv } from "./helpers/local-crypto-fixture";
import { describe, it } from "node:test";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import {
    clearServerFinderDatasetCaches,
    loadServerFinderDataset,
} from "../lib/finder/server/server-finder-data-loader";
import {
    fetchServerDetachedDataWithFetcher,
    fetchServerHistoricalDataWithFetcher,
} from "../lib/data/server-data-fetcher-factory";
import type { DataFetcher } from "../lib/data/data-fetcher";
import type { OHLCVData, Time } from "../lib/types/strategies";

const APP_ROOT = process.cwd();
const SERVER_FINDER_LOADER = path.join(APP_ROOT, "lib", "finder", "server", "server-finder-data-loader.ts");
const SERVER_BATCH_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-data-loader.ts");
const SHARED_CORE = path.join(APP_ROOT, "lib", "batch-backtest", "batch-dataset-loader-core.ts");
const STREAM_TYPES = path.join(APP_ROOT, "lib", "finder", "server", "finder-stream-types.ts");
const FINDER_PLUGIN = path.join(APP_ROOT, "lib", "finder", "server", "finder-vite-plugin.ts");
const UNIVERSE_RUNNER = path.join(APP_ROOT, "lib", "finder", "finder-runner-universe.ts");

function readSource(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`file missing: ${filePath}`);
    }
    return readFileSync(filePath, "utf8");
}

/**
 * Structural parity invariants for the server-side Finder Universe data loader.
 * Mirrors `tests/batch-backtest-server-loader-parity.spec.ts`: the Finder
 * server loader must be a thin wrapper over the SAME shared core the Batch
 * server loader uses, so the synthetic-pair pipeline, cache caps, and offline-
 * first gap-fill are identical by construction (AGENTS.md §"Loader parity").
 */
describe("finder server loader parity", () => {
    it("routes a mixed IBKR synthetic pair locally before Binance normalization", async () => {
        const bars = Array.from({ length: 80 }, (_, index) => ({
            time: (1_700_006_400 + index * 1_800) as UTCTimestamp,
            open: 100 + index, high: 102 + index, low: 99 + index,
            close: 101 + index, volume: 1_000,
        }));
        await withLocalIbkrFixture("30m", { AAL: bars, AMAT: bars }, async () => {
            const marked = await loadServerFinderDataset("AAL\u2022+AMAT\u2022", "30m");
            // Clear the pair cache so the mixed-marker path must resolve both legs itself.
            clearServerFinderDatasetCaches();
            const mixed = await loadServerFinderDataset("AAL\u2022+AMAT", "30m");
            expect(marked.length).to.equal(bars.length);
            expect(mixed).to.deep.equal(marked);
        });
    });

    it("both server loaders (finder + batch) wrap the shared core", () => {
        expect(existsSync(SERVER_FINDER_LOADER)).to.equal(true);
        expect(existsSync(SERVER_BATCH_LOADER)).to.equal(true);
        expect(existsSync(SHARED_CORE)).to.equal(true);

        expect(readSource(SERVER_FINDER_LOADER)).to.include("createBatchDatasetLoaderCore");
        expect(readSource(SERVER_BATCH_LOADER)).to.include("createBatchDatasetLoaderCore");
    });

    it("finder server loader reuses the same disk-cache hooks as batch", () => {
        const finderLoader = readSource(SERVER_FINDER_LOADER);
        const batchLoader = readSource(SERVER_BATCH_LOADER);
        expect(finderLoader).to.include("loadCachedSyntheticPair");
        expect(finderLoader).to.include("storeSyntheticPair");
        // Imports the SAME disk-cache module as the batch loader (not a fork).
        expect(finderLoader).to.include("synthetic-pair-disk-cache");
        // Both loaders delegate to the SAME shared routing policy beside the
        // DataFetcher factory, and keep the synced-crypto fast path for thin
        // offline legs, or Finder silently regresses to SQLite/network work
        // while Batch remains fast.
        const factory = readSource(path.join(APP_ROOT, "lib", "data", "server-data-fetcher-factory.ts"));
        for (const symbol of [
            "isIbkrSymbol",
            "loadFreshIbkrCandlesFromDisk",
            "loadFreshCryptoCandlesFromDisk",
        ]) {
            expect(factory, `shared routing policy must include ${symbol}`).to.include(symbol);
        }
        for (const symbol of [
            "fetchServerDetachedDataWithFetcher",
            "fetchServerHistoricalDataWithFetcher",
            "fetchServerDetachedData",
            "fetchServerHistoricalData",
            "getCryptoCsvMtimeMs",
            "acceptOfflineThinData",
        ]) {
            expect(finderLoader, `finder loader must include ${symbol}`).to.include(symbol);
            expect(batchLoader, `batch loader must include ${symbol}`).to.include(symbol);
        }
    });

    it("finder server loader bypasses browser-bound modules (config bundle trap)", () => {
        const finderLoader = readSource(SERVER_FINDER_LOADER);
        // AGENTS.md §"Server-Side import hygiene": must not reach
        // dataManager / finder-manager / constants / chart-manager (which pull
        // lightweight-charts, ESM-only, breaks the cjs config bundle).
        expect(finderLoader.includes('from "../../data-manager"')).to.equal(false);
        expect(finderLoader.includes('from "../../finder-manager"')).to.equal(false);
        expect(finderLoader.includes('from "../../constants"')).to.equal(false);
        expect(finderLoader.includes('from "../../chart-manager"')).to.equal(false);
        // The DataFetcher setup lives in the shared leaf factory
        // (server-data-fetcher-factory.ts), so the loader imports that factory
        // instead of constructing DataFetcher itself. Verify the factory is a
        // leaf module with no browser-bound imports.
        expect(finderLoader.includes('from "../../data/server-data-fetcher-factory"')).to.equal(true);
        const factory = readSource(path.join(APP_ROOT, "lib", "data", "server-data-fetcher-factory.ts"));
        expect(factory.includes('from "./data-fetcher"')).to.equal(true);
        expect(factory.includes('new DataFetcher(')).to.equal(true);
        expect(factory.includes('from "../data-manager"')).to.equal(false);
        expect(factory.includes('from "../chart-manager"')).to.equal(false);
        expect(factory.includes('from "../constants"')).to.equal(false);
        // The shared routing policy extends the factory with Node-safe CSV
        // leaf-loader imports only; it must not gain browser-bound edges.
        expect(factory.includes('from "../local-daily-datasets"')).to.equal(true);
        expect(factory.includes('from "../batch-backtest/server-ibkr-csv-loader"')).to.equal(true);
        expect(factory.includes('from "../batch-backtest/server-crypto-csv-loader"')).to.equal(true);
        expect(factory.includes('from "../finder-manager"')).to.equal(false);
        expect(factory.includes('from "../settings-manager"')).to.equal(false);
    });

    it("shared core holds the synthetic-pair pipeline + cache caps", () => {
        const core = readSource(SHARED_CORE);
        for (const symbol of [
            "buildSyntheticPairFromLegs",
            "deriveSyntheticSymbol",
            "pickSourceInterval",
            "resolveSyntheticAvailableIntervals",
            "SyntheticLegCache",
            "buildLegCacheKey",
            "buildPairCacheKey",
            "DATA_CHART_TOTAL_LIMIT",
        ]) {
            expect(core, `shared core must use ${symbol}`).to.include(symbol);
        }
        // Caps must match the documented budget (AGENTS.md §"Memory budget").
        expect(core).to.include("options.legCacheMaxEntries ?? 24");
        expect(core).to.include("options.pairCacheMaxEntries ?? 16");
        expect(readSource(SERVER_BATCH_LOADER)).to.include("resolveServerBatchCacheBudget");
        expect(readSource(SERVER_FINDER_LOADER)).to.include("resolveServerBatchCacheBudget");
    });

    it("finder stream types enforce the scalar-only wire contract", () => {
        const streamTypes = readSource(STREAM_TYPES);
        expect(streamTypes).to.include("toScalarCandidate");
        expect(streamTypes).to.include("assertCandidateIsScalar");
        expect(streamTypes).to.include("FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS");
        // The forbidden list must cover the heavy array fields.
        for (const forbidden of ["data", "signals", "trades", "equityCurve"]) {
            expect(streamTypes, `forbidden list must include ${forbidden}`).to.include(`"${forbidden}"`);
        }
    });

    it("F1 regression: HTTP handler wires a real FinderParamSpace generateParamSets", () => {
        // Without this, the core falls back to () => [] and the production path
        // produces zero candidates. The handler is the only place this is easy
        // to miss (tests inject their own generator).
        const plugin = readSource(FINDER_PLUGIN);
        expect(plugin).to.include("new FinderParamSpace()");
        expect(plugin).to.include("paramSpace.generateParamSets");
        expect(plugin).to.include("generateParamSets: (defaultParams, finderOptions)");
    });

    it("F3 regression: done event carries the terminal survivor slice", () => {
        const streamTypes = readSource(STREAM_TYPES);
        expect(streamTypes, "done event must declare a candidates field").to.include("candidates: FinderUniverseCandidate[]");
        const plugin = readSource(FINDER_PLUGIN);
        // The plugin ships the scalar terminal slice on `done` so the browser
        // finalizes from done.candidates (not throttled incremental events).
        // The variable name is `terminalScalar` (the scalar-stripped terminal
        // survivors); the contract is that the done event carries the
        // authoritative candidate slice.
        expect(plugin, "plugin must ship the terminal scalar survivors on done").to.include("candidates: terminalScalar");
    });

    it("F4 regression: HTTP handler applies sliceFinderDataWindow to loaded data", () => {
        // The server loader returns raw data. The handler must apply the
        // requested evaluation slice before running candidates.
        const plugin = readSource(FINDER_PLUGIN);
        expect(plugin).to.include("sliceFinderDataWindow");
        expect(plugin).to.include("loadDatasetWithSlice");
        expect(plugin).to.include("options.dataSlice");
    });

    it("F6 regression: useRustEnginePreference threads through to executeBacktest", () => {
        // Without this, server-side Finder silently uses TS even when Rust is
        // enabled (the documented Rust-engine trap). The runner must accept it
        // on the input and pass it into the executeBacktest context.
        const runner = readSource(UNIVERSE_RUNNER);
        expect(runner).to.include("useRustEnginePreference?: boolean");
        expect(runner).to.include("useRustEnginePreference: input.useRustEnginePreference");
        const plugin = readSource(FINDER_PLUGIN);
        expect(plugin).to.include("useRustEnginePreference: input.useRustEnginePreference");
    });

    it("finder and batch invalidation clear the cache layers each loader owns (audit F1)", () => {
        // Crypto/IBKR sync can update SQLite between runs. Both loaders must
        // clear their leg/pair LRUs, fingerprint memo, and shared DataCache.
        // Finder also owns the browser/local-daily cache hooks; Batch reads
        // server CSVs through mtime-aware caches, so it intentionally retains
        // those parsed entries across runs.
        const finderLoader = readSource(SERVER_FINDER_LOADER);
        const batchLoader = readSource(SERVER_BATCH_LOADER);
        for (const symbol of [
            "loader.clearCaches()",
            "fingerprintMemo.clear()",
            "clearServerDataCache()",
        ]) {
            expect(finderLoader, `finder invalidation must call ${symbol}`).to.include(symbol);
            expect(batchLoader, `batch invalidation must call ${symbol}`).to.include(symbol);
        }
        for (const symbol of [
            "clearLocalDailyCsvCachesForSymbols()",
            "clearParsedIbkrCsvCache()",
            "clearParsedCryptoCsvCache()",
        ]) {
            expect(finderLoader, `finder invalidation must call ${symbol}`).to.include(symbol);
            expect(batchLoader, `batch invalidation must retain ${symbol}`).to.not.include(symbol);
        }
    });

});

/**
 * Behavioral parity for the disk-first routing both server loaders share. This
 * block mirrors the same cases in `tests/batch-backtest-server-loader-parity.spec.ts`:
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

    it("finder loader keeps serving standalone IBKR targets through the shared routing", async () => {
        const bars = makeBars(4, 7);
        await withLocalIbkrFixture("30m", { AAPL: bars }, async () => {
            clearServerFinderDatasetCaches();
            const loaded = await loadServerFinderDataset("AAPL\u2022", "30m");
            expect(loaded.map((bar) => Number(bar.time))).to.deep.equal(bars.map((bar) => Number(bar.time)));
        });
    });
});
