import { expect } from "chai";
import { describe, it } from "node:test";
import { buildCompactFinderDiagnostics, buildFinderDiagnosticsBottlenecks } from "../lib/finder/finder-diagnostics";
import type { FinderBacktestDiagnostics, FinderDiagnostics, FinderStrategyDiagnostics } from "../lib/types/finder";

function makeBacktestDiagnostics(runs: number): FinderBacktestDiagnostics {
    return {
        runs,
        avgInputSignals: 12,
        avgPreparedSignals: 10,
        avgBarsScanned: 400,
        avgBarsWithPosition: 120,
        avgEntriesAttempted: 8,
        avgTradesOpened: 6,
        avgTradesClosed: 6,
        fastPathRuns: 3,
        fastPathBlockers: [
            { reason: "equity_curve_required", runs: 9 },
            { reason: "multi_position_required", runs: 7 },
            { reason: "risk_mode_unsupported", runs: 5 },
            { reason: "sizing_mode_unsupported", runs: 4 },
            { reason: "signal_exit_unsupported", runs: 3 },
            { reason: "extra_blocker_should_be_omitted", runs: 1 },
        ],
        maxOpenPositions: 2,
        totals: {
            inputBars: 1000,
            evaluationBars: 900,
            inputSignals: 120,
            preparedSignals: 100,
            barsScanned: 4000,
            barsWithPosition: 1200,
            entriesAttempted: 80,
            tradesOpened: 60,
            tradesClosed: 60,
            signalExitOrders: 10,
            forcedEndOfDataExits: 1,
            fastPathRuns: 3,
            maxOpenPositions: 2,
        },
        timingsMs: {
            total: 200,
            dataClean: 5,
            indicatorResolution: 10,
            signalPreparation: 20,
            signalIndexing: 8,
            entryEvaluation: 25,
            tradeSimulation: 90,
            forcedClose: 3,
            drawdown: 7,
            metrics: 32,
        },
    };
}

function makeStrategy(index: number): FinderStrategyDiagnostics {
    return {
        key: `strategy_${index}`,
        name: `Strategy ${index}`,
        runs: 100,
        failedRuns: index % 11 === 0 ? 2 : 0,
        skippedRuns: index % 13 === 0 ? 1 : 0,
        zeroSignalRuns: index % 7 === 0 ? 12 : 0,
        avgSignalMs: index * 0.1,
        avgBacktestMs: index * 0.2,
        avgTotalMs: index * 0.3,
        totalMs: index * 10,
        runtimePct: index,
        usedPreparedData: index % 2 === 0,
        backtest: makeBacktestDiagnostics(2),
    };
}

function makeDiagnostics(): FinderDiagnostics {
    return {
        runId: "finder-test",
        symbol: "BTCUSDT",
        interval: "5m",
        mode: "random",
        engineMode: "typescript",
        data: {
            inputBars: 1000,
            evaluationBars: 900,
            selectedStrategies: 24,
            totalParamRuns: 2400,
            batchSize: 64,
        },
        counts: {
            processedRuns: 2400,
            filteredRuns: 44,
            shownResults: 10,
            rustCompletedRuns: 0,
            rustFallbackRuns: 0,
            endpointAdjusted: 2,
            failedRuns: 4,
            skippedRuns: 2,
        },
        backtest: makeBacktestDiagnostics(12),
        failureBreakdown: [
            {
                reason: "Cannot read properties of undefined",
                runs: 3,
                strategyKeys: ["a", "b", "c", "d", "e", "f", "g", "h"],
            },
        ],
        universe: {
            totalSymbols: 12,
            loadedSymbols: 10,
            dataWindow: {
                dataSlice: "5",
                loadedBars: { min: 1700, max: 1700, avg: 1700 },
                slicedBars: { min: 340, max: 340, avg: 340 },
                shortestSymbols: [
                    {
                        symbol: "BTC+APT",
                        loadedBars: 1700,
                        slicedBars: 340,
                        firstTime: 1_718_582_400 as any,
                        lastTime: 1_718_684_100 as any,
                        synthetic: true,
                    },
                ],
            },
            failedSymbols: [
                { symbol: "MISS_01", reason: "Dataset missing" },
                { symbol: "MISS_02", reason: "No candles returned." },
                { symbol: "MISS_03", reason: "No candles returned." },
                { symbol: "MISS_04", reason: "No candles returned." },
                { symbol: "MISS_05", reason: "No candles returned." },
                { symbol: "MISS_06", reason: "No candles returned." },
                { symbol: "MISS_07", reason: "No candles returned." },
                { symbol: "MISS_08", reason: "No candles returned." },
                { symbol: "MISS_09", reason: "No candles returned." },
            ],
        },
        timingsMs: {
            total: 1000,
            paramGeneration: 20,
            dataLoading: 40,
            pricePointLoading: 0,
            closedDataSelection: 10,
            indicatorPrecompute: 50,
            preparedData: 80,
            signalGeneration: 260,
            backtest: 400,
            polymarketEvaluation: 0,
            rustRequest: 0,
            resultEnrichment: 45,
            resultRanking: 35,
            reconciliation: 5,
            uiUpdates: 15,
            yielding: 40,
        },
        timingPct: {
            paramGeneration: 2,
            dataLoading: 4,
            pricePointLoading: 0,
            closedDataSelection: 1,
            indicatorPrecompute: 5,
            preparedData: 8,
            signalGeneration: 26,
            backtest: 40,
            polymarketEvaluation: 0,
            rustRequest: 0,
            resultEnrichment: 4.5,
            resultRanking: 3.5,
            reconciliation: 0.5,
            uiUpdates: 1.5,
            yielding: 4,
        },
        strategyBreakdown: Array.from({ length: 24 }, (_value, index) => makeStrategy(index)),
        bottlenecks: [
            "backtest used 40.0% of runtime",
            "signal generation used 26.0% of runtime",
            "strategy_23 consumed 23.0% of measured candidate runtime",
        ],
    };
}

