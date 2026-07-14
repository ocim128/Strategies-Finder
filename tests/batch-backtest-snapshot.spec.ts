import { expect } from "chai";
import { describe, it } from "node:test";
import {
    BATCH_RESULT_SNAPSHOT_LIMIT,
    compactBatchBacktestResultsSnapshot,
    normalizeBatchBacktestResultsSnapshot,
} from "../lib/batch-backtest/batch-backtest-snapshot";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";

function makeData(): OHLCVData[] {
    return [
        { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { time: 2 as Time, open: 110, high: 111, low: 109, close: 110, volume: 1 },
    ];
}

function makeResult(index: number): BatchBacktestSymbolResult {
    const result: BacktestResult = {
        trades: [
            {
                id: index,
                type: "long",
                entryTime: 1 as Time,
                entryPrice: 100,
                exitTime: 2 as Time,
                exitPrice: 110,
                pnl: 10,
                pnlPercent: 10,
                size: 1,
                exitReason: "end_of_data",
            },
        ],
        netProfit: index,
        netProfitPercent: 10,
        winRate: 100,
        expectancy: 10,
        avgTrade: 10,
        profitFactor: Infinity,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 10,
        avgLoss: 0,
        sharpeRatio: 1,
        equityCurve: [{ time: 1 as Time, value: 1_000 }],
    };
    return {
        symbol: "WLD+BTC",
        status: "profitable",
        barCount: 2,
        firstTime: 1 as Time,
        lastTime: 2 as Time,
        result,
        data: makeData(),
        signals: [{ time: 1 as Time, type: "buy" } as Signal],
    };
}

describe("Batch backtest result snapshots", () => {
    it("keeps snapshots bounded and strips heavy row arrays", () => {
        const snapshot = compactBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "5m",
            fingerprint: "abc",
            strategyKey: "rolling_vwap_center",
            serverHasArtifacts: true,
            results: Array.from({ length: BATCH_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeResult(index)),
            stabilityResult: {
                reruns: 20,
                subsetSize: 5,
                seed: 1,
                totalPairs: 10,
                targetAssets: 1,
                hitEvents: 1,
                engine: "typescript_parallel",
                rows: [
                    {
                        asset: "wld",
                        direction: "LONG",
                        hits: 1,
                        high: 1,
                        medium: 0,
                        low: 0,
                        medianRetPct: 2,
                        medianLiftPct: 3,
                        medianRr: 4,
                        medianDist: 5,
                        medianHmaxLiftPct: 6,
                        timingEdgeScore: 7,
                        medianDiversity: 1,
                        asOfTimeKey: "1700000000",
                        close: 100,
                        medianBarsHeld: 2,
                        agreementTransition: 1,
                        freshHits: 1,
                        dominantPair: "BTC",
                        dominantPairShare: 1,
                        pairWarnings: 0,
                    },
                ],
            },
        });

        expect(snapshot.results).to.have.length(BATCH_RESULT_SNAPSHOT_LIMIT);
        expect(snapshot.results[0]!.data).to.equal(undefined);
        expect(snapshot.results[0]!.signals).to.equal(undefined);
        expect(snapshot.results[0]!.result?.trades).to.deep.equal([]);
        expect(snapshot.results[0]!.result?.equityCurve).to.deep.equal([]);
        expect(snapshot.results[0]!.buyHoldPct).to.be.closeTo(10, 1e-9);
        expect(snapshot.results[0]!.openTradeAssetScores?.map((s) => `${s.asset}:${s.score}`)).to.deep.equal(["BTC:-1", "WLD:1"]);
        expect(snapshot.stabilityResult?.rows[0]?.asset).to.equal("WLD");
        expect(snapshot.stabilityResult?.engine).to.equal("typescript_parallel");
    });

    it("rejects malformed snapshots", () => {
        expect(normalizeBatchBacktestResultsSnapshot(null)).to.equal(null);
        expect(normalizeBatchBacktestResultsSnapshot({ results: [] })).to.equal(null);
        expect(normalizeBatchBacktestResultsSnapshot({ interval: "5m" })).to.equal(null);
    });

    it("normalizes valid snapshots through the compact path", () => {
        const normalized = normalizeBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "1h",
            fingerprint: "abc",
            strategyKey: "rolling_vwap_center",
            serverHasArtifacts: false,
            results: [makeResult(1)],
            stabilityResult: {
                reruns: 1,
                subsetSize: 1,
                seed: 1,
                totalPairs: 1,
                hitEvents: 1,
                rows: [{ asset: "BTC", direction: "SHORT", hits: 1, high: 0, medium: 1, low: 0, medianRetPct: null, medianLiftPct: null, medianRr: null, medianDist: null, medianHmaxLiftPct: null, pairWarnings: 0 }],
            },
        });

        expect(normalized?.interval).to.equal("1h");
        expect(normalized?.results[0]?.data).to.equal(undefined);
        expect(normalized?.results[0]?.result?.trades).to.deep.equal([]);
        expect(normalized?.stabilityResult?.rows[0]?.direction).to.equal("SHORT");
    });

    it("preserves strategyKey through compact -> normalize round-trip (audit finding 5)", () => {
        // Mine provenance must survive a persist/reload so verdicts are labeled
        // with the strategy that actually governed the Run, not whatever is
        // selected in the UI at Mine-click time.
        const compacted = compactBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "4h",
            fingerprint: "abc",
            strategyKey: "rolling_vwap_center",
            serverHasArtifacts: true,
            results: [makeResult(1)],
        });
        expect(compacted.strategyKey).to.equal("rolling_vwap_center");

        const roundTripped = normalizeBatchBacktestResultsSnapshot(compacted);
        expect(roundTripped?.strategyKey).to.equal("rolling_vwap_center");
    });

    it("normalizes a legacy payload missing strategyKey to null instead of dropping it (audit finding 5)", () => {
        // Older persisted snapshots predate the `strategyKey` field. The
        // service treats `null` as "provenance unknown — skip Mine persistence"
        // rather than silently attributing verdicts to the current UI strategy.
        const legacy = normalizeBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "4h",
            fingerprint: "abc",
            // strategyKey intentionally omitted
            serverHasArtifacts: true,
            results: [makeResult(1)],
        });
        expect(legacy?.strategyKey).to.equal(null);
    });

    it("rejects non-string / empty strategyKey values as null", () => {
        const withNumber = normalizeBatchBacktestResultsSnapshot({
            savedAt: 1,
            interval: "4h",
            fingerprint: "abc",
            strategyKey: 42 as unknown as string,
            serverHasArtifacts: true,
            results: [makeResult(1)],
        });
        expect(withNumber?.strategyKey).to.equal(null);

        const withEmpty = normalizeBatchBacktestResultsSnapshot({
            savedAt: 1,
            interval: "4h",
            fingerprint: "abc",
            strategyKey: "",
            serverHasArtifacts: true,
            results: [makeResult(1)],
        });
        expect(withEmpty?.strategyKey).to.equal(null);
    });

});
