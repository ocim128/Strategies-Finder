import { expect } from "chai";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const APP_ROOT = process.cwd();
const SERVER_FINDER_LOADER = path.join(APP_ROOT, "lib", "finder", "server", "server-finder-data-loader.ts");
const SERVER_BATCH_LOADER = path.join(APP_ROOT, "lib", "batch-backtest", "server-batch-data-loader.ts");
const SHARED_CORE = path.join(APP_ROOT, "lib", "batch-backtest", "batch-dataset-loader-core.ts");
const STREAM_TYPES = path.join(APP_ROOT, "lib", "finder", "server", "finder-stream-types.ts");
const FINDER_PLUGIN = path.join(APP_ROOT, "lib", "finder", "server", "finder-vite-plugin.ts");
const UNIVERSE_RUNNER = path.join(APP_ROOT, "lib", "finder", "finder-runner-universe.ts");
const FINDER_MANAGER = path.join(APP_ROOT, "lib", "finder-manager.ts");

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
    it("both server loaders (finder + batch) wrap the shared core", () => {
        expect(existsSync(SERVER_FINDER_LOADER)).to.equal(true);
        expect(existsSync(SERVER_BATCH_LOADER)).to.equal(true);
        expect(existsSync(SHARED_CORE)).to.equal(true);

        expect(readSource(SERVER_FINDER_LOADER)).to.include("createBatchDatasetLoaderCore");
        expect(readSource(SERVER_BATCH_LOADER)).to.include("createBatchDatasetLoaderCore");
    });

    it("finder server loader reuses the same disk-cache hooks as batch", () => {
        const finderLoader = readSource(SERVER_FINDER_LOADER);
        expect(finderLoader).to.include("loadCachedSyntheticPair");
        expect(finderLoader).to.include("storeSyntheticPair");
        // Imports the SAME disk-cache module as the batch loader (not a fork).
        expect(finderLoader).to.include("synthetic-pair-disk-cache");
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
        // Leaf-only imports it IS allowed to use.
        expect(finderLoader.includes('from "../../data/data-fetcher"')).to.equal(true);
        expect(finderLoader.includes('from "../../data/data-cache"')).to.equal(true);
        expect(finderLoader.includes('new DataFetcher(')).to.equal(true);
    });

    it("shared core holds the synthetic-pair pipeline + cache caps", () => {
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
            "DATA_CHART_TOTAL_LIMIT",
        ]) {
            expect(core, `shared core must use ${symbol}`).to.include(symbol);
        }
        // Caps must match the documented budget (AGENTS.md §"Memory budget").
        expect(core).to.include("new SyntheticLegCache<OHLCVData[]>(24)");
        expect(core).to.include("new SyntheticLegCache<OHLCVData[]>(16)");
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
        expect(plugin, "plugin must ship terminalResults on done").to.include("candidates: terminalResults");
    });

    it("F4 regression: HTTP handler applies sliceFinderDataWindow to loaded data", () => {
        // The browser path slices before evaluation; the server loader returns
        // raw data. The handler must apply the same slice or browser/server
        // results diverge for half-window / OOS / data-slice runs.
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

    it("F8 regression: dispatch discriminates on an explicit serverRan flag, NOT allResults.length", () => {
        // A valid server run can produce ZERO survivors (every candidate
        // filtered out, or all symbols failed to load but the run completed).
        // Using allResults.length === 0 as the "run in-tab instead" discriminator
        // would rerun the whole workload in-tab in that case — a correctness bug
        // (different random path) and a performance regression (defeats the
        // server path). The discriminator MUST be an explicit flag set only when
        // the server path actually executed.
        const manager = readSource(FINDER_MANAGER);
        expect(manager, "must declare an explicit serverRan flag").to.include("let serverRan = false");
        expect(manager, "must set serverRan = true on a non-null server outcome").to.include("serverRan = true");
        // The in-tab loop guard must be the explicit flag, NOT result count.
        expect(manager, "in-tab loop must guard on !serverRan").to.match(/if\s*\(\s*!serverRan\s*\)/);
        // And it must NOT use the result-count discriminator that caused the bug.
        expect(manager).to.not.contain("if (allResults.length === 0) {");
    });
});
