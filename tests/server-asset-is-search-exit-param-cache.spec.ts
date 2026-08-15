/**
 * Exit-param-space caching in the server Asset Opportunity IS search.
 *
 * `runServerAssetIsSearch` samples one exit strategy + param set per entry
 * candidate (index-modulo deterministic sampling). The exit lib's param space
 * must be GENERATED ONCE per exit lib and cached — regenerating it inside the
 * per-candidate loop is O(maxRuns^2) param allocations and silently invisible
 * to the phase timings (the sampling block sits outside both the
 * parameterGeneration and backtest timers).
 *
 * This spec locks:
 *  - the exit generator is invoked exactly once per exit lib per asset pass,
 *    regardless of candidate count;
 *  - the index-modulo sampling is unchanged (candidate i uses exit lib
 *    i % libs and that lib's param set i % setLength);
 *  - identical seeded inputs still produce identical results (determinism).
 *
 * Mirrors the equivalent caches in the browser runner (`finder-runner.ts`
 * `exitParamSetsByKey`) and the Universe runner (`finder-runner-universe.ts`).
 */

import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { runServerAssetIsSearch } from "../lib/finder/server/server-asset-is-search";
import {
    registerLoadedBuiltInStrategy,
    unregisterLoadedBuiltInStrategy,
} from "../lib/strategies/built-in-catalog";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions, FinderResult } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams, Time } from "../lib/types/strategies";

const ENTRY_KEY = "asset_is_exit_cache_entry";
const EXIT_A_KEY = "asset_is_exit_cache_exit_a";
const EXIT_B_KEY = "asset_is_exit_cache_exit_b";

const entryStrategy: Strategy = {
    name: "Exit Cache Entry",
    description: "Enters on the latest bar; exit-override sampling test.",
    defaultParams: { entryMarker: 1, threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        const latest = data[data.length - 1];
        return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
    },
};

const exitStrategyA: Strategy = {
    name: "Exit Cache Exit A",
    description: "Never exits; param sampling test.",
    defaultParams: { exitMarkerA: 1 },
    paramLabels: { exitMarkerA: "Marker A" },
    execute: () => [],
};

const exitStrategyB: Strategy = {
    name: "Exit Cache Exit B",
    description: "Never exits; param sampling test.",
    defaultParams: { exitMarkerB: 1 },
    paramLabels: { exitMarkerB: "Marker B" },
    execute: () => [],
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

function makeCandles(): OHLCVData[] {
    return Array.from({ length: 30 }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000,
    }));
}

const ENTRY_SETS = 6;
const EXIT_SETS = 3;

function makeOptions(): FinderOptions {
    return {
        mode: "random",
        randomSeed: 1234,
        scope: "asset_opportunity",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        symbols: ["TEST"],
        topN: ENTRY_SETS,
        steps: 3,
        rangePercent: 35,
        maxRuns: ENTRY_SETS,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
    } as unknown as FinderOptions;
}

/**
 * Dispatching generator: entry marker -> ENTRY_SETS distinct sets; exit
 * markers -> EXIT_SETS distinct sets, counting invocations per lib.
 */
function createCountingGenerator() {
    const calls = new Map<string, number>();
    const generator = (defaultParams: StrategyParams, _options: FinderOptions): StrategyParams[] => {
        if ("entryMarker" in defaultParams) {
            calls.set("entry", (calls.get("entry") ?? 0) + 1);
            return Array.from({ length: ENTRY_SETS }, (_, variant) => ({ ...defaultParams, entryVariant: variant }));
        }
        if ("exitMarkerA" in defaultParams) {
            calls.set(EXIT_A_KEY, (calls.get(EXIT_A_KEY) ?? 0) + 1);
            return Array.from({ length: EXIT_SETS }, (_, variant) => ({ ...defaultParams, exitVariant: variant }));
        }
        if ("exitMarkerB" in defaultParams) {
            calls.set(EXIT_B_KEY, (calls.get(EXIT_B_KEY) ?? 0) + 1);
            return Array.from({ length: EXIT_SETS }, (_, variant) => ({ ...defaultParams, exitVariant: variant }));
        }
        throw new Error(`Unexpected generator defaults: ${JSON.stringify(defaultParams)}`);
    };
    return { generator, calls };
}

async function runSearch(generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[]): Promise<FinderResult[]> {
    const output = await runServerAssetIsSearch({
        ohlcvData: makeCandles(),
        symbol: "TEST",
        interval: "5m",
        options: makeOptions(),
        settings,
        capitalSettings,
        selectedStrategy: { key: ENTRY_KEY, name: entryStrategy.name, strategy: entryStrategy },
        exitStrategyCandidates: [
            { key: EXIT_A_KEY, name: exitStrategyA.name, strategy: exitStrategyA },
            { key: EXIT_B_KEY, name: exitStrategyB.name, strategy: exitStrategyB },
        ],
        generateParamSets,
        isCancelled: () => false,
        yieldControl: async () => {},
    });
    return output.results;
}

describe("server Asset IS search exit-param caching", () => {
    before(() => {
        // The executor resolves exit overrides by key through the built-in
        // catalog; register fakes there so the run is end-to-end realistic.
        registerLoadedBuiltInStrategy(EXIT_A_KEY, exitStrategyA);
        registerLoadedBuiltInStrategy(EXIT_B_KEY, exitStrategyB);
    });
    after(() => {
        unregisterLoadedBuiltInStrategy(EXIT_A_KEY);
        unregisterLoadedBuiltInStrategy(EXIT_B_KEY);
    });

    it("generates each exit lib's param space exactly once per asset pass", async () => {
        const { generator, calls } = createCountingGenerator();
        const results = await runSearch(generator);

        expect(results.length).to.equal(ENTRY_SETS);
        // The cache is the whole point: one generation per exit lib, not one
        // per entry candidate (6 candidates over 2 libs would be 12 calls
        // uncached).
        expect(calls.get(EXIT_A_KEY)).to.equal(1);
        expect(calls.get(EXIT_B_KEY)).to.equal(1);
        expect(calls.get("entry")).to.equal(1);
    });

    it("preserves index-modulo exit sampling and param pairing", async () => {
        const { generator } = createCountingGenerator();
        const results = await runSearch(generator);

        // Recover each candidate's original index from the entry variant and
        // assert the documented deterministic sampling: lib i % 2, param set
        // i % EXIT_SETS.
        const expectedExitKeys = [EXIT_A_KEY, EXIT_B_KEY];
        for (const result of results) {
            const variant = result.params.entryVariant;
            expect(variant).to.be.a("number");
            const index = variant as number;
            expect(result.exitStrategyKey).to.equal(expectedExitKeys[index % expectedExitKeys.length]!);
            expect(result.exitStrategyParams.exitVariant).to.equal(index % EXIT_SETS);
        }
        const variants = results.map((result) => result.params.entryVariant).sort();
        expect(variants).to.deep.equal(Array.from({ length: ENTRY_SETS }, (_, i) => i));
    });

    it("is deterministic across identical seeded runs", async () => {
        const first = await runSearch(createCountingGenerator().generator);
        const second = await runSearch(createCountingGenerator().generator);
        expect(second).to.deep.equal(first);
    });
});
