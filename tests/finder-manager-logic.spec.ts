import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildFinderOptions,
    buildFinderUniverseOptions,
    computeFinderOosVerdict,
    matchesFinderTradeCountFilter,
    resolveFinderSortPriority,
    resolveFinderUniverseSortPriority,
    resolveOosDataSlice,
    sliceFinderDataWindow,
} from "../lib/finder/finder-manager-logic";
import { resolveEffectivePolymarketExitMode } from "../lib/polymarket-exit-mode";

describe("Finder manager logic", () => {
    it("matches Asset Opportunity trade counts inclusively and treats a missing max as unbounded", () => {
        const filter = {
            tradeFilterEnabled: true,
            minTrades: 2,
            maxTrades: 4,
        };

        expect(matchesFinderTradeCountFilter(1, filter)).to.equal(false);
        expect(matchesFinderTradeCountFilter(2, filter)).to.equal(true);
        expect(matchesFinderTradeCountFilter(4, filter)).to.equal(true);
        expect(matchesFinderTradeCountFilter(5, filter)).to.equal(false);
        expect(matchesFinderTradeCountFilter(100, {
            ...filter,
            maxTrades: null as unknown as number,
        })).to.equal(true);
        expect(matchesFinderTradeCountFilter(1, {
            ...filter,
            tradeFilterEnabled: false,
        })).to.equal(true);
    });

    it("slices Finder data into fifths with the fifth slice ending at the newest bar", () => {
        const data = Array.from({ length: 50_000 }, (_, index) => index);

        expect(sliceFinderDataWindow(data, "1")).to.deep.equal(data.slice(0, 10_000));
        expect(sliceFinderDataWindow(data, "2")).to.deep.equal(data.slice(10_000, 20_000));
        expect(sliceFinderDataWindow(data, "5")).to.deep.equal(data.slice(40_000));
    });

    it("slices Finder data into halves with the newest half ending at the newest bar", () => {
        const data = Array.from({ length: 50_000 }, (_, index) => index);

        expect(sliceFinderDataWindow(data, "half_oldest")).to.deep.equal(data.slice(0, 25_000));
        expect(sliceFinderDataWindow(data, "half_newest")).to.deep.equal(data.slice(25_000));
    });

    it("resolves the complementary OOS window only for half data slices", () => {
        expect(resolveOosDataSlice("half_oldest")).to.equal("half_newest");
        expect(resolveOosDataSlice("half_newest")).to.equal("half_oldest");
        expect(resolveOosDataSlice("all")).to.be.null;
        expect(resolveOosDataSlice("1")).to.be.null;
        expect(resolveOosDataSlice("5")).to.be.null;
    });

    it("passes OOS verdict only when OOS is profitable with enough trades", () => {
        // Profitable + enough trades -> pass
        expect(computeFinderOosVerdict({ oosNetProfit: 100, oosProfitFactor: 1.5, oosTotalTrades: 40, minTrades: 40 })).to.equal("pass");
        // Boundary: exactly zero net profit and PF 1.0 still passes
        expect(computeFinderOosVerdict({ oosNetProfit: 0, oosProfitFactor: 1.0, oosTotalTrades: 40, minTrades: 40 })).to.equal("pass");

        // Degraded -> fail
        expect(computeFinderOosVerdict({ oosNetProfit: -50, oosProfitFactor: 0.9, oosTotalTrades: 40, minTrades: 40 })).to.equal("fail");
        // Profitable but PF below 1.0 -> fail
        expect(computeFinderOosVerdict({ oosNetProfit: 10, oosProfitFactor: 0.95, oosTotalTrades: 40, minTrades: 40 })).to.equal("fail");

        // Too few OOS trades -> inconclusive regardless of profitability
        expect(computeFinderOosVerdict({ oosNetProfit: -1000, oosProfitFactor: 0.3, oosTotalTrades: 5, minTrades: 40 })).to.equal("inconclusive");
        // Zero-trade floor is clamped to 1 so at least one trade is required for pass/fail
        expect(computeFinderOosVerdict({ oosNetProfit: 100, oosProfitFactor: 2.0, oosTotalTrades: 0, minTrades: 0 })).to.equal("inconclusive");
    });

    it("keeps full Finder data when no fifth slice is selected", () => {
        const data = [1, 2, 3, 4, 5];

        expect(sliceFinderDataWindow(data, "all")).to.deep.equal(data);
    });

    it("builds simple sort priority with stable netProfit fallback", () => {
        const sortPriority = resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced",
        });

        expect(sortPriority).to.deep.equal(["expectancy", "profitFactor", "netProfit"]);
    });

    it("supports simple timing-score sort priority with stable netProfit fallback", () => {
        const sortPriority = resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "entryScore",
            secondarySort: "exitScore",
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced",
        });

        expect(sortPriority).to.deep.equal(["entryScore", "exitScore", "netProfit"]);
    });

    it("keeps advanced default priority unchanged unless timing scores are selected", () => {
        expect(resolveFinderSortPriority({
            useAdvancedSort: true,
            advancedSortValues: [],
            primarySort: "entryScore",
            secondarySort: "exitScore",
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced",
        })).to.deep.equal([
            "expectancy",
            "compositeEdgeRatio",
            "profitFactor",
            "totalTrades",
            "maxDrawdownPercent",
            "sharpeRatio",
            "averageGain",
            "winRate",
            "netProfitPercent",
            "netProfit",
        ]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: true,
            advancedSortValues: ["entryScore", "exitScore", "expectancy"],
            primarySort: "profitFactor",
            secondarySort: "totalTrades",
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced",
        })).to.deep.equal(["entryScore", "exitScore", "expectancy"]);
    });

    it("forces polymarket sort priority and freezes risk settings for scored runs", () => {
        const options = buildFinderOptions({
            useAdvancedSort: true,
            advancedSortValues: ["winRate", "netProfitPercent"],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            mode: "random",
            dataSlice: "5",
            topN: 12,
            steps: 4,
            rangePercent: 40,
            maxRuns: 250,
            tradeFilterEnabled: true,
            minTrades: 30,
            maxTrades: 10,
            freezeRiskManagement: false,
            randomizePathExitParams: true,
            polymarketScoringEnabled: true,
            polymarketRankMode: "balanced",
            polymarketMinScoredPredictions: -5,
            polymarketLockOffset: true,
            polymarketAfterTakeProfitOnly: true,
            polymarketExitMode: "resolve_hold",
        });

        expect(options.sortPriority).to.deep.equal(["polyScore", "polyWinRate", "polyPredictions"]);
        expect(options.dataSlice).to.equal("5");
        expect(options.maxTrades).to.equal(30);
        expect(options.freezeRiskManagement).to.equal(true);
        expect(options.randomizePathExitParams).to.equal(false);
        expect(options.polymarketMinScoredPredictions).to.equal(0);
        expect(options.polymarketLockOffset).to.equal(true);
        expect(options.polymarketAfterTakeProfitOnly).to.equal(true);
    });

    it("keeps path-exit randomization unless Polymarket scoring is on (freeze no longer disables it)", () => {
        const base = {
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy" as const,
            secondarySort: "profitFactor" as const,
            mode: "random" as const,
            dataSlice: "all" as const,
            topN: 10,
            steps: 3,
            rangePercent: 100,
            maxRuns: 100,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced" as const,
            polymarketMinScoredPredictions: 0,
            polymarketLockOffset: false,
            polymarketAfterTakeProfitOnly: false,
            polymarketExitMode: "resolve_hold" as const,
        };

        // No freeze, no Polymarket → randomize honored.
        expect(buildFinderOptions({
            ...base,
            freezeRiskManagement: false,
            randomizePathExitParams: true,
        }).randomizePathExitParams).to.equal(true);

        // Freeze alone no longer forces randomize off: users can freeze the
        // ATR/SL/TP/maxHold risk controls and still let Finder vary path-exit
        // controls. The runner-core functions gate the path-exit pathway
        // themselves; the options flag must pass through.
        expect(buildFinderOptions({
            ...base,
            freezeRiskManagement: true,
            randomizePathExitParams: true,
        }).randomizePathExitParams).to.equal(true);

        // Polymarket scoring remains incompatible with randomize.
        expect(buildFinderOptions({
            ...base,
            polymarketScoringEnabled: true,
            freezeRiskManagement: false,
            randomizePathExitParams: true,
        }).randomizePathExitParams).to.equal(false);
    });

    it("switches polymarket sort priority by selected rank mode", () => {
        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "accuracy",
        })).to.deep.equal(["polyWinRate", "polyPredictions", "polyCoverage"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "accuracyTrades",
        })).to.deep.equal(["polyWinRate", "totalTrades", "polyPredictions", "polyCoverage"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "volume",
        })).to.deep.equal(["polyWins", "polyPredictions", "polyWinRate"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "expectancy",
        })).to.deep.equal(["polyExpectancy", "polyWinRate", "polyPredictions"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "expectancyTrades",
        })).to.deep.equal(["polyExpectancyBalance", "polyExpectancy", "totalTrades", "polyPredictions", "polyWinRate"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "profitFactor",
        })).to.deep.equal(["polyProfitFactor", "polyPredictions", "polyWinRate"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "profitFactorTrades",
        })).to.deep.equal(["polyProfitFactorBalance", "polyProfitFactor", "totalTrades", "polyPredictions", "polyWinRate"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "sizedNet",
        })).to.deep.equal(["polySizedNet", "polyPredictions", "polyWinRate"]);
    });

    it("keeps finder polymarket exit mode on signal_exit_same_event when the current run snapshot supports it", () => {
        expect(resolveEffectivePolymarketExitMode({
            requestedMode: "signal_exit_same_event",
            interval: "1m",
            executionModel: "next_open",
            polymarketAnnotationEnabled: true,
        })).to.equal("signal_exit_same_event");
    });

    it("keeps finder polymarket exit mode on resolve_hold for supported 1s CLOB runs", () => {
        expect(resolveEffectivePolymarketExitMode({
            requestedMode: "resolve_hold",
            interval: "1s",
            executionModel: "next_open",
            polymarketAnnotationEnabled: true,
        })).to.equal("resolve_hold");
    });

    it("builds symbol-universe sort priority with deterministic fallbacks", () => {
        expect(resolveFinderUniverseSortPriority({
            primarySort: "profitableActiveRatio",
            secondarySort: "medianExpectancy",
        })).to.deep.equal([
            "profitableActiveRatio",
            "medianExpectancy",
            "worstNetProfit",
            "totalTrades",
        ]);

        expect(resolveFinderUniverseSortPriority({
            primarySort: "worstNetProfit",
            secondarySort: "worstNetProfit",
        })).to.deep.equal([
            "worstNetProfit",
            "totalTrades",
        ]);
    });

    it("clamps symbol-universe filters to valid ranges", () => {
        const universe = buildFinderUniverseOptions({
            symbols: ["BTCUSDT", "ETHUSDT"],
            minActiveSymbols: 0,
            minTotalTrades: -5,
            minProfitableActiveRatio: 2,
            primarySort: "profitableActiveRatio",
            secondarySort: "totalTrades",
        });

        expect(universe.minActiveSymbols).to.equal(1);
        expect(universe.minTotalTrades).to.equal(0);
        expect(universe.minProfitableActiveRatio).to.equal(1);
        expect(universe.sortPriority).to.deep.equal([
            "profitableActiveRatio",
            "totalTrades",
            "worstNetProfit",
        ]);
    });
});