describe("Finder compact diagnostics", () => {
    it("keeps copied diagnostics bounded while preserving improvement signals", () => {
        const full = makeDiagnostics();
        const compact = buildCompactFinderDiagnostics(full);
        const fullJson = JSON.stringify(full, null, 2);
        const compactJson = JSON.stringify(compact, null, 2);

        expect(compact.schema).to.equal("finder.diagnostics.compact.v1");
        expect(compact.strategies.totalStrategies).to.equal(24);
        expect(compact.strategies.topRuntime.map((item) => item.key)).to.deep.equal([
            "strategy_23",
            "strategy_22",
            "strategy_21",
        ]);
        expect(compact.strategies.issues).to.have.length(3);
        expect(compact.backtest?.fastPath.topBlockers).to.have.length(3);
        expect(compact.failures?.[0]?.strategyKeys).to.deep.equal(["a", "b", "c", "d"]);
        expect(compact.failures?.[0]?.omittedStrategyKeys).to.equal(4);
        expect(compact.universe).to.deep.equal({
            totalSymbols: 12,
            loadedSymbols: 10,
            loadFailures: 9,
            failedSymbols: [
                { symbol: "MISS_01", reason: "Dataset missing" },
                { symbol: "MISS_02", reason: "No candles returned." },
                { symbol: "MISS_03", reason: "No candles returned." },
                { symbol: "MISS_04", reason: "No candles returned." },
            ],
            omittedFailedSymbols: 5,
            dataWindow: {
                dataSlice: "5",
                loadedBars: { min: 1700, max: 1700, avg: 1700 },
                slicedBars: { min: 340, max: 340, avg: 340 },
                shortestSymbols: [
                    {
                        symbol: "BTC+APT",
                        loadedBars: 1700,
                        slicedBars: 340,
                        firstTime: 1_718_582_400,
                        lastTime: 1_718_684_100,
                        synthetic: true,
                    },
                ],
            },
        });
        expect(compact.timings.topPhases.map((phase) => phase.phase)).to.deep.equal([
            "backtest",
            "signalGeneration",
            "preparedData",
            "indicatorPrecompute",
        ]);
        expect(compactJson).to.not.contain('"strategyBreakdown"');
        expect(compactJson).to.not.contain('"totals"');
        expect(compactJson.split("\n").length).to.be.lessThan(260);
        expect(compactJson.length).to.be.lessThan(fullJson.length / 3);
    });

    it("prioritizes failure notes before phase bottlenecks in compact output", () => {
        const full = makeDiagnostics();
        full.bottlenecks = buildFinderDiagnosticsBottlenecks({
            timingsMs: full.timingsMs,
            strategyBreakdown: full.strategyBreakdown,
            failedRuns: 4,
            skippedRuns: 2,
            rustFallbackRuns: 1,
            backtest: full.backtest,
        });

        const compact = buildCompactFinderDiagnostics(full);

        expect(compact.bottlenecks).to.deep.equal([
            "4 candidate runs failed",
            "2 candidate runs skipped (zero-signal bail or fatal strategy failure)",
            "1 Rust run fell back to TypeScript",
        ]);
    });
});
