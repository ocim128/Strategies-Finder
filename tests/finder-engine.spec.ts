import { expect } from "chai";
import { describe, it } from "node:test";
import { compareFinderResults, sortFinderResults } from "../lib/finder/finder-engine";
import { FinderResultRanker } from "../lib/finder/finder-result-ranker";
import { finderSortRequiresAdvancedAnalytics } from "../lib/finder/finder-runner-core";
import type { FinderMetric, FinderResult } from "../lib/types/finder";
import type { BacktestResult, TradeTimingQuality } from "../lib/types/strategies";

function makePolymarketResult(
    key: string,
    wins: number,
    scoredPredictions: number,
    expectancy: number,
    predictionsTaken: number,
    evalOverrides: Partial<NonNullable<FinderResult["polymarketEval"]>> = {}
): FinderResult {
    return {
        key,
        name: key,
        params: {},
        result: {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: predictionsTaken,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        },
        selectionResult: {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: predictionsTaken,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        },
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
        polymarketEval: {
            evaluatedEvents: 11_400,
            predictionsTaken,
            scoredPredictions,
            pricedPredictions: scoredPredictions,
            wins,
            losses: scoredPredictions - wins,
            skips: 0,
            winRate: wins / scoredPredictions,
            coverage: scoredPredictions / 11_400,
            longPredictions: 0,
            shortPredictions: 0,
            longWins: 0,
            shortWins: 0,
            longWinRate: 0,
            shortWinRate: 0,
            alwaysYesBaselineWinRate: 0.502,
            alwaysNoBaselineWinRate: 0.498,
            avgEntryPrice: 0.5,
            breakEvenWinRate: 0.5,
            expectancy,
            edgeVsBreakEven: 0,
            missingOutcomeRows: 0,
            ignoredSignals: 0,
            rows: [],
            ...evalOverrides,
        },
    };
}

function makeTimingQuality(entryScore: number, exitScore: number): TradeTimingQuality {
    return {
        entryScore,
        exitScore,
        entry: {
            horizons: [],
        },
        exit: {
            horizons: [],
            captureScore: null,
            averageGivebackPct: null,
            captureSampleSize: 0,
        },
    };
}

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        ...overrides,
    };
}

