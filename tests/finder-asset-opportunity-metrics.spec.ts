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
    calculateMedianBarsToTp,
    computeAssetSupportCounts,
    decideAssetGrade,
    compareAssetOpportunityResults,
    deduplicateAssetOpportunityResultsBySymbol,
    sortAssetOpportunityResults,
    sortAssetOpportunityResultsByMetric,
    getAssetOpportunityResortMetrics,
    MEDIAN_BARS_TO_TP_METRIC,
    TOTAL_TRADES_CAPPED_METRIC,
    retainAssetOpportunityResultsForSymbols,
    type AssetPoolCandidate,
} from "../lib/finder/finder-asset-opportunity-metrics";
import { calculateFinderAssetOosAverageHorizonMetrics } from "../lib/finder/finder-asset-opportunity-oos";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";
import type { OHLCVData, StrategyParams, Time } from "../lib/types/strategies";

function assetResultForSymbol(symbol: string): FinderAssetOpportunityResult {
    return { symbol } as FinderAssetOpportunityResult;
}

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

describe("Asset Opportunity presentation rows", () => {
    it("keeps the first row for each normalized symbol", () => {
        const first = assetResultForSymbol("AAPL+SPY");
        const duplicate = assetResultForSymbol(" aapl+spy ");
        const other = assetResultForSymbol("MSFT+SPY");

        expect(deduplicateAssetOpportunityResultsBySymbol([first, duplicate, other]))
            .to.deep.equal([first, other]);
    });
});

