import { expect } from "chai";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const APP_ROOT = process.cwd();
const BROWSER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "batch-backtest-loader.ts");
const SERVER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-data-loader.ts");
const SHARED_CORE = path.join(APP_ROOT, "lib", "batch-backtest", "batch-dataset-loader-core.ts");
const STREAM_TYPES = path.join(APP_ROOT, "lib", "batch-backtest", "batch-backtest-stream-types.ts");
const ROW_SCALARS = path.join(APP_ROOT, "lib", "batch-backtest", "batch-row-scalars.ts");

function readSource(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`loader file missing: ${filePath}`);
    }
    return readFileSync(filePath, "utf8");
}

describe("batch-backtest server loader parity", () => {
    it("keeps browser and server loaders as wrappers around the shared core", () => {
        expect(existsSync(BROWSER_LOADER)).to.equal(true);
        expect(existsSync(SERVER_LOADER)).to.equal(true);
        expect(existsSync(SHARED_CORE)).to.equal(true);

        expect(readSource(BROWSER_LOADER)).to.include("createBatchDatasetLoaderCore");
        expect(readSource(SERVER_LOADER)).to.include("createBatchDatasetLoaderCore");
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
        expect(core).to.include("new SyntheticLegCache<OHLCVData[]>(24)");
        expect(core).to.include("new SyntheticLegCache<OHLCVData[]>(16)");
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

    it("clears server data and parsed CSV caches so a new run observes freshly synced candles", () => {
        const server = readSource(SERVER_LOADER);
        expect(server).to.include("clearServerBatchDatasetCaches");
        // The shared data cache is cleared through the factory helper.
        expect(server).to.include("clearServerDataCache()");
        expect(server).to.include("clearLocalDailyCsvCachesForSymbols()");
        expect(server).to.include("loadFreshIbkrCandlesFromPriceData");
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
