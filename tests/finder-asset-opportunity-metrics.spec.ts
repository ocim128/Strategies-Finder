/**
 * Tests for the Asset Opportunity metrics module
 * (`lib/finder/finder-asset-opportunity-metrics.ts`).
 *
 * Verifies:
 *   - top-K support counts (fresh long, fresh short, fresh same-direction,
 *     best fresh rank, direction-agreement ratio)
 *   - decision grading (select / watch / reject) against the explicit gates
 *   - lexicographic asset ranking (grade → bestFreshRank → same-direction
 *     support → expectancy → trades → symbol)
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeAssetSupportCounts,
    decideAssetGrade,
    compareAssetOpportunityResults,
    sortAssetOpportunityResults,
    sortAssetOpportunityResultsByMetric,
    getAssetOpportunityResortMetrics,
    type AssetPoolCandidate,
} from "../lib/finder/finder-asset-opportunity-metrics";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";

function poolCandidate(args: {
    rank: number;
    freshStatus: AssetPoolCandidate["freshStatus"];
    direction: AssetPoolCandidate["direction"];
}): AssetPoolCandidate {
    return { ...args, isOpen: false };
}

describe("Asset Opportunity support counts", () => {
    it("counts fresh long and fresh short candidates separately", () => {
        const counts = computeAssetSupportCounts({
            winnerDirection: "long",
            pool: [
                poolCandidate({ rank: 1, freshStatus: "fresh", direction: "long" }),
                poolCandidate({ rank: 2, freshStatus: "fresh", direction: "long" }),
                poolCandidate({ rank: 3, freshStatus: "fresh", direction: "short" }),
                poolCandidate({ rank: 4, freshStatus: "active", direction: "long" }),
                poolCandidate({ rank: 5, freshStatus: "flat", direction: null }),
            ],
        });
        expect(counts.freshLongCandidates).to.equal(2);
        expect(counts.freshShortCandidates).to.equal(1);
        expect(counts.freshSameDirection).to.equal(2); // winner is long
        expect(counts.poolSize).to.equal(5);
        expect(counts.bestFreshRank).to.equal(1);
        expect(counts.directionAgreementRatio).to.be.closeTo(2 / 3, 1e-9);
    });

    it("returns null bestFreshRank when no fresh candidates exist", () => {
        const counts = computeAssetSupportCounts({
            winnerDirection: "long",
            pool: [
                poolCandidate({ rank: 1, freshStatus: "active", direction: "long" }),
                poolCandidate({ rank: 2, freshStatus: "flat", direction: null }),
            ],
        });
        expect(counts.bestFreshRank).to.equal(null);
        expect(counts.directionAgreementRatio).to.equal(0);
    });

    it("counts zero freshSameDirection when winner direction is null", () => {
        const counts = computeAssetSupportCounts({
            winnerDirection: null,
            pool: [
                poolCandidate({ rank: 1, freshStatus: "fresh", direction: "long" }),
                poolCandidate({ rank: 2, freshStatus: "fresh", direction: "short" }),
            ],
        });
        expect(counts.freshSameDirection).to.equal(0);
    });
});

describe("Asset Opportunity decision grades", () => {
    const baseInput = {
        hasFreshEntry: true,
        hasPositiveExpectancy: true,
        historicalTrades: 50,
        sameDirectionSupport: 5,
        minHistoricalTrades: 10,
        minFreshSupport: 2,
    };

    it("grades select when all gates pass", () => {
        expect(decideAssetGrade(baseInput)).to.equal("select");
    });

    it("grades reject when there is no fresh entry", () => {
        expect(decideAssetGrade({ ...baseInput, hasFreshEntry: false })).to.equal("reject");
    });

    it("grades reject when expectancy is non-positive", () => {
        expect(decideAssetGrade({ ...baseInput, hasPositiveExpectancy: false })).to.equal("reject");
    });

    it("grades reject when historical trades are below the minimum", () => {
        expect(decideAssetGrade({ ...baseInput, historicalTrades: 5 })).to.equal("reject");
    });

    it("grades reject when OOS verdict is fail", () => {
        expect(decideAssetGrade({ ...baseInput, oosVerdict: "fail" })).to.equal("reject");
    });

    it("grades watch when same-direction support is below the minimum", () => {
        expect(decideAssetGrade({ ...baseInput, sameDirectionSupport: 1 })).to.equal("watch");
    });

    it("grades watch when OOS verdict is inconclusive", () => {
        expect(decideAssetGrade({ ...baseInput, oosVerdict: "inconclusive" })).to.equal("watch");
    });

    it("grades select when OOS verdict is pass", () => {
        expect(decideAssetGrade({ ...baseInput, oosVerdict: "pass" })).to.equal("select");
    });
});

describe("Asset Opportunity lexicographic ranking", () => {
    function makeResult(args: {
        symbol: string;
        grade: FinderAssetOpportunityResult["grade"];
        bestFreshRank: number | null;
        freshSameDirection: number;
        expectancy: number;
        totalTrades: number;
    }): FinderAssetOpportunityResult {
        return {
            symbol: args.symbol,
            strategyKey: "k",
            strategyName: "K",
            params: {},
            historicalRank: args.bestFreshRank ?? 99,
            totalCandidatesEvaluated: 10,
            isHistoricalBest: (args.bestFreshRank ?? 99) === 1,
            freshStatus: "fresh",
            direction: "long",
            latestSignalTime: null,
            signalAgeBars: 0,
            fillTiming: "signal_close",
            selectionResult: {
                trades: [],
                netProfit: 0,
                netProfitPercent: 0,
                winRate: 0,
                expectancy: args.expectancy,
                avgTrade: 0,
                profitFactor: 0,
                maxDrawdown: 0,
                maxDrawdownPercent: 0,
                totalTrades: args.totalTrades,
                winningTrades: 0,
                losingTrades: 0,
                avgWin: 0,
                avgLoss: 0,
                sharpeRatio: 0,
                equityCurve: [],
            },
            support: {
                freshLongCandidates: args.freshSameDirection,
                freshShortCandidates: 0,
                freshSameDirection: args.freshSameDirection,
                poolSize: 10,
                bestFreshRank: args.bestFreshRank,
                directionAgreementRatio: 1,
            },
            grade: args.grade,
        };
    }

    it("orders select before watch before reject", () => {
        const reject = makeResult({ symbol: "B", grade: "reject", bestFreshRank: 1, freshSameDirection: 5, expectancy: 10, totalTrades: 100 });
        const watch = makeResult({ symbol: "C", grade: "watch", bestFreshRank: 5, freshSameDirection: 1, expectancy: 1, totalTrades: 50 });
        const select = makeResult({ symbol: "A", grade: "select", bestFreshRank: 9, freshSameDirection: 1, expectancy: 1, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([reject, watch, select]);
        expect(sorted.map((r) => r.grade)).to.deep.equal(["select", "watch", "reject"]);
    });

    it("within the same grade, orders by bestFreshRank ascending", () => {
        const a = makeResult({ symbol: "A", grade: "select", bestFreshRank: 3, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const b = makeResult({ symbol: "B", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([a, b]);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("within the same grade + rank, orders by same-direction support descending", () => {
        const a = makeResult({ symbol: "A", grade: "select", bestFreshRank: 1, freshSameDirection: 2, expectancy: 1, totalTrades: 10 });
        const b = makeResult({ symbol: "B", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([a, b]);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("within the same grade + rank + support, orders by expectancy descending", () => {
        const a = makeResult({ symbol: "A", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1.5, totalTrades: 10 });
        const b = makeResult({ symbol: "B", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 2.5, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([a, b]);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("uses symbol ascending as the deterministic tie-breaker", () => {
        const a = makeResult({ symbol: "Z", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const b = makeResult({ symbol: "A", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([a, b]);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "Z"]);
        // Sanity: comparator returns 0 for fully identical symbols.
        expect(compareAssetOpportunityResults(a, a)).to.equal(0);
    });

    it("treats null bestFreshRank as the worst rank", () => {
        const a = makeResult({ symbol: "A", grade: "select", bestFreshRank: null, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const b = makeResult({ symbol: "B", grade: "select", bestFreshRank: 1, freshSameDirection: 5, expectancy: 1, totalTrades: 10 });
        const sorted = sortAssetOpportunityResults([a, b]);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });
});

describe("Asset Opportunity post-run re-sort", () => {
    /**
     * Build a result with full control over the selectionResult scalar metrics
     * so the re-sort comparator can be exercised on any metric.
     */
    function makeResortResult(args: {
        symbol: string;
        grade?: FinderAssetOpportunityResult["grade"];
        netProfit?: number;
        netProfitPercent?: number;
        profitFactor?: number;
        sharpeRatio?: number;
        winRate?: number;
        maxDrawdownPercent?: number;
        expectancy?: number;
        avgWin?: number;
        totalTrades?: number;
    }): FinderAssetOpportunityResult {
        return {
            symbol: args.symbol,
            strategyKey: "k",
            strategyName: "K",
            params: {},
            historicalRank: 1,
            totalCandidatesEvaluated: 10,
            isHistoricalBest: true,
            freshStatus: "fresh",
            direction: "long",
            latestSignalTime: null,
            signalAgeBars: 0,
            fillTiming: "signal_close",
            selectionResult: {
                trades: [],
                netProfit: args.netProfit ?? 0,
                netProfitPercent: args.netProfitPercent ?? 0,
                winRate: args.winRate ?? 0,
                expectancy: args.expectancy ?? 0,
                avgTrade: 0,
                profitFactor: args.profitFactor ?? 0,
                maxDrawdown: 0,
                maxDrawdownPercent: args.maxDrawdownPercent ?? 0,
                totalTrades: args.totalTrades ?? 0,
                winningTrades: 0,
                losingTrades: 0,
                avgWin: args.avgWin ?? 0,
                avgLoss: 0,
                sharpeRatio: args.sharpeRatio ?? 0,
                equityCurve: [],
            },
            support: {
                freshLongCandidates: 1,
                freshShortCandidates: 0,
                freshSameDirection: 1,
                poolSize: 10,
                bestFreshRank: 1,
                directionAgreementRatio: 1,
            },
            grade: args.grade ?? "select",
        };
    }

    it("metric=null falls back to the grade-first lexicographic comparator", () => {
        const reject = makeResortResult({ symbol: "B", grade: "reject", netProfit: 9999 });
        const select = makeResortResult({ symbol: "A", grade: "select", netProfit: 1 });
        // Grade-first: select before reject regardless of netProfit.
        const sorted = sortAssetOpportunityResultsByMetric([reject, select], null);
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("sorts by netProfit descending, overriding grade", () => {
        // A reject with higher netProfit outranks a select with lower.
        const low = makeResortResult({ symbol: "A", grade: "select", netProfit: 100 });
        const high = makeResortResult({ symbol: "B", grade: "reject", netProfit: 5000 });
        const sorted = sortAssetOpportunityResultsByMetric([low, high], "netProfit");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("sorts by maxDrawdownPercent ascending (smaller drawdown is better)", () => {
        const deep = makeResortResult({ symbol: "A", maxDrawdownPercent: 50 });
        const shallow = makeResortResult({ symbol: "B", maxDrawdownPercent: 5 });
        const sorted = sortAssetOpportunityResultsByMetric([deep, shallow], "maxDrawdownPercent");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("uses symbol ascending as the tie-breaker when metrics are equal", () => {
        const z = makeResortResult({ symbol: "Z", sharpeRatio: 2.0 });
        const a = makeResortResult({ symbol: "A", sharpeRatio: 2.0 });
        const sorted = sortAssetOpportunityResultsByMetric([z, a], "sharpeRatio");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "Z"]);
    });

    it("does not mutate the input array", () => {
        const original = [
            makeResortResult({ symbol: "C", netProfit: 3 }),
            makeResortResult({ symbol: "A", netProfit: 1 }),
            makeResortResult({ symbol: "B", netProfit: 2 }),
        ];
        const originalOrder = original.map((r) => r.symbol);
        sortAssetOpportunityResultsByMetric(original, "netProfit");
        expect(original.map((r) => r.symbol), "input array is unchanged").to.deep.equal(originalOrder);
    });

    it("handles NaN values gracefully (treated as 0)", () => {
        const nan = makeResortResult({ symbol: "A", expectancy: Number.NaN });
        const zero = makeResortResult({ symbol: "B", expectancy: 0 });
        const positive = makeResortResult({ symbol: "C", expectancy: 1.5 });
        const sorted = sortAssetOpportunityResultsByMetric([nan, zero, positive], "expectancy");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["C", "A", "B"]);
    });

    it("getAssetOpportunityResortMetrics returns the expected metric list", () => {
        const metrics = getAssetOpportunityResortMetrics();
        expect(metrics).to.include("netProfit");
        expect(metrics).to.include("sharpeRatio");
        expect(metrics).to.include("maxDrawdownPercent");
        expect(metrics).to.include("expectancy");
        expect(metrics).to.include("profitFactor");
        expect(metrics).to.include("totalTrades");
    });
});
