import { expect } from "chai";
import { describe, it } from "node:test";
import { buildBacktestDiagnosticOutput } from "../lib/backtest-diagnostic-output";
import type { UiBacktestEndpointSnapshot } from "../lib/backtest-endpoint-copy";
import type { BacktestResult, Trade } from "../lib/types/strategies";

function makeTrade(id: number, overrides: Partial<Trade> = {}): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 60,
        entryPrice: 100,
        exitTime: 1_700_000_030 + id * 60,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "signal",
        ...overrides,
    };
}

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    const trades = overrides.trades ?? [];
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        marketContext: {
            symbol: "BTCUSDT",
            interval: "1m",
            candleCount: 100,
            firstCandleTime: 1_700_000_000,
            lastCandleTime: 1_700_006_000,
        },
        ...overrides,
    };
}

function makeSnapshot(overrides: Partial<UiBacktestEndpointSnapshot> = {}): UiBacktestEndpointSnapshot {
    return {
        symbol: "BTCUSDT",
        interval: "1m",
        strategyKey: "test_strategy",
        strategyParams: {},
        backtestSettings: {
            executionModel: "next_open",
            polymarketAnnotationEnabled: true,
            polymarketExitMode: "signal_exit_same_event",
            polymarketOutcomeInterval: "5m",
        },
        capitalSettings: {
            initialCapital: 10_000,
            positionSize: 100,
            commission: 0.1,
            sizingMode: "fixed",
            fixedTradeAmount: 100,
        },
        nowSec: 1_700_006_000,
        blockRange: null,
        annotatePolymarket: true,
        engineUsed: "typescript",
        datasetFingerprint: "test",
        ...overrides,
    };
}

