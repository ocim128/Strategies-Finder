import { expect } from "chai";
import { describe, it } from "node:test";
import {
    BARRIER_EXIT_SHARE_METRIC,
    calculateAssetOpportunityDerivedMetrics,
    calculateBarrierExitShare,
    calculateEntryHourConcentration,
    calculateEntryPriceRegimeMembership,
    calculateEquityPathLinearity,
    calculateTopDecileProfitShare,
    calculateTradeGapUniformity,
    calculateWinnerLoserHoldGapBars,
    ENTRY_HOUR_CONCENTRATION_METRIC,
    ENTRY_PRICE_REGIME_MEMBERSHIP_METRIC,
    EQUITY_PATH_LINEARITY_METRIC,
    getAssetOpportunityResortMetrics,
    PRIOR_TUPLE_RECURRENCE_METRIC,
    STRATEGY_COVERAGE_GATE_METRIC,
    TOP_DECILE_PROFIT_SHARE_METRIC,
    TRADE_GAP_UNIFORMITY_METRIC,
    WINNER_LOSER_HOLD_GAP_BARS_METRIC,
    sortAssetOpportunityResultsByMetric,
} from "../lib/finder/finder-asset-opportunity-metrics";
import {
    buildAssetOpportunityTupleKey,
    countPriorAssetOpportunityTupleRecurrence,
} from "../lib/finder/server/finder-asset-opportunity-archive";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";
import type { OHLCVData, Trade } from "../lib/types/strategies";

function candles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (1_700_000_000 + index * 60) as any,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1,
    }));
}

function thesisTrades(data: OHLCVData[]): Trade[] {
    return Array.from({ length: 10 }, (_, index) => ({
        id: index,
        type: "long" as const,
        entryTime: data[index * 2]!.time,
        entryPrice: 100 + index,
        exitTime: data[index * 2 + (index < 5 ? 1 : 3)]!.time,
        exitPrice: 100,
        pnl: index < 5 ? 1 : -1,
        pnlPercent: index < 5 ? 1 : -1,
        size: 1,
        exitReason: index < 5 ? "take_profit" as const : "stop_loss" as const,
    }));
}

function makeAsset(
    symbol: string,
    strategyKey: string,
    overrides: Partial<FinderAssetOpportunityResult> = {},
): FinderAssetOpportunityResult {
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
        selectionResult: {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 50,
            expectancy: 1,
            avgTrade: 1,
            profitFactor: 1,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 10,
            winningTrades: 1,
            losingTrades: 1,
            avgWin: 1,
            avgLoss: 1,
            sharpeRatio: 1,
            equityCurve: [],
        },
        support: {
            freshLongCandidates: 1,
            freshShortCandidates: 0,
            freshSameDirection: 1,
            poolSize: 1,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
        ...overrides,
    };
}

describe("Asset Opportunity thesis scalars", () => {
    it("calculates all trade-history theses from completed IS trades", () => {
        const data = candles(30);
        const trades = thesisTrades(data);
        const result = { trades, totalTrades: trades.length };

        expect(calculateBarrierExitShare(result)).to.equal(1);
        expect(calculateEntryHourConcentration(result)).to.be.closeTo(1, 1e-12);
        expect(calculateTradeGapUniformity(result, data)).to.equal(Number.POSITIVE_INFINITY);
        expect(calculateTopDecileProfitShare(result)).to.equal(0.1);
        expect(calculateWinnerLoserHoldGapBars(result, data)).to.equal(-2);
        expect(calculateEntryPriceRegimeMembership(result, 105)).to.equal(0.8);
        expect(calculateEquityPathLinearity(result)).to.be.greaterThan(0);
        expect(calculateAssetOpportunityDerivedMetrics({
            result,
            candles: data,
            freshEntryPrice: 105,
        }).medianBarsToTp).to.equal(1);
    });

    it("uses explicit minimum-sample sentinels for the scalar sorts", () => {
        const data = candles(30);
        const trades = thesisTrades(data).slice(0, 3);
        const result = { trades, totalTrades: trades.length };
        expect(calculateBarrierExitShare(result)).to.equal(null);
        expect(calculateEntryHourConcentration(result)).to.equal(null);
        expect(calculateTradeGapUniformity(result, data)).to.equal(null);
        expect(calculateTopDecileProfitShare(result)).to.equal(null);
        expect(calculateEntryPriceRegimeMembership(result, 105)).to.equal(null);
        expect(calculateEquityPathLinearity(result)).to.equal(null);
    });
});

