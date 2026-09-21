import { expect } from "chai";
import { describe, it } from "node:test";
import { buildBacktestDiagnosticOutput } from "../lib/backtest-diagnostic-output";
import type { UiBacktestEndpointSnapshot } from "../lib/backtest-endpoint-copy";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";

function makeTrade(id: number, overrides: Partial<Trade> = {}): Trade {
    return {
        id,
        type: "long",
        entryTime: (1_700_000_000 + id * 60) as Time,
        entryPrice: 100,
        exitTime: (1_700_000_030 + id * 60) as Time,
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
            firstCandleTime: 1_700_000_000 as Time,
            lastCandleTime: 1_700_006_000 as Time,
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
        engineUsed: "typescript",
        datasetFingerprint: "test",
        ...overrides,
    };
}

describe("Backtest diagnostic output", () => {
    it("summarizes run metadata, chart exits, and exit control for a plain run", () => {
        const result = makeResult({
            trades: [
                makeTrade(1, { exitReason: "signal" }),
                makeTrade(2, { exitReason: "take_profit" }),
                makeTrade(3, { exitReason: "stop_loss" }),
            ],
            totalTrades: 3,
            winRate: 33.3,
            netProfit: 1,
        });

        const output = buildBacktestDiagnosticOutput({
            result,
            snapshot: makeSnapshot(),
            resultSource: "backtest",
        });

        expect(output.schema).to.equal("backtest.diagnostics.v1");
        expect(output.run.symbol).to.equal("BTCUSDT");
        expect(output.run.interval).to.equal("1m");
        expect(output.run.strategyKey).to.equal("test_strategy");
        expect(output.run.totalTrades).to.equal(3);
        expect(output.run.executionModel).to.equal("next_open");
        expect(output.run.firstCandleTimeSec).to.equal(1_700_000_000);
        expect(output.run.lastCandleTimeSec).to.equal(1_700_006_000);

        expect(output.chartExits.counts.signal).to.equal(1);
        expect(output.chartExits.counts.take_profit).to.equal(1);
        expect(output.chartExits.counts.stop_loss).to.equal(1);
        expect(output.chartExits.signalTrades).to.equal(1);
        expect(output.chartExits.nonSignalTrades).to.equal(2);

        expect(output.exitControl.requestedDisableSignalExits).to.equal(false);
        expect(output.exitControl.requestedExitStrategyOverrideEnabled).to.equal(false);
        expect(output.exitControl.requestedExitStrategyKey).to.equal("");

        expect(output.warnings).to.deep.equal([]);
        expect(output.recommendations).to.deep.equal([]);
    });

    it("reflects exit-override settings and engine counts when present", () => {
        const result = makeResult({
            trades: [makeTrade(1)],
            exitControlDiagnostics: {
                requestedDisableSignalExits: true,
                exitStrategyLoaded: true,
                primarySignals: 5,
                exitOverrideSignals: 2,
                mergedSignals: 7,
            } as BacktestResult["exitControlDiagnostics"],
            diagnostics: {
                counts: {
                    inputSignals: 5,
                    preparedSignals: 7,
                    signalExitOrders: 2,
                },
            } as BacktestResult["diagnostics"],
        });

        const output = buildBacktestDiagnosticOutput({
            result,
            snapshot: makeSnapshot({
                backtestSettings: {
                    executionModel: "signal_close",
                    disableSignalExits: true,
                    exitStrategyOverrideEnabled: true,
                    exitStrategyKey: "ema_exit",
                    exitStrategyParams: { period: 8 },
                },
            }),
        });

        expect(output.exitControl.requestedDisableSignalExits).to.equal(true);
        expect(output.exitControl.requestedExitStrategyOverrideEnabled).to.equal(true);
        expect(output.exitControl.requestedExitStrategyKey).to.equal("ema_exit");
        expect(output.exitControl.requestedExitStrategyParamKeys).to.deep.equal(["period"]);
        expect(output.exitControl.executor).to.not.be.null;
        expect(output.exitControl.engineInputSignals).to.equal(5);
        expect(output.exitControl.enginePreparedSignals).to.equal(7);
        expect(output.exitControl.engineSignalExitOrders).to.equal(2);
    });

    it("works without a snapshot by falling back to result market context", () => {
        const output = buildBacktestDiagnosticOutput({
            result: makeResult({ trades: [makeTrade(1)] }),
        });

        expect(output.run.source).to.be.undefined;
        expect(output.run.symbol).to.equal("BTCUSDT");
        expect(output.run.executionModel).to.be.undefined;
        expect(output.exitControl.requestedDisableSignalExits).to.equal(null);
    });
});
