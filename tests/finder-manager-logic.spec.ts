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
        });

        expect(sortPriority).to.deep.equal(["expectancy", "profitFactor", "netProfit"]);
    });

    it("supports simple timing-score sort priority with stable netProfit fallback", () => {
        const sortPriority = resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "entryScore",
            secondarySort: "exitScore",
        });

        expect(sortPriority).to.deep.equal(["entryScore", "exitScore", "netProfit"]);
    });

    it("keeps advanced default priority unchanged unless timing scores are selected", () => {
        expect(resolveFinderSortPriority({
            useAdvancedSort: true,
            advancedSortValues: [],
            primarySort: "entryScore",
            secondarySort: "exitScore",
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
        })).to.deep.equal(["entryScore", "exitScore", "expectancy"]);
    });

    it("keeps path-exit randomization even when risk settings are frozen", () => {
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
        };

        // No freeze → randomize honored.
        expect(buildFinderOptions({
            ...base,
            freezeRiskManagement: false,
            randomizePathExitParams: true,
        }).randomizePathExitParams).to.equal(true);

        // Freeze does not force randomize off: users can freeze the
        // ATR/SL/TP/maxHold risk controls and still let Finder vary path-exit
        // controls. The runner-core functions gate the path-exit pathway
        // themselves; the options flag must pass through.
        expect(buildFinderOptions({
            ...base,
            freezeRiskManagement: true,
            randomizePathExitParams: true,
        }).randomizePathExitParams).to.equal(true);

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
