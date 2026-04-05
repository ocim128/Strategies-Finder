import { expect } from "chai";
import { describe, it } from "node:test";
import { compareFinderResults, sortFinderResults } from "./lib/finder/finder-engine";
import { FinderResultRanker } from "./lib/finder/finder-result-ranker";
import type { FinderMetric, FinderResult } from "./lib/types/finder";

function makePolymarketResult(
    key: string,
    wins: number,
    scoredPredictions: number,
    expectancy: number,
    predictionsTaken: number
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
        },
    };
}

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
});
