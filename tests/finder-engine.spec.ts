import { expect } from "chai";
import { describe, it } from "node:test";
import { compareFinderResults, sortFinderResults } from "../lib/finder/finder-engine";
import type { FinderResult } from "../lib/types/finder";
import type { BacktestResult, TradeTimingQuality } from "../lib/types/strategies";

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
