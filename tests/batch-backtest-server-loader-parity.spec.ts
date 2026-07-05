import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Parity gate for the server-side batch data loader.
//
// The full "load the same IBKR 4H synthetic pair via both loaders and assert
// bar-for-bar equality" requires a live SQLite API + dev server, which is not
// available in the test runner. Instead this spec locks the structural parity
// invariants that, if violated, would silently make the server loader diverge
// from the browser loader:
//
//   1. Both loaders share the same synthetic-pair pipeline imports
//      (`buildSyntheticPairFromLegs`, `pickSourceInterval`,
//      `resolveEffectiveIntervalForSynthetic`, `deriveSyntheticSymbol`,
//      `resolveSyntheticAvailableIntervals`).
//   2. Both loaders share the same `SyntheticLegCache` / cache-key builders
//      so leg/pair dedup is consistent.
//   3. Both loaders share the same stale-fragment threshold floor/ceiling.
//   4. Both loaders share the same DATA_CHART_TOTAL_LIMIT lookback cap and
//      SYNTHETIC_TARGET_BARS source-bars cap.
//
// If you change one loader without the other, this spec fails at import-time
// or string-match time, surfacing the drift before it ships.

const APP_ROOT = process.cwd();
const BROWSER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "batch-backtest-loader.ts");
const SERVER_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-data-loader.ts");

function readSource(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`loader file missing: ${filePath}`);
    }
    return readFileSync(filePath, "utf8");
}

const SHARED_PIPELINE_IMPORTS = [
    "buildSyntheticPairFromLegs",
    "deriveSyntheticSymbol",
    "pickSourceInterval",
    "resolveEffectiveIntervalForSynthetic",
    "resolveSyntheticAvailableIntervals",
];

const SHARED_CACHE_HELPERS = [
    "SyntheticLegCache",
    "buildLegCacheKey",
    "buildPairCacheKey",
];

const SHARED_DATA_CONSTANTS = [
    "SYNTHETIC_TARGET_BARS",
    "DATA_CHART_TOTAL_LIMIT",
];

describe("batch-backtest server loader parity", () => {
    it("server loader exists alongside the browser loader", () => {
        expect(existsSync(SERVER_LOADER)).to.equal(true);
        expect(existsSync(BROWSER_LOADER)).to.equal(true);
    });

    it("both loaders import the same synthetic-pair pipeline", () => {
        const browser = readSource(BROWSER_LOADER);
        const server = readSource(SERVER_LOADER);
        for (const symbol of SHARED_PIPELINE_IMPORTS) {
            expect(
                browser.includes(symbol),
                `browser loader must import ${symbol}`
            ).to.equal(true);
            expect(
                server.includes(symbol),
                `server loader must import ${symbol}`
            ).to.equal(true);
        }
    });

    it("both loaders share the same leg/pair cache-key builders", () => {
        const browser = readSource(BROWSER_LOADER);
        const server = readSource(SERVER_LOADER);
        for (const symbol of SHARED_CACHE_HELPERS) {
            expect(
                browser.includes(symbol),
                `browser loader must use ${symbol}`
            ).to.equal(true);
            expect(
                server.includes(symbol),
                `server loader must use ${symbol}`
            ).to.equal(true);
        }
    });

    it("both loaders use the same lookback / source-bars caps", () => {
        const browser = readSource(BROWSER_LOADER);
        const server = readSource(SERVER_LOADER);
        for (const symbol of SHARED_DATA_CONSTANTS) {
            expect(
                browser.includes(symbol),
                `browser loader must use ${symbol}`
            ).to.equal(true);
            expect(
                server.includes(symbol),
                `server loader must use ${symbol}`
            ).to.equal(true);
        }
    });

    it("both loaders use the same stale-fragment threshold floor/ceiling", () => {
        const browser = readSource(BROWSER_LOADER);
        const server = readSource(SERVER_LOADER);
        // Same constants — keep them in sync if you raise/lower.
        expect(browser).to.include("STALE_FRAGMENT_MAX_THRESHOLD = 10_000");
        expect(browser).to.include("STALE_FRAGMENT_MIN_THRESHOLD = 200");
        expect(server).to.include("STALE_FRAGMENT_MAX_THRESHOLD = 10_000");
        expect(server).to.include("STALE_FRAGMENT_MIN_THRESHOLD = 200");
    });

    it("both loaders use the same leg/pair LRU cap (24/16)", () => {
        const browser = readSource(BROWSER_LOADER);
        const server = readSource(SERVER_LOADER);
        // Commit 6401a53 lowered both caps; server must match.
        expect(browser).to.include("new SyntheticLegCache<OHLCVData[]>(24)");
        expect(browser).to.include("new SyntheticLegCache<OHLCVData[]>(16)");
        expect(server).to.include("new SyntheticLegCache<OHLCVData[]>(24)");
        expect(server).to.include("new SyntheticLegCache<OHLCVData[]>(16)");
    });

    it("server loader bypasses the browser-bound dataManager singleton", () => {
        const server = readSource(SERVER_LOADER);
        expect(
            server.includes('from "../data-manager"'),
            "server loader must NOT import the browser-bound dataManager singleton"
        ).to.equal(false);
        expect(
            server.includes("new DataFetcher("),
            "server loader must construct DataFetcher directly (recipe at data-fetcher.ts:178-192)"
        ).to.equal(true);
    });

    it("server loader parses synthetic tokens via the leaf module, NOT finder-manager", () => {
        // WHY: finder-manager transitively imports dataManager → settingsManager
        // → data-mining-manager → constants.ts → lightweight-charts (ESM-only).
        // That chain blows up the vite.config.ts Node bundle. The server loader
        // must import `parseSyntheticPairToken` from the leaf module instead.
        const server = readSource(SERVER_LOADER);
        expect(
            server.includes('from "../finder-manager"'),
            "server loader must NOT import from finder-manager (drags in lightweight-charts via settings-manager)"
        ).to.equal(false);
        expect(
            server.includes('from "../synthetic-pair-token"'),
            "server loader must import parseSyntheticPairToken from the leaf synthetic-pair-token module"
        ).to.equal(true);
    });
});
