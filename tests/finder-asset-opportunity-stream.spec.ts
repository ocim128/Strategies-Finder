import { expect } from "chai";
import { describe, it } from "node:test";
import {
    assertAssetResultIsScalar,
    toScalarAssetResult,
} from "../lib/finder/server/finder-stream-types";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";
import type { Time } from "../lib/types/strategies";

function makeAssetResult(): FinderAssetOpportunityResult {
    const backtest = {
        trades: [{ id: 1 }],
        equityCurve: [{ time: 1, value: 100 }],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 50,
        expectancy: 1,
        avgTrade: 1,
        profitFactor: 1.2,
        maxDrawdown: 2,
        maxDrawdownPercent: 1,
        totalTrades: 2,
        winningTrades: 1,
        losingTrades: 1,
        avgWin: 2,
        avgLoss: 1,
        sharpeRatio: 0.5,
    };
    return {
        symbol: "AAPL",
        strategyKey: "test",
        strategyName: "Test",
        params: { lookback: 5 },
        historicalRank: 1,
        totalCandidatesEvaluated: 10,
        isHistoricalBest: true,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: 1 as Time,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: backtest,
        support: {
            freshLongCandidates: 2,
            freshShortCandidates: 0,
            freshSameDirection: 2,
            poolSize: 10,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
    } as unknown as FinderAssetOpportunityResult;
}

describe("Asset Opportunity scalar stream contract", () => {
    it("strips nested trade and equity arrays before streaming", () => {
        const scalar = toScalarAssetResult(makeAssetResult());

        expect(scalar.selectionResult.trades).to.deep.equal([]);
        expect(scalar.selectionResult.equityCurve).to.deep.equal([]);
        expect(() => assertAssetResultIsScalar(scalar)).to.not.throw();
    });

    it("rejects forbidden arrays attached after scalar projection", () => {
        const scalar = toScalarAssetResult(makeAssetResult()) as FinderAssetOpportunityResult & { signals?: unknown[] };
        scalar.signals = [];
        expect(() => assertAssetResultIsScalar(scalar)).to.throw(/signals/);
    });
});