describe("Asset Opportunity thesis resort ordering", () => {
    it("sorts scalar theses in their stated direction and leaves invalid rows last", () => {
        const invalid = makeAsset("INVALID", "k");
        const broad = makeAsset("BROAD", "k", { topDecileProfitShare: 0.2 });
        const concentrated = makeAsset("CONCENTRATED", "k", { topDecileProfitShare: 0.8 });
        const sorted = sortAssetOpportunityResultsByMetric(
            [invalid, concentrated, broad],
            TOP_DECILE_PROFIT_SHARE_METRIC,
        );
        expect(sorted.map((result) => result.symbol)).to.deep.equal(["BROAD", "CONCENTRATED", "INVALID"]);

        const fastWinners = makeAsset("FAST", "k", { winnerLoserHoldGapBars: -3 });
        const slowWinners = makeAsset("SLOW", "k", { winnerLoserHoldGapBars: 2 });
        expect(sortAssetOpportunityResultsByMetric(
            [slowWinners, fastWinners],
            WINNER_LOSER_HOLD_GAP_BARS_METRIC,
        ).map((result) => result.symbol)).to.deep.equal(["FAST", "SLOW"]);

        const regular = makeAsset("REGULAR", "k", { tradeGapUniformity: Number.POSITIVE_INFINITY });
        const jittered = makeAsset("JITTERED", "k", { tradeGapUniformity: 1 });
        expect(sortAssetOpportunityResultsByMetric(
            [jittered, regular],
            TRADE_GAP_UNIFORMITY_METRIC,
        ).map((result) => result.symbol)).to.deep.equal(["REGULAR", "JITTERED"]);
    });

    it("gates coverage at three distinct strategies and keeps the grade winner", () => {
        const coverageRows = [
            makeAsset("AAA", "z", { grade: "reject", selectionResult: { ...makeAsset("x", "x").selectionResult, profitFactor: 99 } }),
            makeAsset("AAA", "a", { grade: "select", selectionResult: { ...makeAsset("x", "x").selectionResult, profitFactor: 1 } }),
            makeAsset("AAA", "m", { grade: "watch", selectionResult: { ...makeAsset("x", "x").selectionResult, profitFactor: 2 } }),
            makeAsset("BBB", "a", { selectionResult: { ...makeAsset("x", "x").selectionResult, profitFactor: 3 } }),
            makeAsset("BBB", "b"),
            makeAsset("BBB", "c"),
            makeAsset("CCC", "a"),
            makeAsset("CCC", "b"),
        ];
        const sorted = sortAssetOpportunityResultsByMetric(coverageRows, STRATEGY_COVERAGE_GATE_METRIC);
        expect(sorted.map((result) => result.symbol)).to.deep.equal(["BBB", "AAA"]);
        expect(sorted.find((result) => result.symbol === "AAA")?.strategyKey).to.equal("a");
        expect(sorted.find((result) => result.symbol === "AAA")?.strategyCoverageCount).to.equal(3);
        expect(coverageRows).to.have.length(8);
    });

    it("exposes the barrier resort key", () => {
        const result = makeAsset("A", "k", { barrierExitShare: 0.5 });
        expect(sortAssetOpportunityResultsByMetric([result], BARRIER_EXIT_SHARE_METRIC)[0]).to.equal(result);
        expect(ENTRY_HOUR_CONCENTRATION_METRIC).to.equal("entryHourConcentration");
        expect(ENTRY_PRICE_REGIME_MEMBERSHIP_METRIC).to.equal("entryPriceRegimeMembership");
        expect(EQUITY_PATH_LINEARITY_METRIC).to.equal("equityPathLinearity");
        expect(getAssetOpportunityResortMetrics()).to.include.members([
            PRIOR_TUPLE_RECURRENCE_METRIC,
            STRATEGY_COVERAGE_GATE_METRIC,
            BARRIER_EXIT_SHARE_METRIC,
            ENTRY_HOUR_CONCENTRATION_METRIC,
            TRADE_GAP_UNIFORMITY_METRIC,
            TOP_DECILE_PROFIT_SHARE_METRIC,
            WINNER_LOSER_HOLD_GAP_BARS_METRIC,
            ENTRY_PRICE_REGIME_MEMBERSHIP_METRIC,
            EQUITY_PATH_LINEARITY_METRIC,
        ]);
    });
});

describe("Asset Opportunity prior tuple recurrence", () => {
    it("counts only matching tuples from strictly earlier cutoffs", () => {
        const result = makeAsset("AAA", "strategy");
        const tupleKey = buildAssetOpportunityTupleKey(result);
        const snapshots = [
            { timestamp: "t1", batchRunId: "old", holdoutBars: 10, tupleKeys: new Set([tupleKey]) },
            { timestamp: "t2", batchRunId: "old", holdoutBars: 5, tupleKeys: new Set([tupleKey]) },
        ];
        expect(countPriorAssetOpportunityTupleRecurrence({ result, currentHoldoutBars: 5, snapshots })).to.equal(1);
        expect(countPriorAssetOpportunityTupleRecurrence({ result, currentHoldoutBars: 10, snapshots })).to.equal(0);
        expect(sortAssetOpportunityResultsByMetric(
            [makeAsset("A", "k", { priorTupleRecurrenceCount: 2 }), makeAsset("B", "k", { priorTupleRecurrenceCount: 0 })],
            PRIOR_TUPLE_RECURRENCE_METRIC,
        ).map((item) => item.symbol)).to.deep.equal(["A", "B"]);
    });
});
