/**
 * Direct tests for `lib/finder/browser/finder-result-store.ts`, the single
 * owner of Finder result inventories, display limits, and the run-sort
 * baseline.
 *
 * Uses the lifecycle fixture style to cover: promoting an initially hidden
 * Universe candidate through re-sort, repeated Arm re-sorts with Run Sort
 * restoration, and Asset Opportunity consensus re-sorts that must retain the
 * full strategy-level row set while grouping displayed rows by symbol.
 */
import { expect } from "chai";
import { createEmptyRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import { describe, it } from "node:test";
import { FinderResultStore } from "../lib/finder/browser/finder-result-store";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
import type {
    FinderArmPerformanceCandidate,
    FinderAssetOpportunityResult,
    FinderLatestResults,
    FinderUniverseCandidate,
    FinderUniverseSymbolResult,
} from "../lib/types/finder";

function makeStore(): { store: FinderResultStore; writes: FinderLatestResults[] } {
    const writes: FinderLatestResults[] = [];
    return { store: new FinderResultStore((results) => writes.push(results)), writes };
}

function makeSymbolResult(symbol: string, netProfit: number): FinderUniverseSymbolResult {
    return {
        symbol,
        status: "profitable",
        barCount: 100,
        firstTime: 1_700_000_000 as any,
        lastTime: (1_700_000_000 + 100 * 300) as any,
        firstClose: 100,
        lastClose: 100 + netProfit,
        directionalLookbackClose: 100,
        directionalLookbackBars: 96,
        result: {
            netProfit,
            netProfitPercent: netProfit,
            expectancy: netProfit,
            avgTrade: netProfit,
            winRate: 1,
            profitFactor: 2,
            totalTrades: 20,
            maxDrawdownPercent: 0,
            winningTrades: 10,
            losingTrades: 0,
            avgWin: netProfit,
            avgLoss: 0,
            sharpeRatio: 1.5,
            sharpeRatioAvailable: true,
            drawdownAvailable: false,
        },
    };
}

function makeCandidate(params: Record<string, number>, netProfit: number): FinderUniverseCandidate {
    return buildFinderUniverseCandidate({
        strategyKey: "universe_test",
        strategyName: "Universe Test",
        params,
        symbols: [makeSymbolResult("AAA", netProfit), makeSymbolResult("BBB", netProfit / 2)],
    });
}

function makeArmCandidate(ordinal: number, rawNow: number, raw: number): FinderArmPerformanceCandidate {
    const metric = (topMean: number) => ({
        events: 2,
        topMean,
        randomMean: 0,
        delta: topMean / 2,
        topMedian: topMean,
        ciLower: topMean / 2,
        ciUpper: topMean,
        positiveBlocks: 1,
        totalBlocks: 1,
    });
    const metrics = Object.fromEntries([
        "TOP_RAW_PROFIT_NOW", "TOP_MEAN_PROFIT_NOW", "TOP_RAW_PROFIT_NOW_CONF", "TOP_Z",
        "TOP_RAW", "TOP_MEAN", "TOP_MEAN_RAW_UNIQUE", "TOP_RAW_PROFIT", "TOP_MEAN_PROFIT",
        "BOT_RAW_PROFIT_NOW", "BOT_MEAN_PROFIT_NOW", "BOT_Z", "BOT_RAW", "BOT_MEAN", "BOT_MEAN_RAW_UNIQUE",
    ].map((arm) => [arm, metric(arm === "TOP_RAW_PROFIT_NOW" ? rawNow : arm === "TOP_RAW" ? raw : ordinal)]));
    return {
        candidateId: `arm-candidate-${ordinal}`,
        candidateOrdinal: ordinal,
        strategyKey: "arm_test",
        strategyName: "Arm Test",
        replayMode: "horizon",
        horizon: 5,
        params: { threshold: ordinal + 1 },
        backtestSettings: { executionModel: "signal_close" } as any,
        pairCoverage: { requestedPairs: 2, completedPairs: 2, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
        metrics: metrics as NonNullable<FinderArmPerformanceCandidate["metrics"]>,
        requestedEngineMode: "typescript",
        actualEngineMode: "typescript",
    };
}

function makeAssetRow(symbol: string, strategyKey: string, expectancy: number, extras: Record<string, unknown> = {}): FinderAssetOpportunityResult {
    const backtest = {
        trades: [],
        equityCurve: [],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 50,
        expectancy,
        avgTrade: 1,
        profitFactor: 2,
        maxDrawdown: 1,
        maxDrawdownPercent: 1,
        totalTrades: 10,
        winningTrades: 5,
        losingTrades: 5,
        avgWin: 2,
        avgLoss: 1,
        sharpeRatio: 1,
    };
    return {
        symbol,
        strategyKey,
        strategyName: strategyKey,
        params: {},
        historicalRank: 1,
        totalCandidatesEvaluated: 1,
        isHistoricalBest: true,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: null,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: backtest,
        medianBarsToTp: 3,
        priorTupleRecurrenceCount: 1,
        strategyCoverageCount: 2,
        ...extras,
        support: {
            freshLongCandidates: 1,
            freshShortCandidates: 0,
            freshSameDirection: 1,
            poolSize: 1,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
    } as FinderAssetOpportunityResult;
}

describe("FinderResultStore", () => {
    it("deduplicates identical Arm display edits and flushes one bounded checkpoint", () => {
        const { store, writes } = makeStore();
        const rows = [makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2), makeArmCandidate(2, 3, 12)];
        store.armPerformanceDisplayLimit = 1;
        store.adoptArmPerformanceResults(rows, null, true);
        writes.length = 0;
        const filter = { basis: "raw" as const, eventFilterEnabled: true, minEvents: 1, maxEvents: null };
        expect(store.setArmPerformanceDisplayFilter(filter)).to.equal(true);
        const firstDisplay = store.latestResults;
        expect(store.setArmPerformanceDisplayFilter({ ...filter })).to.equal(false);
        expect(store.latestResults).to.equal(firstDisplay, "duplicate events do not rebuild the view");
        expect(writes).to.have.length(0);
        expect(store.setArmPerformanceDisplayFilter(filter, "TOP_RAW")).to.equal(true);
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(2, "sort the full inventory before Top Results");
        store.flushPendingDisplayPersistence();
        expect(writes).to.deep.equal([store.latestResults]);
        expect(writes[0]!.results).to.have.length(1);
        expect(store.armPerformanceRunResults).to.deep.equal(rows);
        // Browser-equivalent Arm Run Sort: re-apply the current filter to the
        // default arm (FinderManager routes Arm scope away from
        // restoreRunSort).
        store.setArmPerformanceDisplayFilter(filter, "TOP_RAW_PROFIT_NOW");
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
    });

    it("recomputes an unchanged display filter when the inventory or display limit changes", () => {
        const { store } = makeStore();
        store.armPerformanceDisplayLimit = 1;
        store.adoptArmPerformanceResults([makeArmCandidate(0, 1, 8)], null, false);
        const filter = { basis: "raw" as const };
        store.setArmPerformanceDisplayFilter(filter);
        store.armPerformanceRunResults = [...store.armPerformanceRunResults, makeArmCandidate(1, 9, 2)];
        expect(store.setArmPerformanceDisplayFilter(filter)).to.equal(true);
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
        expect(store.latestResults.scope === "arm_performance" && store.latestResults.inventoryComplete).to.equal(false);
        store.armPerformanceDisplayLimit = 2;
        expect(store.setArmPerformanceDisplayFilter(filter)).to.equal(true);
        expect(store.latestResults.results).to.have.length(2);
        store.flushPendingDisplayPersistence();
    });

    it("the Arm default view stays empty while the store helper's generic Run Sort falls back to the stashed original", () => {
        // Helper-level characterization (the browser routes Arm Run Sort
        // through FinderManager.applyArmPerformanceDisplaySettings — see the
        // manager lifecycle spec): with an event filter that the default
        // arm's rows cannot satisfy, the default view is EMPTY at adoption,
        // and switching to an arm whose rows clear the filter shows them.
        // The store's generic restoreRunSort fallback then restores the
        // stashed original (the empty default view).
        const { store } = makeStore();
        const rows = [
            makeArmCandidate(0, 1, 8),
            makeArmCandidate(1, 9, 2),
            makeArmCandidate(2, 3, 12),
        ].map((row) => ({
            ...row,
            metrics: {
                ...row.metrics!,
                TOP_RAW_PROFIT_NOW: { ...row.metrics!.TOP_RAW_PROFIT_NOW, events: 1 },
                TOP_RAW: { ...row.metrics!.TOP_RAW, events: 9 },
            },
        })) as FinderArmPerformanceCandidate[];
        const filter = {
            measurement: "return" as const,
            rankingSort: "overall_ordering" as const,
            basis: "raw" as const,
            eventFilterEnabled: true,
            minEvents: 5,
            maxEvents: null,
        };
        store.initializeArmPerformanceDisplayFilter(filter);
        store.armPerformanceDisplayLimit = 10;
        store.adoptArmPerformanceResults(rows, null, true);
        expect(store.latestResults.results).to.deep.equal([], "the default arm's filtered view is empty");
        store.stashRunSortBaseline();

        expect(store.setArmPerformanceDisplayFilter(filter, "TOP_RAW")).to.equal(true);
        expect(store.latestResults.results).to.have.length(3, "the TOP_RAW arm's rows clear the event filter");
        expect(store.setArmPerformanceDisplayFilter(filter, "TOP_RAW")).to.equal(
            false,
            "duplicate control events still describe the rendered view",
        );

        store.restoreRunSort();
        expect(store.latestResults.results).to.deep.equal(
            [],
            "the generic Run Sort fallback restores the stashed original empty default view",
        );
        expect(store.latestResults.scope).to.equal("arm_performance");
    });

    it("re-sorts an incomplete bounded preview and returns it to the default arm under the current filter", () => {
        // Browser-equivalent Run Sort for Arm: re-applying the current filter
        // to the default arm (what applyArmPerformanceDisplaySettings does
        // when the dropdown is empty) — restoreRunSort is not on the Arm path.
        const { store } = makeStore();
        store.armPerformanceDisplayLimit = 10;
        store.adoptArmPerformanceResults([makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2)], null, false);
        expect(store.latestResults.scope === "arm_performance" && store.latestResults.inventoryComplete).to.equal(false);
        const filter = { basis: "raw" as const };
        store.setArmPerformanceDisplayFilter(filter, "TOP_RAW");
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(
            0,
            "TOP_RAW ranks by raw (8 beats 2)",
        );
        store.setArmPerformanceDisplayFilter(filter, "TOP_RAW_PROFIT_NOW");
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(
            1,
            "returning to the default arm re-ranks by TOP_RAW_PROFIT_NOW (9 beats 1)",
        );
    });

    it("commits terminal results immediately and discards superseded display checkpoints", () => {
        const { store, writes } = makeStore();
        const rows = [makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2)];
        store.adoptArmPerformanceResults(rows, null, false);
        writes.length = 0;
        store.setArmPerformanceDisplayFilter({ basis: "raw" }, "TOP_RAW");
        store.adoptArmPerformanceResults(rows, null, true);
        expect(writes).to.deep.equal([store.latestResults]);
        store.flushPendingDisplayPersistence();
        expect(writes).to.have.length(1, "terminal adoption cancels the pending display write");
        store.setArmPerformanceDisplayFilter({ basis: "raw" }, "TOP_RAW");
        store.resetForNewRun();
        store.flushPendingDisplayPersistence();
        expect(writes).to.have.length(1, "a new run discards old display writes");
    });

    it("promotes an initially hidden Universe candidate and restores the Run Sort", () => {
        const { store, writes } = makeStore();
        store.symbolUniverseDisplayLimit = 1;
        const lower = makeCandidate({ threshold: 1 }, 10);
        const higher = makeCandidate({ threshold: 2 }, 100);
        store.adoptSymbolUniverseResults([lower, higher]);

        expect(store.latestResults.results).to.have.length(1);
        expect(store.latestResults.results[0]!.params.threshold).to.equal(1);
        expect(writes).to.have.length(1, "terminal adoption persists once");

        // Provisional updates must never persist.
        store.setLatestResults({ scope: "symbol_universe", results: [higher] }, false);
        expect(writes).to.have.length(1);

        store.applyResortMetric("medianExpectancy");
        expect(store.latestResults.results[0]!.params.threshold).to.equal(2);
        expect(store.symbolUniverseRunResults).to.have.length(2, "full inventory retained for re-sort");

        store.restoreRunSort();
        expect(store.latestResults.results[0]!.params.threshold).to.equal(1);
        expect(writes.length).to.be.greaterThan(1, "re-sorts persist as semantic checkpoints");
    });

    it("switches measurement locally before Top Results and preserves the full source", () => {
        const { store } = makeStore();
        store.armPerformanceDisplayLimit = 1;
        const rows = [makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2)];
        for (const [index, row] of rows.entries()) {
            row.rankingMeasurement = createEmptyRankingMeasurement(20);
            const arm = row.rankingMeasurement.arms.topRawProfitNow;
            Object.assign(arm, { scoredEvents: 100, eligibleEvents: 100, comparisons: 1000, meanAccuracy: 0.8, top1Superiority: index === 0 ? 0.6 : 0.9, ciLower: index === 0 ? 0.7 : 0.6, ciUpper: 0.9, blockCount: 10, measurementWindowSec: 10, timeBlockWidthSec: 20, timeCoverageSec: 200, status: "available" });
        }
        store.adoptArmPerformanceResults(rows, null, true);
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
        store.setArmPerformanceDisplayFilter({ measurement: "ranking_consistency", rankingHorizon: 20 });
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(0);
        store.setArmPerformanceDisplayFilter({ measurement: "ranking_consistency", rankingHorizon: 20, rankingSort: "selected_asset" });
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1, "the previously hidden configuration is sorted before Top Results");
        // Reload adopts the same inventory with the saved local display preference,
        // even if the run was originally submitted with the compatibility default.
        const { store: recovered } = makeStore();
        recovered.armPerformanceDisplayLimit = 1;
        recovered.initializeArmPerformanceDisplayFilter({ ...store.armPerformanceDisplayFilter });
        recovered.adoptArmPerformanceResults(rows, { searchOptions: { armPerformance: { measurement: "ranking_consistency", rankingSort: "overall_ordering", horizon: 20 } } } as any, true);
        expect(recovered.armPerformanceDisplayFilter.rankingSort).to.equal("selected_asset");
        expect((recovered.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
        const { store: fromContext } = makeStore();
        fromContext.adoptArmPerformanceResults(rows, { searchOptions: { armPerformance: { measurement: "ranking_consistency", rankingSort: "selected_asset", horizon: 20 } } } as any, true);
        expect(fromContext.armPerformanceDisplayFilter.rankingSort).to.equal("selected_asset");
        expect((fromContext.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
        store.setArmPerformanceDisplayFilter({ measurement: "return", rankingSort: "selected_asset" });
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(1);
        store.setArmPerformanceDisplayFilter({ measurement: "ranking_consistency", rankingHorizon: 21 });
        expect((store.latestResults.results as FinderArmPerformanceCandidate[])[0]!.candidateOrdinal).to.equal(0);
        expect(store.armPerformanceRunResults).to.deep.equal(rows);
    });

    it("survives repeated Arm re-sorts and restores the default arm ordering", () => {
        const { store } = makeStore();
        store.armPerformanceDisplayLimit = 1;
        const rows = [makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2), makeArmCandidate(2, 3, 12)];
        store.adoptArmPerformanceResults(rows, { runId: "r1" } as any, true);

        const displayed = () => store.latestResults.results as FinderArmPerformanceCandidate[];
        expect(displayed()[0]!.candidateOrdinal).to.equal(1, "default arm sort is TOP_RAW_PROFIT_NOW");
        expect(store.armPerformanceRunResults).to.have.length(3);
        expect((store.latestResults as any).inventoryComplete).to.equal(true);

        store.applyResortMetric("TOP_RAW");
        expect(displayed()[0]!.candidateOrdinal).to.equal(2);
        store.applyResortMetric("TOP_RAW_PROFIT_NOW");
        expect(displayed()[0]!.candidateOrdinal).to.equal(1);

        store.restoreRunSort();
        expect(displayed()[0]!.candidateOrdinal).to.equal(1);
        expect(store.armPerformanceRunResults.map((row) => row.candidateOrdinal)).to.deep.equal([0, 1, 2]);

        // Incomplete inventories keep their completeness flag through re-sorts.
        store.adoptArmPerformanceResults(rows, null, false);
        store.applyResortMetric("TOP_RAW");
        expect((store.latestResults as any).inventoryComplete).to.equal(false);
    });

    it("preserves display changes made after run submission when terminal results arrive", () => {
        const { store } = makeStore();
        const rows = [makeArmCandidate(0, 1, 8), makeArmCandidate(1, 9, 2)];
        store.armPerformanceDisplayLimit = 10;
        store.initializeArmPerformanceDisplayFilter({
            basis: "exclude_top_contributor",
            eventFilterEnabled: true,
            minEvents: 20,
            maxEvents: null,
        });

        // A user edits the display controls while candidate events are still
        // streaming. The terminal run context still contains submitted values.
        store.setArmPerformanceDisplayFilter({
            basis: "raw",
            eventFilterEnabled: true,
            minEvents: 2,
            maxEvents: 10,
        });
        store.adoptArmPerformanceResults(rows, {
            runId: "r2",
            searchOptions: { armPerformance: { scoringBasis: "exclude_top_contributor", eventFilterEnabled: true, minEvents: 20 } },
        } as any, true);

        expect(store.armPerformanceDisplayFilter).to.deep.equal({
            basis: "raw",
            eventFilterEnabled: true,
            minEvents: 2,
            maxEvents: 10,
        });
        expect(store.latestResults.results).to.have.length(2);
        expect(store.armPerformanceRunContext?.runId).to.equal("r2");
    });

    it("retains strategy-level Asset rows on consensus re-sorts while grouping displayed rows by symbol", () => {
        const { store } = makeStore();
        const rows = [
            makeAssetRow("AAA", "alpha", 2.0),
            makeAssetRow("AAA", "beta", 1.0),
            makeAssetRow("BBB", "alpha", 3.0, { strategyCoverageCount: 5 }),
        ];
        store.assetOpportunityRunResults = [...rows];
        store.assetOpportunityDefaultResults = [...rows];
        store.setAssetOpportunityLatestResults(rows, false, 10);

        // Display is deduplicated by symbol: AAA keeps its best row only.
        expect(store.latestResults.results).to.have.length(2);

        // A consensus (grouped) metric re-sorts the default rows but must NOT
        // overwrite the full strategy-level inventory.
        store.applyResortMetric("freshSignalLibraries");
        expect(store.assetOpportunityRunResults).to.have.length(3);
        const aaaRows = store.assetOpportunityRunResults.filter((row) => row.symbol === "AAA");
        expect(aaaRows.map((row) => row.strategyKey).sort()).to.deep.equal(["alpha", "beta"]);

        // A per-row metric re-sort replaces the working inventory with the
        // sorted full set.
        store.applyResortMetric("expectancy");
        expect(store.assetOpportunityRunResults[0]!.selectionResult.expectancy).to.be.greaterThan(
            store.assetOpportunityRunResults[store.assetOpportunityRunResults.length - 1]!.selectionResult.expectancy,
        );
    });

    it("stashes the run-sort baseline and reports resort options per scope", () => {
        const { store } = makeStore();
        store.setLatestResults({ scope: "current_chart", results: [makeCandidate({ threshold: 1 }, 10) as any] }, false);
        store.stashRunSortBaseline();
        expect(store.originalLatestResults).to.equal(store.latestResults);

        const chartOptions = store.getResortOptions().map((option) => option.value);
        expect(chartOptions).to.include("expectancy");
        expect(chartOptions).to.include("netProfit");

        store.setLatestResults({ scope: "arm_performance", results: [], runContext: null, inventoryComplete: true }, false);
        const armOptions = store.getResortOptions().map((option) => option.value);
        expect(armOptions).to.include("TOP_RAW");
        expect(armOptions).to.include("TOP_RAW_PROFIT_NOW");
    });

    it("clears inventories between runs without touching display limits", () => {
        const { store } = makeStore();
        store.setRunDisplayLimits(7);
        store.adoptArmPerformanceResults([makeArmCandidate(0, 1, 1)], { runId: "r1" } as any, true);
        store.symbolUniverseRunResults = [makeCandidate({ threshold: 1 }, 5)];
        store.armPerformanceApplyContext = { interval: "4h" } as any;

        store.resetForNewRun();

        expect(store.armPerformanceRunResults).to.deep.equal([]);
        expect(store.armPerformanceRunContext).to.equal(null);
        expect(store.armPerformanceApplyContext).to.equal(null);
        expect(store.armPerformanceInventoryComplete).to.equal(true);
        expect(store.symbolUniverseRunResults).to.deep.equal([]);
        expect(store.originalLatestResults).to.equal(null);
        expect(store.armPerformanceDisplayLimit).to.equal(7, "display limits are set explicitly at option read");
        expect(store.symbolUniverseDisplayLimit).to.equal(7);
    });
});