describe("Backtest diagnostic output", () => {
    it("explains signal-exit trades that settled because chart exits were non-signal", () => {
        const trades = [
            makeTrade(1, {
                exitReason: "time_stop",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000,
                    eventEndTs: 1_700_000_300,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "yes",
                    actualOutcomeUp: 1,
                    isWin: true,
                    evaluationMode: "signal_exit_same_event",
                    marketEntryPrice: 0.66,
                    marketExitPrice: 1,
                    marketExitSource: "resolution",
                    marketExitTs: 1_700_000_300,
                    marketPnl: 0.34,
                    isProfitable: true,
                },
            }),
            makeTrade(2, {
                exitReason: "time_stop",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000,
                    eventEndTs: 1_700_000_300,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "yes",
                    actualOutcomeUp: 1,
                    isWin: true,
                    evaluationMode: "signal_exit_same_event",
                    marketEntryPrice: 0.78,
                    marketExitPrice: 1,
                    marketExitSource: "resolution",
                    marketExitTs: 1_700_000_300,
                    marketPnl: 0.22,
                    isProfitable: true,
                },
            }),
        ];
        const result = makeResult({
            trades,
            totalTrades: trades.length,
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeInterval: "5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 2,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                evaluationMode: "signal_exit_same_event",
                signalExitedTrades: 0,
                resolvedTrades: 2,
                missingPriceTrades: 0,
                profitableTrades: 2,
                losingTrades: 0,
                neutralTrades: 0,
                netPnl: 0.56,
                grossProfit: 0.56,
                grossLoss: 0,
                profitFactor: Infinity,
                expectancy: 0.28,
                avgEntryPrice: 0.72,
                avgExitPrice: 1,
            },
        });

        const output = buildBacktestDiagnosticOutput({
            result,
            snapshot: makeSnapshot(),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.effectiveExitMode).to.equal("signal_exit_same_event");
        expect(output.polymarket?.exitSourceCounts.resolution).to.equal(2);
        expect(output.polymarket?.chartExitReasonsForResolvedSignalExit.time_stop).to.equal(2);
        expect(output.polymarket?.examples).to.have.length(2);
        expect(output.warnings.map((warning) => warning.code)).to.include("same_event_exit_settled_at_resolution");
        expect(output.warnings.map((warning) => warning.code)).to.include("no_polymarket_same_event_exits");
        expect(output.warnings.map((warning) => warning.code)).to.include("no_chart_signal_exits");
        expect(output.warnings.find((warning) => warning.code === "no_chart_signal_exits")?.message)
            .to.include("chart_exit_same_event");
        expect(output.recommendations[0]).to.include("chart_exit_same_event");
    });

    it("warns when requested signal-exit resolves to hold mode", () => {
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({ trades: [makeTrade(1)] }),
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "signal_close",
                    polymarketAnnotationEnabled: true,
                    polymarketExitMode: "signal_exit_same_event",
                },
            }),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.requestedExitMode).to.equal("signal_exit_same_event");
        expect(output.polymarket?.effectiveExitMode).to.equal("resolve_hold");
        expect(output.warnings.map((warning) => warning.code)).to.include("same_event_exit_not_effective");
    });

    it("supports chart-exit diagnostics without requiring chart signal exits", () => {
        const trades = [
            makeTrade(1, {
                exitReason: "time_stop",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000,
                    eventEndTs: 1_700_000_300,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "yes",
                    actualOutcomeUp: 0,
                    isWin: null,
                    evaluationMode: "chart_exit_same_event",
                    marketEntryPrice: 0.50,
                    marketExitPrice: 0.62,
                    marketExitSource: "signal",
                    marketExitTs: 1_700_000_090,
                    marketPnl: 0.12,
                    isProfitable: true,
                },
            }),
        ];
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({
                trades,
                totalTrades: trades.length,
                polymarketTradeSummary: {
                    seriesId: "btc-5m",
                    outcomeInterval: "5m",
                    outcomeRowsLoaded: 1,
                    scoredTrades: 1,
                    missingOutcomeTrades: 0,
                    unscoredTrades: 0,
                    evaluationMode: "chart_exit_same_event",
                    signalExitedTrades: 1,
                    resolvedTrades: 0,
                    missingPriceTrades: 0,
                    profitableTrades: 1,
                    losingTrades: 0,
                    neutralTrades: 0,
                    netPnl: 0.12,
                    grossProfit: 0.12,
                    grossLoss: 0,
                    profitFactor: Infinity,
                    expectancy: 0.12,
                    avgEntryPrice: 0.50,
                    avgExitPrice: 0.62,
                },
            }),
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "next_open",
                    polymarketAnnotationEnabled: true,
                    polymarketExitMode: "chart_exit_same_event",
                    polymarketOutcomeInterval: "5m",
                },
            }),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.effectiveExitMode).to.equal("chart_exit_same_event");
        expect(output.polymarket?.exitSourceCounts.chart_exit).to.equal(1);
        expect(output.polymarket?.sameEventExitedTrades).to.equal(1);
        expect(output.polymarket?.chartExitedTrades).to.equal(1);
        expect(output.polymarket?.signalExitedTrades).to.equal(0);
        expect(output.polymarket?.resolvedTrades).to.equal(0);
        expect(output.warnings.map((warning) => warning.code)).to.not.include("no_chart_signal_exits");
    });

    it("does not warn when chart-exit mode only resolves forced end-of-data trades", () => {
        const trades = [
            makeTrade(1, {
                exitReason: "end_of_data",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000,
                    eventEndTs: 1_700_000_300,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "yes",
                    actualOutcomeUp: 1,
                    isWin: true,
                    evaluationMode: "chart_exit_same_event",
                    marketEntryPrice: 0.36,
                    marketExitPrice: 1,
                    marketExitSource: "resolution",
                    marketExitTs: 1_700_000_300,
                    marketPnl: 0.64,
                    isProfitable: true,
                },
            }),
        ];
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({
                trades,
                totalTrades: trades.length,
                polymarketTradeSummary: {
                    seriesId: "btc-5m",
                    outcomeInterval: "5m",
                    outcomeRowsLoaded: 1,
                    scoredTrades: 1,
                    missingOutcomeTrades: 0,
                    unscoredTrades: 0,
                    evaluationMode: "chart_exit_same_event",
                    signalExitedTrades: 0,
                    resolvedTrades: 1,
                    missingPriceTrades: 0,
                    profitableTrades: 1,
                    losingTrades: 0,
                    neutralTrades: 0,
                    netPnl: 0.64,
                    grossProfit: 0.64,
                    grossLoss: 0,
                    profitFactor: Infinity,
                    expectancy: 0.64,
                    avgEntryPrice: 0.36,
                    avgExitPrice: 1,
                },
            }),
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "next_open",
                    polymarketAnnotationEnabled: true,
                    polymarketExitMode: "chart_exit_same_event",
                    polymarketOutcomeInterval: "5m",
                },
            }),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.resolvedTrades).to.equal(1);
        expect(output.polymarket?.chartExitReasonsForResolvedSameEventExit.end_of_data).to.equal(1);
        expect(output.warnings.map((warning) => warning.code)).to.not.include("same_event_exit_settled_at_resolution");
        expect(output.warnings.map((warning) => warning.code)).to.not.include("no_polymarket_same_event_exits");
    });

    it("includes filter settings and examples for unscored Polymarket buckets", () => {
        const baseOutcome = {
            eventStartTs: 1_700_000_000,
            eventEndTs: 1_700_000_300,
            eventSlug: "event-1",
            marketSlug: "market-1",
            prediction: "yes" as const,
            actualOutcomeUp: 1 as const,
            isWin: null,
            evaluationMode: "chart_exit_same_event" as const,
            marketExitPrice: null,
            marketExitTs: null,
            marketPnl: null,
            isProfitable: null,
        };
        const trades = [
            makeTrade(1, {
                polymarketOutcome: {
                    ...baseOutcome,
                    marketEntryPrice: 0.20,
                    marketExitSource: "entry_price_filtered",
                },
            }),
            makeTrade(2, {
                polymarketOutcome: {
                    ...baseOutcome,
                    marketEntryPrice: 0.85,
                    marketExitSource: "entry_price_filtered",
                },
            }),
            makeTrade(3, {
                polymarketOutcome: {
                    ...baseOutcome,
                    marketEntryPrice: null,
                    marketExitSource: "missing",
                },
            }),
            makeTrade(4, {
                polymarketOutcome: {
                    ...baseOutcome,
                    marketEntryPrice: null,
                    marketExitSource: "entry_time_filtered",
                },
            }),
        ];
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({
                trades,
                totalTrades: trades.length,
                polymarketTradeSummary: {
                    seriesId: "btc-5m",
                    outcomeInterval: "5m",
                    outcomeRowsLoaded: 1,
                    scoredTrades: 0,
                    missingOutcomeTrades: 0,
                    unscoredTrades: 4,
                    evaluationMode: "chart_exit_same_event",
                    signalExitedTrades: 0,
                    resolvedTrades: 0,
                    missingPriceTrades: 1,
                    entryPriceFilteredTrades: 2,
                    entryTimeFilteredTrades: 1,
                    profitableTrades: 0,
                    losingTrades: 0,
                    neutralTrades: 0,
                    netPnl: 0,
                    grossProfit: 0,
                    grossLoss: 0,
                    profitFactor: 0,
                    expectancy: 0,
                    avgEntryPrice: 0,
                    avgExitPrice: 0,
                },
            }),
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "next_open",
                    polymarketAnnotationEnabled: true,
                    polymarketExitMode: "chart_exit_same_event",
                    polymarketOutcomeInterval: "5m",
                    polymarketEntryPriceFilterCents: 20,
                    polymarketBacktestSlippageCents: 5,
                    polymarketEntryCutoffEnabled: true,
                    polymarketEntryCutoffSeconds: 15,
                    polymarketSignalExitAllowMultipleTradesPerEvent: true,
                },
            }),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.scoredPct).to.equal(0);
        expect(output.polymarket?.unscoredPct).to.equal(100);
        expect(output.polymarket?.filters.entryPriceFilterCents).to.equal(20);
        expect(output.polymarket?.filters.entryPriceAllowedRange).to.deep.equal({
            minExclusive: 0.2,
            maxExclusive: 0.8,
        });
        expect(output.polymarket?.filters.entryCutoffEnabled).to.equal(true);
        expect(output.polymarket?.filters.entryCutoffSeconds).to.equal(15);
        expect(output.polymarket?.entryPriceFilterBreakdown).to.deep.equal({
            low: 1,
            high: 1,
            unknown: 0,
            minEntryPrice: 0.2,
            maxEntryPrice: 0.85,
            avgEntryPrice: 0.525,
        });
        expect(output.polymarket?.unscoredExamplesBySource.entry_price_filtered).to.have.length(2);
        expect(output.polymarket?.unscoredExamplesBySource.missing).to.have.length(1);
        expect(output.polymarket?.unscoredExamplesBySource.entry_time_filtered).to.have.length(1);
        expect(output.recommendations).to.deep.equal([
            "Review the 20c entry price filter: it excluded 2 trades, mixed high/low entries (1 high, 1 low). For coverage testing, reduce or disable this filter before comparing strategy quality.",
            "Entry cutoff skipped 1 trades inside the final 15s of the event; lower it only if late-event fills are acceptable.",
            "Missing-price trades remain (1); inspect unscoredExamplesBySource.missing and refresh/re-mine local CLOB quotes around those event windows before tuning thresholds.",
        ]);
    });

    it("does not overstate slight entry-price filter skews", () => {
        const prices = [0.81, 0.82, 0.83, 0.19, 0.18];
        const trades = prices.map((price, index) => makeTrade(index + 1, {
            polymarketOutcome: {
                eventStartTs: 1_700_000_000,
                eventEndTs: 1_700_000_300,
                eventSlug: "event-1",
                marketSlug: "market-1",
                prediction: "yes",
                actualOutcomeUp: 1,
                isWin: null,
                evaluationMode: "chart_exit_same_event",
                marketEntryPrice: price,
                marketExitPrice: null,
                marketExitTs: null,
                marketExitSource: "entry_price_filtered",
                marketPnl: null,
                isProfitable: null,
            },
        }));
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({
                trades,
                totalTrades: trades.length,
                polymarketTradeSummary: {
                    seriesId: "btc-5m",
                    outcomeInterval: "5m",
                    outcomeRowsLoaded: 1,
                    scoredTrades: 0,
                    missingOutcomeTrades: 0,
                    unscoredTrades: trades.length,
                    evaluationMode: "chart_exit_same_event",
                    signalExitedTrades: 0,
                    resolvedTrades: 0,
                    missingPriceTrades: 0,
                    entryPriceFilteredTrades: trades.length,
                    profitableTrades: 0,
                    losingTrades: 0,
                    neutralTrades: 0,
                    netPnl: 0,
                    grossProfit: 0,
                    grossLoss: 0,
                    profitFactor: 0,
                    expectancy: 0,
                    avgEntryPrice: 0,
                    avgExitPrice: 0,
                },
            }),
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "next_open",
                    polymarketAnnotationEnabled: true,
                    polymarketExitMode: "chart_exit_same_event",
                    polymarketOutcomeInterval: "5m",
                    polymarketEntryPriceFilterCents: 20,
                },
            }),
            generatedAtIso: "2026-05-24T00:00:00.000Z",
        });

        expect(output.polymarket?.entryPriceFilterBreakdown.high).to.equal(3);
        expect(output.polymarket?.entryPriceFilterBreakdown.low).to.equal(2);
        expect(output.recommendations[0]).to.include("mixed high/low entries, slight high skew (3 high vs 2 low)");
        expect(output.recommendations[0]).to.not.include("mostly high-priced");
    });
});
