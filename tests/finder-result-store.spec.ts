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
        horizon: 5,
        params: { threshold: ordinal + 1 },
        backtestSettings: { executionModel: "signal_close" } as any,
        pairCoverage: { requestedPairs: 2, completedPairs: 2, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
        metrics: metrics as FinderArmPerformanceCandidate["metrics"],
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
        expect(store.armPerformanceDefaultResults).to.deep.equal([]);
        expect(store.armPerformanceRunContext).to.equal(null);
        expect(store.armPerformanceApplyContext).to.equal(null);
        expect(store.armPerformanceInventoryComplete).to.equal(true);
        expect(store.symbolUniverseRunResults).to.deep.equal([]);
        expect(store.originalLatestResults).to.equal(null);
        expect(store.armPerformanceDisplayLimit).to.equal(7, "display limits are set explicitly at option read");
        expect(store.symbolUniverseDisplayLimit).to.equal(7);
    });
});