function makeAdvancedFinderResult(
    key: string,
    analytics: Partial<NonNullable<BacktestResult["performanceAnalytics"]>>,
): FinderResult {
    const result = makeBacktestResult({
        performanceAnalytics: {
            sortinoRatio: 0,
            calmarRatio: 0,
            sterlingRatio: 0,
            tailRatio: 0,
            skewness: 0,
            kurtosis: 0,
            valueAtRisk95: 0,
            conditionalValueAtRisk95: 0,
            ulcerIndex: 0,
            serenityIndex: 0,
            cagr: 0,
            confidenceLevelPct: 95,
            riskFreeRateAnnual: 0,
            sampleCount: 10,
            ...analytics,
        },
    });
    return {
        key,
        name: key,
        params: {},
        result,
        selectionResult: result,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

function makeTimingResult(
    key: string,
    rawTimingQuality: TradeTimingQuality,
    selectionTimingQuality: TradeTimingQuality
): FinderResult {
    return {
        key,
        name: key,
        params: {},
        result: makeBacktestResult({ tradeTimingQuality: rawTimingQuality }),
        selectionResult: makeBacktestResult({ tradeTimingQuality: selectionTimingQuality }),
        endpointAdjusted: true,
        endpointRemovedTrades: 1,
    };
}

describe("Finder timing-quality sorting", () => {
    it("uses endpoint-adjusted selection timing scores for Entry Score", () => {
        const rawLooksBetter = makeTimingResult(
            "raw_looks_better",
            makeTimingQuality(95, 10),
            makeTimingQuality(40, 10)
        );
        const adjustedLooksBetter = makeTimingResult(
            "adjusted_looks_better",
            makeTimingQuality(20, 10),
            makeTimingQuality(80, 10)
        );

        expect(sortFinderResults([rawLooksBetter, adjustedLooksBetter], ["entryScore"]).map((result) => result.key))
            .to.deep.equal(["adjusted_looks_better", "raw_looks_better"]);
    });

    it("sorts Exit Score higher first", () => {
        const weaker = makeTimingResult("weaker", makeTimingQuality(50, 20), makeTimingQuality(50, 35));
        const stronger = makeTimingResult("stronger", makeTimingQuality(50, 10), makeTimingQuality(50, 72));

        expect(compareFinderResults(stronger, weaker, ["exitScore"])).to.be.lessThan(0);
        expect(sortFinderResults([weaker, stronger], ["exitScore"]).map((result) => result.key)).to.deep.equal([
            "stronger",
            "weaker",
        ]);
    });
});

describe("Finder advanced analytics execution contract", () => {
    it("requires full analytics only when an advanced analytics metric is selected", () => {
        expect(finderSortRequiresAdvancedAnalytics(["netProfit", "sharpeRatio"])).to.equal(false);
        expect(finderSortRequiresAdvancedAnalytics(["sortinoRatio"])).to.equal(true);
        expect(finderSortRequiresAdvancedAnalytics(["conditionalValueAtRisk95"])).to.equal(true);
    });
});

describe("Finder Polymarket sorting", () => {
    it("ranks stronger balanced-score candidates ahead of weaker ones", () => {
        const sortPriority: FinderMetric[] = ["polyScore", "polyWinRate", "polyPredictions"];
        const first = makePolymarketResult("first", 1614, 2426, 0.178, 2950);
        const second = makePolymarketResult("second", 1614, 2426, 0.178, 2950);
        const stronger = makePolymarketResult("stronger", 1707, 2517, 0.19, 3078);

        expect(compareFinderResults(stronger, first, sortPriority)).to.be.lessThan(0);
        expect(sortFinderResults([first, second, stronger], sortPriority).map((result) => result.key)).to.deep.equal([
            "stronger",
            "first",
            "second",
        ]);

        const ranker = new FinderResultRanker(10, sortPriority);
        ranker.offer(first);
        ranker.offer(second);
        ranker.offer(stronger);

        expect(ranker.toSortedArray(10).map((result) => result.key)).to.deep.equal([
            "stronger",
            "first",
            "second",
        ]);
    });

    it("uses profit-factor balance to reward broader priced-trade coverage", () => {
        const sortPriority: FinderMetric[] = ["polyProfitFactorBalance", "polyProfitFactor", "polyPredictions"];
        const sparse = makePolymarketResult("sparse", 1, 1, 0.9, 1, {
            profitFactor: Infinity,
            grossProfit: 0.9,
            grossLoss: 0,
        });
        const steadier = makePolymarketResult("steadier", 2, 3, 0.26666666666666666, 3, {
            profitFactor: 2,
            grossProfit: 1.6,
            grossLoss: 0.8,
        });

        expect(compareFinderResults(steadier, sparse, sortPriority)).to.be.lessThan(0);
        expect(sortFinderResults([sparse, steadier], sortPriority).map((result) => result.key)).to.deep.equal([
            "steadier",
            "sparse",
        ]);
    });

    it("does not let near-breakeven PF dominate purely on huge trade counts", () => {
        const sortPriority: FinderMetric[] = ["polyProfitFactorBalance", "polyProfitFactor", "totalTrades", "polyPredictions"];
        const lowEdgeLargeSample = makePolymarketResult("low_edge_large_sample", 2094, 4126, 0.008, 4686, {
            profitFactor: 1.03,
            grossProfit: 2094,
            grossLoss: 2032,
            pricedPredictions: 4126,
        });
        const strongerPfModerateSample = makePolymarketResult("stronger_pf_moderate_sample", 180, 300, 0.12, 340, {
            profitFactor: 1.35,
            grossProfit: 270,
            grossLoss: 200,
            pricedPredictions: 300,
        });

        expect(compareFinderResults(strongerPfModerateSample, lowEdgeLargeSample, sortPriority)).to.be.lessThan(0);
        expect(sortFinderResults([lowEdgeLargeSample, strongerPfModerateSample], sortPriority).map((result) => result.key)).to.deep.equal([
            "stronger_pf_moderate_sample",
            "low_edge_large_sample",
        ]);
    });

    it("ranks by sized net when Polymarket sized-net mode is selected", () => {
        const sortPriority: FinderMetric[] = ["polySizedNet", "polyPredictions", "polyWinRate"];
        const smallerSizedNet = makePolymarketResult("smaller_sized_net", 60, 100, 0.1, 100, {
            sizedNetProfit: 25,
        });
        const largerSizedNet = makePolymarketResult("larger_sized_net", 52, 100, 0.02, 100, {
            sizedNetProfit: 75,
        });

        expect(compareFinderResults(largerSizedNet, smallerSizedNet, sortPriority)).to.be.lessThan(0);
        expect(sortFinderResults([smallerSizedNet, largerSizedNet], sortPriority).map((result) => result.key))
            .to.deep.equal(["larger_sized_net", "smaller_sized_net"]);
    });

    it("pushes missing sized-net values behind real sized-net losses", () => {
        const sortPriority: FinderMetric[] = ["polySizedNet", "polyPredictions", "polyWinRate"];
        const missingSizedNet = makePolymarketResult("missing_sized_net", 70, 100, 0.1, 100);
        const losingSizedNet = makePolymarketResult("losing_sized_net", 40, 100, -0.1, 100, {
            sizedNetProfit: -25,
        });

        expect(sortFinderResults([missingSizedNet, losingSizedNet], sortPriority).map((result) => result.key))
            .to.deep.equal(["losing_sized_net", "missing_sized_net"]);
    });
});

describe("Finder advanced analytics sorting", () => {
    it("ranks advanced performance metrics and applies lower-is-better risk direction", () => {
        const stronger = makeAdvancedFinderResult("stronger", {
            sortinoRatio: 1.8,
            valueAtRisk95: 4,
        });
        const weaker = makeAdvancedFinderResult("weaker", {
            sortinoRatio: 0.4,
            valueAtRisk95: 12,
        });

        expect(sortFinderResults([weaker, stronger], ["sortinoRatio"]).map((item) => item.key))
            .to.deep.equal(["stronger", "weaker"]);
        expect(sortFinderResults([weaker, stronger], ["valueAtRisk95"]).map((item) => item.key))
            .to.deep.equal(["stronger", "weaker"]);
    });
});