describe("Asset Opportunity result universe", () => {
    it("drops stale rows that are not in the submitted asset list", () => {
        const retained = retainAssetOpportunityResultsForSymbols(
            [assetResultForSymbol("GEV•+AMD•"), assetResultForSymbol("GEV•+SNDK•")],
            ["gev•+sndk•"],
        );

        expect(retained.map((result) => result.symbol)).to.deep.equal(["GEV•+SNDK•"]);
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
        strategyKey?: string;
        params?: StrategyParams;
        grade?: FinderAssetOpportunityResult["grade"];
        netProfit?: number;
        netProfitPercent?: number;
        profitFactor?: number;
        sharpeRatio?: number;
        winRate?: number;
        maxDrawdownPercent?: number;
        expectancy?: number;
        avgWin?: number;
        avgLoss?: number;
        totalTrades?: number;
        medianBarsToTp?: number | null;
    }): FinderAssetOpportunityResult {
        return {
            symbol: args.symbol,
            strategyKey: args.strategyKey ?? "k",
            strategyName: "K",
            params: args.params ?? {},
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
                avgLoss: args.avgLoss ?? 0,
                sharpeRatio: args.sharpeRatio ?? 0,
                equityCurve: [],
            },
            ...(args.medianBarsToTp !== undefined ? { medianBarsToTp: args.medianBarsToTp } : {}),
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

    describe("medianBarsToTp", () => {
        function candles(count: number): OHLCVData[] {
            return Array.from({ length: count }, (_, index) => ({
                time: (1_700_000_000 + index * 60) as Time,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1,
            }));
        }

        it("calculates the median from in-sample TP-hit trade bar distances", () => {
            const data = candles(12);
            const result = {
                totalTrades: 4,
                trades: [
                    { entryTime: data[0]!.time, exitTime: data[2]!.time, exitReason: "take_profit" },
                    { entryTime: data[1]!.time, exitTime: data[5]!.time, exitReason: "take_profit" },
                    { entryTime: data[2]!.time, exitTime: data[8]!.time, exitReason: "take_profit" },
                    { entryTime: data[3]!.time, exitTime: data[4]!.time, exitReason: "signal" },
                ],
            } as any;
            expect(calculateMedianBarsToTp(result, data)).to.equal(4);
        });

        it("returns null for insufficient or invalid TP-hit observations", () => {
            const data = candles(6);
            const twoHits = {
                totalTrades: 2,
                trades: [
                    { entryTime: data[0]!.time, exitTime: data[1]!.time, exitReason: "take_profit" },
                    { entryTime: data[1]!.time, exitTime: data[3]!.time, exitReason: "take_profit" },
                ],
            } as any;
            const invalid = {
                totalTrades: 3,
                trades: [
                    { entryTime: data[0]!.time, exitTime: data[1]!.time, exitReason: "take_profit" },
                    { entryTime: data[3]!.time, exitTime: data[2]!.time, exitReason: "take_profit" },
                    { entryTime: data[1]!.time, exitTime: data[4]!.time, exitReason: "take_profit" },
                ],
            } as any;
            expect(calculateMedianBarsToTp(twoHits, data)).to.equal(null);
            expect(calculateMedianBarsToTp(invalid, data)).to.equal(null);
        });

        it("sorts quantified rows fast-first, invalid rows last, and ties by candidate tuple", () => {
            const fast = makeResortResult({ symbol: "PAIR", strategyKey: "z", medianBarsToTp: 2 });
            const slow = makeResortResult({ symbol: "PAIR", strategyKey: "z", medianBarsToTp: 5 });
            const tupleEarly = makeResortResult({ symbol: "pair", strategyKey: "a", medianBarsToTp: 2 });
            const missing = makeResortResult({ symbol: "MISSING" });
            const nan = makeResortResult({ symbol: "NAN", medianBarsToTp: Number.NaN });
            const original = [missing, slow, nan, fast, tupleEarly];
            const sorted = sortAssetOpportunityResultsByMetric(original, MEDIAN_BARS_TO_TP_METRIC);

            expect(sorted.map((result) => result.strategyKey + ":" + result.symbol)).to.deep.equal([
                "a:pair",
                "z:PAIR",
                "z:PAIR",
                "k:MISSING",
                "k:NAN",
            ]);
            expect(original.map((result) => result.symbol)).to.deep.equal([
                "MISSING", "PAIR", "NAN", "PAIR", "pair",
            ]);
        });

        it("exposes the metric in the shared resort inventory", () => {
            expect(getAssetOpportunityResortMetrics()).to.include(MEDIAN_BARS_TO_TP_METRIC);
        });
    });

    describe("totalTradesCapped", () => {
        it("saturates the elite at the percentile cap and contests ties by averageGain, not expectancy or netProfit", () => {
            // Trade counts [80, 90, 100, 2000, 2000] -> P90 (linear interp) lands
            // on 2000, so both elites tie at the cap. The elite with the larger
            // avgWin must win even though the other leads expectancy AND
            // netProfitPercent — those are deliberately not consulted.
            const low80 = makeResortResult({ symbol: "L1", totalTrades: 80 });
            const low90 = makeResortResult({ symbol: "L2", totalTrades: 90 });
            const low100 = makeResortResult({ symbol: "L3", totalTrades: 100 });
            const eliteProfit = makeResortResult({
                symbol: "E1", totalTrades: 2000, avgWin: 5, expectancy: 9, netProfitPercent: 50,
            });
            const eliteGain = makeResortResult({
                symbol: "E2", totalTrades: 2000, avgWin: 9, expectancy: 0.1, netProfitPercent: 1,
            });
            const sorted = sortAssetOpportunityResultsByMetric(
                [low80, low90, low100, eliteProfit, eliteGain],
                TOTAL_TRADES_CAPPED_METRIC,
            );
            expect(sorted.map((r) => r.symbol)).to.deep.equal(["E2", "E1", "L3", "L2", "L1"]);
        });

        it("still ranks below-cap trade counts like totalTrades", () => {
            // Counts [40, 90, 2000, 2000] -> cap 2000; both 2000s tie at the cap,
            // and below the cap the higher count still outranks the lower one.
            const few = makeResortResult({ symbol: "A", totalTrades: 40, avgWin: 99 });
            const more = makeResortResult({ symbol: "B", totalTrades: 90, avgWin: 1 });
            const elite = makeResortResult({ symbol: "C", totalTrades: 2000, avgWin: 2 });
            const eliteTwin = makeResortResult({ symbol: "D", totalTrades: 2000, avgWin: 3 });
            const sorted = sortAssetOpportunityResultsByMetric([few, more, elite, eliteTwin], TOTAL_TRADES_CAPPED_METRIC);
            expect(sorted.map((r) => r.symbol)).to.deep.equal(["D", "C", "B", "A"]);
        });

        it("falls back to symbol ascending when saturated count and averageGain both tie", () => {
            const z = makeResortResult({ symbol: "Z", totalTrades: 2000, avgWin: 7 });
            const a = makeResortResult({ symbol: "A", totalTrades: 2000, avgWin: 7 });
            const filler1 = makeResortResult({ symbol: "F1", totalTrades: 80 });
            const filler2 = makeResortResult({ symbol: "F2", totalTrades: 90 });
            const filler3 = makeResortResult({ symbol: "F3", totalTrades: 100 });
            const sorted = sortAssetOpportunityResultsByMetric([z, a, filler1, filler2, filler3], TOTAL_TRADES_CAPPED_METRIC);
            expect(sorted[0]?.symbol).to.equal("A");
            expect(sorted[1]?.symbol).to.equal("Z");
        });

        it("is exposed through the re-sort metric list", () => {
            expect(getAssetOpportunityResortMetrics()).to.include(TOTAL_TRADES_CAPPED_METRIC);
        });
    });

    it("recomputes each horizon average from the displayed result set after re-sort", () => {
        const withForwardValidation = (
            result: FinderAssetOpportunityResult,
            horizonValues: [number, number],
        ): FinderAssetOpportunityResult => ({
            ...result,
            oosHorizonMetrics: {
                ignoreLastBars: 2,
                horizons: [
                    { bars: 5, pnlPercent: horizonValues[0], averagePnlPercent: horizonValues[0], winRatePercent: 50, sampleSize: 2 },
                    { bars: 12, pnlPercent: horizonValues[1], averagePnlPercent: horizonValues[1], winRatePercent: 50, sampleSize: 2 },
                ],
            },
        });
        const netProfitLeader = withForwardValidation(
            makeResortResult({ symbol: "A", netProfit: 100, expectancy: 1 }),
            [10, 20],
        );
        const middle = withForwardValidation(
            makeResortResult({ symbol: "B", netProfit: 90, expectancy: 2 }),
            [0, 10],
        );
        const expectancyLeader = withForwardValidation(
            makeResortResult({ symbol: "C", netProfit: 80, expectancy: 3 }),
            [-10, -20],
        );

        const byNetProfit = sortAssetOpportunityResultsByMetric(
            [netProfitLeader, middle, expectancyLeader],
            "netProfit",
        );
        const byExpectancy = sortAssetOpportunityResultsByMetric(
            [netProfitLeader, middle, expectancyLeader],
            "expectancy",
        );

        expect(byNetProfit[0]?.symbol).to.equal("A");
        expect(byExpectancy[0]?.symbol).to.equal("C");
        expect(calculateFinderAssetOosAverageHorizonMetrics(
            byNetProfit.slice(0, 2).map((result) => result.oosHorizonMetrics),
        )).to.deep.equal([
            { bars: 5, averagePnlPercent: 5, sampleSize: 2 },
            { bars: 12, averagePnlPercent: 15, sampleSize: 2 },
        ]);
        expect(calculateFinderAssetOosAverageHorizonMetrics(
            byExpectancy.slice(0, 2).map((result) => result.oosHorizonMetrics),
        )).to.deep.equal([
            { bars: 5, averagePnlPercent: -5, sampleSize: 2 },
            { bars: 12, averagePnlPercent: -5, sampleSize: 2 },
        ]);
    });

    it("uses symbol ascending as the tie-breaker when metrics are equal", () => {
        const z = makeResortResult({ symbol: "Z", sharpeRatio: 2.0 });
        const a = makeResortResult({ symbol: "A", sharpeRatio: 2.0 });
        const sorted = sortAssetOpportunityResultsByMetric([z, a], "sharpeRatio");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "Z"]);
    });

    it("breaks maxDrawdownPercent ties by expectancy, not symbol", () => {
        // Small-maxHoldBars backtests often share maxDrawdownPercent = 0 (equity
        // never drew down), which used to collapse the top-N into an alphabetical
        // slice. The higher-evidenced z-symbol candidate must now outrank the
        // a-symbol one when both tie at the ascending optimum.
        const aName = makeResortResult({ symbol: "AAA•+SPY•", maxDrawdownPercent: 0, expectancy: 0.1, totalTrades: 5 });
        const zName = makeResortResult({ symbol: "ZZZ•+SPY•", maxDrawdownPercent: 0, expectancy: 2.5, totalTrades: 50 });
        const sorted = sortAssetOpportunityResultsByMetric([aName, zName], "maxDrawdownPercent");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["ZZZ•+SPY•", "AAA•+SPY•"]);
    });

    it("breaks sharpeRatio ties by expectancy, not symbol", () => {
        // Sharpe collapses to a common value across many short-hold candidates;
        // ties must fall back to realized expectancy rather than the ticker letter.
        const aName = makeResortResult({ symbol: "AAA•+SPY•", sharpeRatio: 1.2, expectancy: 0.2, totalTrades: 4 });
        const zName = makeResortResult({ symbol: "ZZZ•+SPY•", sharpeRatio: 1.2, expectancy: 3.0, totalTrades: 40 });
        const sorted = sortAssetOpportunityResultsByMetric([aName, zName], "sharpeRatio");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["ZZZ•+SPY•", "AAA•+SPY•"]);
    });

    it("falls through expectancy to netProfitPercent when breaking a metric tie", () => {
        // Locks the cascade depth: when the primary metric AND expectancy both
        // tie, netProfitPercent decides before symbol.
        const aName = makeResortResult({ symbol: "AAA•+SPY•", maxDrawdownPercent: 0, expectancy: 1, netProfitPercent: 5 });
        const zName = makeResortResult({ symbol: "ZZZ•+SPY•", maxDrawdownPercent: 0, expectancy: 1, netProfitPercent: 9 });
        const sorted = sortAssetOpportunityResultsByMetric([aName, zName], "maxDrawdownPercent");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["ZZZ•+SPY•", "AAA•+SPY•"]);
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
        expect(metrics).to.include("payoffRatio");
        expect(metrics).to.include("freshSignalLibraries");
        expect(metrics).to.include("tstatEdge");
        expect(metrics).to.include("invertedNetProfit");
        expect(metrics).to.include("invertedExpectancy");
        expect(metrics).to.include("invertedAverageGain");
        expect(metrics).to.include("invertedWinRate");
        expect(metrics).to.include("invertedSharpeRatio");
        expect(metrics).to.include("invertedProfitFactor");
        expect(metrics).to.include("invertedMaxDrawdownPercent");
    });

    it("sorts by tstatEdge so a proven modest edge outranks a bigger unproven edge", () => {
        // Why: the search optimizes size metrics, so size-sorted tops are overfit
        // extremes; significance (edge * sqrt(trades) / sd) must reward evidence.
        // A: expectancy 0.5 over 100 trades => t ~ 0.63.
        const proven = makeResortResult({ symbol: "A", expectancy: 0.5, winRate: 55, avgWin: 10, avgLoss: 5, totalTrades: 100 });
        // B: expectancy 2 over 5 trades => t ~ 0.44.
        const unproven = makeResortResult({ symbol: "B", expectancy: 2, winRate: 20, avgWin: 20, avgLoss: 5, totalTrades: 5 });
        const sorted = sortAssetOpportunityResultsByMetric([unproven, proven], "tstatEdge");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("tstatEdge treats an all-win zero-variance positive candidate as most significant", () => {
        const degenerate = makeResortResult({ symbol: "A", expectancy: 5, winRate: 100, avgWin: 5, avgLoss: 0, totalTrades: 10 });
        const varied = makeResortResult({ symbol: "B", expectancy: 3, winRate: 60, avgWin: 12, avgLoss: 6, totalTrades: 40 });
        const sorted = sortAssetOpportunityResultsByMetric([varied, degenerate], "tstatEdge");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("tstatEdge maps an all-win candidate to +Infinity regardless of sample size (run-level minTrades owns guarding)", () => {
        // Why (operator decision 2026-08-18): the run's minimum-trade filter is the
        // single owner of sample-size guarding; the sort stays a pure t-stat. The
        // all-win degenerate follows the payoffRatio precedent (+Infinity).
        const tinyAllWin = makeResortResult({ symbol: "A", expectancy: 16.94, winRate: 100, avgWin: 16.94, avgLoss: 0, totalTrades: 2 });
        const proven = makeResortResult({ symbol: "B", expectancy: 0.5, winRate: 55, avgWin: 10, avgLoss: 5, totalTrades: 100 });
        const sorted = sortAssetOpportunityResultsByMetric([proven, tinyAllWin], "tstatEdge");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("invertedNetProfit ranks worst-first (most negative netProfit at the top)", () => {
        // Why: the inverted archive sorts expose the true bottom of the full
        // candidate pool, testing whether in-search failure carries forward info.
        const loser = makeResortResult({ symbol: "A", netProfit: -500 });
        const winner = makeResortResult({ symbol: "B", netProfit: 5000 });
        const sorted = sortAssetOpportunityResultsByMetric([winner, loser], "invertedNetProfit");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("invertedExpectancy ranks worst-first and invertedAverageGain ranks smallest average win first", () => {
        const badEdge = makeResortResult({ symbol: "A", expectancy: -2, avgWin: 1 });
        const goodEdge = makeResortResult({ symbol: "B", expectancy: 3, avgWin: 12 });
        expect(sortAssetOpportunityResultsByMetric([goodEdge, badEdge], "invertedExpectancy").map((r) => r.symbol)).to.deep.equal(["A", "B"]);
        expect(sortAssetOpportunityResultsByMetric([goodEdge, badEdge], "invertedAverageGain").map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("invertedMaxDrawdownPercent ranks LARGEST drawdown first (base direction flips)", () => {
        // Why: the base DD sort is ascending (smallest best); worst-first means
        // descending — the one inverted metric whose direction must flip.
        const deepDD = makeResortResult({ symbol: "A", maxDrawdownPercent: 40 });
        const shallowDD = makeResortResult({ symbol: "B", maxDrawdownPercent: 5 });
        expect(sortAssetOpportunityResultsByMetric([shallowDD, deepDD], "invertedMaxDrawdownPercent").map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });

    it("invertedProfitFactor ranks an all-win (null PF) candidate LAST, not worst-first", () => {
        // Why: null PF means no losses — mapping it to 0 (old behavior) would
        // wrongly top the worst-first sort with the safest candidates.
        const allWin = makeResortResult({ symbol: "A", netProfit: 100, profitFactor: 1 });
        (allWin.selectionResult as { profitFactor: number | null }).profitFactor = null;
        const losing = makeResortResult({ symbol: "B", netProfit: -50, profitFactor: 0.3 });
        expect(sortAssetOpportunityResultsByMetric([allWin, losing], "invertedProfitFactor").map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("profitFactor treats a null PF all-win positive candidate as best in the normal direction", () => {
        const allWin = makeResortResult({ symbol: "A", netProfit: 100, profitFactor: 1 });
        (allWin.selectionResult as { profitFactor: number | null }).profitFactor = null;
        const finite = makeResortResult({ symbol: "B", netProfit: 80, profitFactor: 2.5 });
        expect(sortAssetOpportunityResultsByMetric([finite, allWin], "profitFactor").map((r) => r.symbol)).to.deep.equal(["A", "B"]);
    });




    it("sorts by payoffRatio descending (avgWin / avgLoss; larger is better)", () => {
        // Orthogonal to totalTrades: measures outcome asymmetry, not activity.
        const low = makeResortResult({ symbol: "A", avgWin: 10, avgLoss: 10 }); // payoff 1.0
        const high = makeResortResult({ symbol: "B", avgWin: 30, avgLoss: 10 }); // payoff 3.0
        const sorted = sortAssetOpportunityResultsByMetric([low, high], "payoffRatio");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("treats an all-win candidate (avgLoss = 0) as the best payoffRatio", () => {
        const finite = makeResortResult({ symbol: "A", avgWin: 5, avgLoss: 1 }); // payoff 5
        const allWin = makeResortResult({ symbol: "B", avgWin: 5, avgLoss: 0 }); // +Infinity
        const sorted = sortAssetOpportunityResultsByMetric([finite, allWin], "payoffRatio");
        expect(sorted.map((r) => r.symbol)).to.deep.equal(["B", "A"]);
    });

    it("groups the consensus resort by symbol and counts each strategy library once", () => {
        const makeConsensusResult = (symbol: string, strategyKey: string): FinderAssetOpportunityResult => ({
            ...makeResortResult({ symbol }),
            strategyKey,
        });
        const sorted = sortAssetOpportunityResultsByMetric([
            makeConsensusResult("AAPL•+NVDA•", "strategy_a"),
            makeConsensusResult("AAPL•+NVDA•", "strategy_a"),
            makeConsensusResult("AAPL•+NVDA•", "strategy_b"),
            makeConsensusResult("MSFT•+AMD•", "strategy_a"),
            makeConsensusResult("MSFT•+AMD•", "strategy_b"),
            makeConsensusResult("MSFT•+AMD•", "strategy_c"),
        ], "freshSignalLibraries");

        expect(sorted.map((result) => result.symbol)).to.deep.equal([
            "MSFT•+AMD•",
            "AAPL•+NVDA•",
        ]);
        expect(sorted.map((result) => result.freshSignalLibraryCount)).to.deep.equal([3, 2]);
    });

    it("freshSignalLibrariesByTrades breaks count ties by totalTrades, not expectancy", () => {
        // AAA and ZZZ both have freshSignalLibraryCount = 2. AAA's winner has
        // higher expectancy but fewer trades; ZZZ's has lower expectancy but more
        // trades. By-Trades must rank ZZZ first (totalTrades), even though the
        // plain freshSignalLibraries order (grade-first comparator) would put AAA
        // first on expectancy.
        const mk = (symbol: string, strategyKey: string, expectancy: number, totalTrades: number): FinderAssetOpportunityResult => ({
            ...makeResortResult({ symbol, grade: "select", expectancy, totalTrades }),
            strategyKey,
        });
        const results: FinderAssetOpportunityResult[] = [
            mk("AAA•+SPY•", "lib_a1", 5, 10),
            mk("AAA•+SPY•", "lib_a2", 5, 10),
            mk("ZZZ•+SPY•", "lib_b1", 1, 50),
            mk("ZZZ•+SPY•", "lib_b2", 1, 50),
            mk("MMM•+SPY•", "lib_c1", 9, 1),
        ];
        const byTrades = sortAssetOpportunityResultsByMetric(results, "freshSignalLibrariesByTrades");
        expect(byTrades.map((r) => r.symbol)).to.deep.equal(["ZZZ•+SPY•", "AAA•+SPY•", "MMM•+SPY•"]);
        expect(byTrades.map((r) => r.freshSignalLibraryCount)).to.deep.equal([2, 2, 1]);

        // Sanity: plain freshSignalLibraries orders the count-2 tie by expectancy
        // (AAA 5 > ZZZ 1), so AAA first — the opposite ordering.
        const plain = sortAssetOpportunityResultsByMetric(results, "freshSignalLibraries");
        expect(plain.map((r) => r.symbol)).to.deep.equal(["AAA•+SPY•", "ZZZ•+SPY•", "MMM•+SPY•"]);
    });
});
