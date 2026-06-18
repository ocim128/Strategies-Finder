import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildFinderOptions,
    buildFinderUniverseOptions,
    resolveFinderPolymarketExitMode,
    resolveFinderSortPriority,
    resolveFinderUniverseSortPriority,
    sliceFinderDataWindow,
} from "./lib/finder/finder-manager-logic";

describe("Finder manager logic", () => {
    it("slices Finder data into fifths with the fifth slice ending at the newest bar", () => {
        const data = Array.from({ length: 50_000 }, (_, index) => index);

        expect(sliceFinderDataWindow(data, "1")).to.deep.equal(data.slice(0, 10_000));
        expect(sliceFinderDataWindow(data, "2")).to.deep.equal(data.slice(10_000, 20_000));
        expect(sliceFinderDataWindow(data, "5")).to.deep.equal(data.slice(40_000));
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
            polymarketScoringEnabled: true,
            polymarketRankMode: "balanced",
            polymarketMinScoredPredictions: -5,
            polymarketLockOffset: true,
            polymarketAfterTakeProfitOnly: true,
        });

        expect(options.sortPriority).to.deep.equal(["polyScore", "polyWinRate", "polyPredictions"]);
        expect(options.dataSlice).to.equal("5");
        expect(options.maxTrades).to.equal(30);
        expect(options.freezeRiskManagement).to.equal(true);
        expect(options.polymarketMinScoredPredictions).to.equal(0);
        expect(options.polymarketLockOffset).to.equal(true);
        expect(options.polymarketAfterTakeProfitOnly).to.equal(true);
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
        expect(resolveFinderPolymarketExitMode({
            requestedMode: "signal_exit_same_event",
            interval: "1m",
            executionModel: "next_open",
            polymarketAnnotationEnabled: true,
        })).to.equal("signal_exit_same_event");
    });

    it("keeps finder polymarket exit mode on resolve_hold for supported 1s CLOB runs", () => {
        expect(resolveFinderPolymarketExitMode({
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
