/**
 * Focused Finder settings/persistence contract tests for the extracted
 * `lib/finder/browser/finder-settings.ts` and
 * `lib/finder/browser/finder-persistence.ts` modules.
 *
 * Covers legacy/malformed persisted state normalization, round-trip
 * normalization through the version-1 storage envelopes, and write timing
 * (terminal-only result snapshots, null-envelope clears).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import {
    DEFAULT_FINDER_UI_STATE,
    normalizeFinderUiState,
    normalizeFinderScope,
    normalizeAdvancedSortOrder,
    emptyFinderLatestResults,
} from "../lib/finder/browser/finder-settings";
import {
    FINDER_UI_STORAGE,
    FINDER_RESULTS_STORAGE,
    FINDER_ACTIVE_SERVER_RUN_STORAGE,
    readFinderUiState,
    writeFinderUiState,
    readFinderLatestResultsSnapshot,
    writeFinderLatestResultsSnapshot,
    clearFinderLatestResultsSnapshot,
    readFinderActiveServerRun,
    writeFinderActiveServerRun,
    clearFinderActiveServerRun,
} from "../lib/finder/browser/finder-persistence";

type FakeLocalStorage = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    _store: Map<string, string>;
    _writes: Map<string, number>;
};

function makeFakeLocalStorage(): FakeLocalStorage {
    const store = new Map<string, string>();
    const writes = new Map<string, number>();
    return {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, value);
            writes.set(key, (writes.get(key) ?? 0) + 1);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        _store: store,
        _writes: writes,
    };
}

let savedLocalStorage: unknown;

before(() => {
    savedLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = makeFakeLocalStorage();
});

after(() => {
    if (savedLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = savedLocalStorage;
});

beforeEach(() => {
    const storage = (globalThis as any).localStorage as FakeLocalStorage;
    storage._store.clear();
    storage._writes.clear();
});

describe("normalizeFinderUiState", () => {
    it("returns the defaults for null, arrays, and primitives", () => {
        for (const raw of [null, undefined, [], "state", 42, true]) {
            const normalized = normalizeFinderUiState(raw);
            expect(normalized).to.deep.equal({ ...DEFAULT_FINDER_UI_STATE });
        }
    });

    it("restores the legacy single universe strategy key as a one-element list", () => {
        const normalized = normalizeFinderUiState({
            universeSelectedStrategyKey: "legacy_strategy",
        });
        expect(normalized.universeSelectedStrategyKeys).to.deep.equal(["legacy_strategy"]);
        expect(normalized.currentChartSelectedStrategyKeys).to.deep.equal([]);
    });

    it("drops malformed values instead of throwing", () => {
        const normalized = normalizeFinderUiState({
            scope: "not_a_scope",
            currentChartSelectedStrategyKeys: "nope",
            universeSelectedStrategyKeys: [42, "  ", "kept_strategy", "kept_strategy"],
            sortPrimary: "bogusMetric",
            sortSecondary: 7,
            mode: "simulated_annealing",
            dataSlice: "eleven",
            dataRangeFrom: "not a date",
            topN: "twelve",
            maxTradesText: "-3",
            advancedSortOrder: ["expectancy", "expectancy", "nope"],
            advancedTimingSortEnabled: ["entryScore", "netProfit"],
            universeSort: "madeUpScore",
        });
        expect(normalized.scope).to.equal("current_chart");
        expect(normalized.currentChartSelectedStrategyKeys).to.deep.equal([]);
        expect(normalized.universeSelectedStrategyKeys).to.deep.equal(["kept_strategy"]);
        expect(normalized.sortPrimary).to.equal(DEFAULT_FINDER_UI_STATE.sortPrimary);
        expect(normalized.sortSecondary).to.equal(DEFAULT_FINDER_UI_STATE.sortSecondary);
        expect(normalized.mode).to.equal("random");
        expect(normalized.dataSlice).to.equal("all");
        expect(normalized.dataRangeFrom).to.equal("");
        expect(normalized.topN).to.equal(DEFAULT_FINDER_UI_STATE.topN);
        expect(normalized.maxTradesText).to.equal("");
        // Duplicates drop; unknown metrics are filtered out; missing entries
        // are appended so the order always covers the full option list.
        expect(normalized.advancedSortOrder).to.deep.equal([...DEFAULT_FINDER_UI_STATE.advancedSortOrder]);
        expect(normalized.advancedTimingSortEnabled).to.deep.equal(["entryScore"]);
    });

    it("clamps numeric fields into their stored ranges", () => {
        const normalized = normalizeFinderUiState({
            topN: 0,
            maxRuns: Number.POSITIVE_INFINITY,
            universeMinActiveSymbols: 0.4,
            universeMinProfitableActiveRatio: 7,
            assetOpportunityCandidatePoolSize: 500,
            armPerformanceHorizon: 5_000,
            assetOpportunityOosBatchStartBars: "bad",
            assetOpportunityOosBatchEndBars: 5,
            minTrades: 3.7,
        });
        expect(normalized.topN).to.equal(1);
        expect(normalized.maxRuns).to.equal(DEFAULT_FINDER_UI_STATE.maxRuns);
        expect(normalized.universeMinActiveSymbols).to.equal(1);
        expect(normalized.universeMinProfitableActiveRatio).to.equal(1);
        expect(normalized.assetOpportunityCandidatePoolSize).to.equal(50);
        expect(normalized.armPerformanceHorizon).to.equal(1_000);
        expect(normalized.assetOpportunityOosBatchStartBars)
            .to.equal(DEFAULT_FINDER_UI_STATE.assetOpportunityOosBatchStartBars);
        expect(normalized.assetOpportunityOosBatchEndBars)
            .to.equal(DEFAULT_FINDER_UI_STATE.assetOpportunityOosBatchEndBars);
        expect(normalized.minTrades).to.equal(4);
    });

    it("round-trips a populated state through normalization unchanged", () => {
        const state = normalizeFinderUiState({
            scope: "asset_opportunity",
            currentChartSelectedStrategyKeys: ["alpha", "beta"],
            universeSelectedStrategyKeys: ["gamma"],
            sortPrimary: "netProfit",
            sortSecondary: "sharpeRatio",
            useAdvancedSort: true,
            mode: "grid",
            dataSlice: "date_range",
            dataRangeFrom: "2024-01-01",
            dataRangeTo: "2024-06-30",
            topN: 7,
            maxRuns: 99,
            tradeFilterEnabled: false,
            minTrades: 12,
            maxTradesText: "200",
            universeSymbolsText: "AAPL\nMSFT",
            assetOpportunityOosMeasurementMode: "next_exit",
            armPerformanceHorizon: 20,
        });
        expect(normalizeFinderUiState(state)).to.deep.equal(state);
    });

    it("treats tradeFilterEnabled as on unless explicitly false", () => {
        expect(normalizeFinderUiState({}).tradeFilterEnabled).to.equal(true);
        expect(normalizeFinderUiState({ tradeFilterEnabled: false }).tradeFilterEnabled).to.equal(false);
        expect(normalizeFinderUiState({ tradeFilterEnabled: "no" }).tradeFilterEnabled).to.equal(true);
    });

    it("normalizes scopes and sort orders through the exported helpers", () => {
        expect(normalizeFinderScope("arm_performance")).to.equal("arm_performance");
        expect(normalizeFinderScope("whatever")).to.equal("current_chart");
        expect(normalizeAdvancedSortOrder(["expectancy", "expectancy"]))
            .to.deep.equal(["expectancy", ...DEFAULT_FINDER_UI_STATE.advancedSortOrder.filter((m) => m !== "expectancy")]);
        expect(emptyFinderLatestResults("strategy_quality")).to.deep.equal({ scope: "strategy_quality", results: [] });
        expect(emptyFinderLatestResults("arm_performance")).to.deep.equal({
            scope: "arm_performance",
            results: [],
            runContext: null,
            inventoryComplete: true,
        });
    });
});

describe("finder UI state persistence", () => {
    it("reads back what was written and defaults to the defaults when empty", () => {
        expect(readFinderUiState()).to.deep.equal({ ...DEFAULT_FINDER_UI_STATE });

        const state = normalizeFinderUiState({ scope: "symbol_universe", topN: 3 });
        writeFinderUiState(state);
        expect(readFinderUiState()).to.deep.equal(state);

        const stored = JSON.parse((globalThis as any).localStorage.getItem(FINDER_UI_STORAGE.key));
        expect(stored.schema).to.equal("finder.ui");
        expect(stored.version).to.equal(1);
    });

    it("falls back to defaults on malformed stored JSON", () => {
        (globalThis as any).localStorage.setItem(FINDER_UI_STORAGE.key, "{not json");
        expect(readFinderUiState()).to.deep.equal({ ...DEFAULT_FINDER_UI_STATE });
    });

    it("ignores envelopes stamped with a foreign schema name", () => {
        (globalThis as any).localStorage.setItem(
            FINDER_UI_STORAGE.key,
            JSON.stringify({ schema: "finder.ui.v2", version: 1, data: { topN: 1 } }),
        );
        expect(readFinderUiState().topN).to.equal(DEFAULT_FINDER_UI_STATE.topN);
    });
});

describe("finder results snapshot persistence", () => {
    const currentChartResult = {
        key: "snapshot_test",
        name: "Snapshot Test",
        params: { threshold: 1 },
        result: { netProfit: 10, totalTrades: 2 },
        selectionResult: { netProfit: 10, totalTrades: 2 },
    } as any;

    it("never writes an empty non-Arm snapshot, and clears with a null envelope", () => {
        writeFinderLatestResultsSnapshot({
            symbol: "BTCUSDT",
            interval: "5m",
            results: { scope: "current_chart", results: [] },
        });
        expect((globalThis as any).localStorage.getItem(FINDER_RESULTS_STORAGE.key)).to.equal(null);

        clearFinderLatestResultsSnapshot();
        const stored = JSON.parse((globalThis as any).localStorage.getItem(FINDER_RESULTS_STORAGE.key));
        expect(stored.schema).to.equal("finder.latest_results");
        expect(stored.data).to.equal(null);
        expect(readFinderLatestResultsSnapshot()).to.equal(null);
    });

    it("writes and reads back a populated snapshot with context fields", () => {
        writeFinderLatestResultsSnapshot({
            symbol: "BTCUSDT",
            interval: "5m",
            results: { scope: "current_chart", results: [currentChartResult] },
        });
        const snapshot = readFinderLatestResultsSnapshot();
        expect(snapshot).to.not.equal(null);
        expect(snapshot!.symbol).to.equal("BTCUSDT");
        expect(snapshot!.interval).to.equal("5m");
        expect(snapshot!.results.scope).to.equal("current_chart");
        expect(snapshot!.results.results).to.have.length(1);
        expect(typeof snapshot!.savedAt).to.equal("number");

        // Empty Arm inventories ARE written: the incomplete-preview contract
        // relies on the run context surviving a reload even with zero rows.
        writeFinderLatestResultsSnapshot({
            symbol: "BTCUSDT",
            interval: "5m",
            results: { scope: "arm_performance", results: [], runContext: null, inventoryComplete: false },
        });
        const armSnapshot = readFinderLatestResultsSnapshot();
        expect(armSnapshot).to.not.equal(null);
        expect(armSnapshot!.results.scope).to.equal("arm_performance");
        expect((armSnapshot!.results as any).inventoryComplete).to.equal(false);
    });

    it("returns null for a results envelope with neither rows nor Arm scope", () => {
        (globalThis as any).localStorage.setItem(
            FINDER_RESULTS_STORAGE.key,
            JSON.stringify({
                schema: "finder.latest_results",
                version: 1,
                data: { savedAt: 1, symbol: "BTCUSDT", interval: "5m", results: { scope: "current_chart", results: [] } },
            }),
        );
        expect(readFinderLatestResultsSnapshot()).to.equal(null);
    });
});

describe("finder active server run persistence", () => {
    it("round-trips the active run record and rejects malformed records", () => {
        expect(readFinderActiveServerRun()).to.equal(null);

        writeFinderActiveServerRun({ runId: "run-1", scope: "arm_performance", startedAt: 123 });
        expect(readFinderActiveServerRun()).to.deep.equal({ runId: "run-1", scope: "arm_performance", startedAt: 123 });

        clearFinderActiveServerRun();
        const stored = JSON.parse((globalThis as any).localStorage.getItem(FINDER_ACTIVE_SERVER_RUN_STORAGE.key));
        expect(stored.data).to.equal(null);
        expect(readFinderActiveServerRun()).to.equal(null);
    });

    it("rejects unknown scopes, missing run ids, and malformed JSON", () => {
        const key = FINDER_ACTIVE_SERVER_RUN_STORAGE.key;
        (globalThis as any).localStorage.setItem(
            key,
            JSON.stringify({ schema: "finder.active_server_run", version: 1, data: { runId: "r", scope: "current_chart", startedAt: 1 } }),
        );
        expect(readFinderActiveServerRun()).to.equal(null);

        (globalThis as any).localStorage.setItem(
            key,
            JSON.stringify({ schema: "finder.active_server_run", version: 1, data: { scope: "symbol_universe", startedAt: 1 } }),
        );
        expect(readFinderActiveServerRun()).to.equal(null);

        (globalThis as any).localStorage.setItem(key, "broken");
        expect(readFinderActiveServerRun()).to.equal(null);
    });
});
