import assert from "node:assert/strict";
import {
    executeBacktest,
    resolveExecutorBacktestSettings,
} from "../lib/backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../lib/backtest-capital-settings";
import { calculateSharpeRatioFromEquityCurve, calculateSharpeRatioFromReturns } from "../lib/strategies/performance-metrics";
import { parabolic_sar_confirmation } from "../lib/strategies/lib/parabolic_sar_confirmation";
import { rustEngine } from "../lib/rust-engine-client";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Strategy,
    Time,
} from "../lib/types/strategies";

const interval = "4h";
const data: OHLCVData[] = Array.from({ length: 400 }, (_, index) => {
    const close = 100 + Math.sin(index / 8) * 8 + index * 0.01;
    return {
        time: (1_700_000_000 + index * 4 * 60 * 60) as Time,
        open: close - 0.2,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000 + index,
    };
});
const backtestSettings: BacktestSettings = {
    tradeDirection: "combined",
    executionModel: "next_open",
    allowSameBarExit: false,
    slippageBps: 5,
    disableSignalExits: true,
};
const capitalSettings = resolveCapitalSettingsFromRaw({});
const preResolvedSettings = resolveExecutorBacktestSettings(backtestSettings, interval);
const commonRequest = {
    ohlcvData: data,
    closedCandleDataOverride: data,
    interval,
    primarySymbol: "TEST",
    strategyKey: "parabolic_sar_confirmation",
    strategy: parabolic_sar_confirmation,
    strategyParams: parabolic_sar_confirmation.defaultParams,
    backtestSettings,
    capitalSettings,
    preResolvedSettings,
    preResolvedCapital: capitalSettings,
    context: {
        blockRange: null,
        engineMode: "typescript" as const,
        nowSec: 1_800_000_000,
    },
};

async function main(): Promise<void> {
    const baseline = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: {
            includeAdvancedAnalytics: false,
            omitEquityCurve: true,
            skipDrawdown: true,
            skipResultPostProcessing: true,
        },
    });
    const measured = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: {
            includeAdvancedAnalytics: false,
            includeSharpeRatio: false,
            collectDiagnostics: true,
            collectExecutorTimings: true,
            useCompactBacktest: false,
            omitEquityCurve: true,
            skipDrawdown: true,
            skipResultPostProcessing: true,
        },
    });
    const signalsOnly = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: {
            signalsOnly: true,
            skipResultPostProcessing: true,
        },
    });
    const signalsOnlyRegularPath = await executeBacktest({
        ...commonRequest,
        strategyExecutionContext: {},
        backtestRunOptions: {
            signalsOnly: true,
            skipResultPostProcessing: true,
        },
    });

    assert.deepEqual(
        measured.result.trades,
        baseline.result.trades,
        "timing collection must not change the TOP_MEAN trade artifacts",
    );
    assert.ok(measured.result.trades.length > 0, "explicit full execution must retain trade artifacts");
    assert.equal(measured.result.totalTrades, baseline.result.totalTrades);
    assert.equal(measured.result.netProfit, baseline.result.netProfit);
    assert.equal(measured.result.sharpeRatio, 0);
    assert.equal(measured.result.maxDrawdown, 0);
    assert.ok(signalsOnly.signals.length > 0, "signal-only execution must still generate strategy signals");
    assert.deepEqual(
        signalsOnly.signals,
        signalsOnlyRegularPath.signals,
        "signal-only fast path must preserve the regular executor's signals",
    );
    assert.equal(signalsOnly.result.trades.length, 0);
    assert.equal(signalsOnly.result.totalTrades, 0);
    assert.equal(signalsOnly.engineDiagnostics?.typescriptReason, "signal-only execution");
    assert.ok(measured.executorTimings);
    assert.ok(measured.executorTimings.signalGenerationMs >= 0);
    assert.ok(measured.executorTimings.exitProcessingMs >= 0);
    assert.ok(measured.executorTimings.exitStrategyLoadMs >= 0);
    assert.ok(measured.executorTimings.exitStrategyNormalizeMs >= 0);
    assert.ok(measured.executorTimings.exitSignalGenerationMs >= 0);
    assert.ok(measured.executorTimings.exitStrategyMs >= 0);
    assert.ok(measured.executorTimings.exitMergeMs >= 0);
    assert.ok(measured.executorTimings.exitBookkeepingMs >= 0);
    assert.equal(measured.executorTimings.exitOverrideSignals, 0);
    assert.ok(
        Math.abs(
            measured.executorTimings.exitProcessingMs
            - measured.executorTimings.exitStrategyMs
            - measured.executorTimings.exitMergeMs
            - measured.executorTimings.exitBookkeepingMs,
        ) < 0.001,
        "exit subphase timings must add up to the existing exit total",
    );
    assert.ok(measured.executorTimings.engineMs >= 0);
    assert.ok(measured.result.diagnostics);
    assert.ok(measured.result.diagnostics.timingsMs.total >= 0);

    const sameStrategyExitSettings: BacktestSettings = {
        ...backtestSettings,
        exitStrategyOverrideEnabled: true,
        exitStrategyKey: "parabolic_sar_confirmation",
        exitStrategyParams: { ...parabolic_sar_confirmation.defaultParams },
    };
    const sameStrategyExitRequest = {
        ...commonRequest,
        backtestSettings: sameStrategyExitSettings,
        preResolvedSettings: resolveExecutorBacktestSettings(sameStrategyExitSettings, interval),
        backtestRunOptions: {
            collectExecutorTimings: true,
            includeAdvancedAnalytics: false,
            includeSharpeRatio: false,
            omitEquityCurve: true,
            skipDrawdown: true,
            skipResultPostProcessing: true,
        },
    };
    const reusedExitSignals = await executeBacktest(sameStrategyExitRequest);
    const separatelyGeneratedExitSignals = await executeBacktest({
        ...sameStrategyExitRequest,
        // A distinct confirmation array forces the authoritative exit path;
        // no confirmation strategies are configured, so the resulting signal
        // series and trades must still match the reusable case exactly.
        confirmationDataOverride: data.map((candle) => ({ ...candle })),
    });
    assert.deepEqual(
        reusedExitSignals.result.trades,
        separatelyGeneratedExitSignals.result.trades,
        "reusing the identical built-in signal stream must preserve exit fills",
    );
    assert.equal(reusedExitSignals.result.netProfit, separatelyGeneratedExitSignals.result.netProfit);
    assert.equal(reusedExitSignals.executorTimings?.exitSignalGenerationMs, 0);
    assert.ok(
        (separatelyGeneratedExitSignals.executorTimings?.exitSignalGenerationMs ?? 0) > 0,
        "distinct confirmation data retains the independent exit-signal generation path",
    );

    verifyAnalyticsOwnership();
    await verifyRustAnalyticsNormalization();

    console.log("PASS: backtest-executor-timings.spec.ts");
}

/**
 * Finalization must honor the explicit engine/output ownership: enabled
 * analytics stay present, disabled analytics stay disabled, already-computed
 * engine output is not recomputed, and zero Sharpe remains a valid result.
 */
async function verifyAnalyticsOwnership(): Promise<void> {
    const fullDefault = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: { collectExecutorTimings: true },
    });
    assert.ok(fullDefault.result.equityCurve.length > 1, "full execution must return its equity curve");
    assert.ok(fullDefault.result.sharpeRatio !== 0);
    assert.ok(fullDefault.result.performanceAnalytics, "default full results keep requested analytics");
    assert.ok((fullDefault.executorTimings?.postProcessingMs ?? -1) >= 0, "post-processing timing is collected");

    // Engine output is authoritative: enabling post-processing must not
    // change the engine-computed Sharpe or analytics.
    const rawEngine = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: { skipResultPostProcessing: true },
    });
    assert.equal(fullDefault.result.sharpeRatio, rawEngine.result.sharpeRatio);
    assert.equal(
        fullDefault.result.performanceAnalytics?.tailRatio,
        rawEngine.result.performanceAnalytics?.tailRatio,
    );

    // Disabled Sharpe is honored as zero and analytics require Sharpe.
    const sharpeDisabled = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: { includeSharpeRatio: false },
    });
    assert.equal(sharpeDisabled.result.sharpeRatio, 0, "includeSharpeRatio:false stays zero");
    assert.equal(sharpeDisabled.result.performanceAnalytics, undefined);

    // Disabled analytics stay omitted while Sharpe stays enabled.
    const analyticsDisabled = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: { includeAdvancedAnalytics: false },
    });
    assert.equal(analyticsDisabled.result.performanceAnalytics, undefined);
    assert.equal(analyticsDisabled.result.sharpeRatio, fullDefault.result.sharpeRatio);

    // Compact execution preserves its equity-derived Sharpe even though
    // the returned equity curve is omitted; analytics stay omitted.
    const compactRunOptions = {
        collectExecutorTimings: true,
        includeAdvancedAnalytics: true,
        useCompactBacktest: true,
        omitEquityCurve: true,
        skipDrawdown: true,
    };
    const compactEnabled = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: compactRunOptions,
    });
    const compactRaw = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: { ...compactRunOptions, skipResultPostProcessing: true },
    });
    assert.equal(compactEnabled.result.equityCurve.length, 0, "compact omits the returned curve");
    assert.equal(compactEnabled.result.sharpeRatio, compactRaw.result.sharpeRatio);
    assert.notEqual(compactEnabled.result.sharpeRatio, 0, "compact Sharpe comes from the typed equity buffer");
    assert.equal(compactEnabled.result.performanceAnalytics, undefined);
    assert.ok((compactEnabled.executorTimings?.postProcessingMs ?? -1) >= 0);

    // No-signal execution keeps a valid zero Sharpe under finalization.
    const emptyStrategy: Strategy = {
        name: "No signals ownership test",
        description: "Produces no signals.",
        defaultParams: {},
        paramLabels: {},
        execute: () => [],
    };
    const empty = await executeBacktest({
        ...commonRequest,
        strategy: emptyStrategy,
        strategyKey: "no_signals_ownership_test",
        strategyParams: {},
        backtestRunOptions: {},
    });
    assert.equal(empty.result.totalTrades, 0);
    assert.equal(empty.result.sharpeRatio, 0);
    assert.equal(empty.result.performanceAnalytics, undefined);

    // Entry-only strategies keep their entryStats result untouched.
    const entryStrategy: Strategy = {
        name: "Entry stats ownership test",
        description: "Entry evaluation result surface.",
        defaultParams: {},
        paramLabels: {},
        metadata: { role: "entry" },
        execute: () => [],
            evaluate: () => ({
                signals: [],
                entryStats: {
                mode: "fan_retest",
                totalEntries: 2,
                wins: 1,
                losses: 1,
                winRate: 0.5,
                avgRetestBars: 1,
                avgRetests: 1,
                maxBars: 5,
                maxRetests: 1,
                minRetestsForWin: 1,
                entryMode: 0,
                retestMode: 0,
                useWick: false,
                touchTolerancePct: 0.1,
            },
        }),
    };
    const entryOnly = await executeBacktest({
        ...commonRequest,
        strategy: entryStrategy,
        strategyKey: "entry_stats_ownership_test",
        strategyParams: {},
        backtestRunOptions: {},
    });
    assert.ok(entryOnly.result.entryStats, "entry evaluation result keeps its entryStats");
    assert.equal(entryOnly.result.performanceAnalytics, undefined);

    // Prepared-signal execution skips strategy signal generation (the
    // counting wrapper below is never invoked) but keeps the default
    // full-result behavior: finalization runs with TypeScript ownership, so
    // the full engine's Sharpe and analytics are preserved as computed.
    const primaryRun = await executeBacktest({
        ...commonRequest,
        backtestRunOptions: {},
    });
    let preparedStrategyExecuteCalls = 0;
    const fromSignals = await executeBacktest({
        ...commonRequest,
        strategy: {
            ...parabolic_sar_confirmation,
            execute: (data, params, settings) => {
                preparedStrategyExecuteCalls += 1;
                return parabolic_sar_confirmation.execute!(data, params, settings);
            },
        },
        preGeneratedSignals: primaryRun.signals,
        backtestRunOptions: {},
    });
    assert.equal(preparedStrategyExecuteCalls, 0, "prepared signals must skip strategy signal generation");
    assert.equal(fromSignals.engineUsed, "typescript");
    assert.ok(fromSignals.result.equityCurve.length > 1);
    assert.equal(
        fromSignals.result.sharpeRatio,
        calculateSharpeRatioFromEquityCurve(fromSignals.result.equityCurve),
        "prepared-signal Sharpe stays the equity-derived engine value",
    );
    assert.ok(fromSignals.result.performanceAnalytics);
    // Intraday curves collapse to daily samples, so the sample count sits
    // between the distinct-day count and the raw return count.
    const sampleCount = fromSignals.result.performanceAnalytics?.sampleCount ?? 0;
    assert.ok(sampleCount > 0 && sampleCount <= fromSignals.result.equityCurve.length - 1);
}

/**
 * A mocked supported Rust result is normalized at the executor boundary:
 * TypeScript recomputes Sharpe from the returned history because Rust's
 * scalar is not trusted, and missing analytics are derived only from a usable
 * curve.
 */
async function verifyRustAnalyticsNormalization(): Promise<void> {
    const rustSettings: BacktestSettings = {
        executionModel: "signal_close",
        tradeDirection: "long",
        allowSameBarExit: true,
        slippageBps: 0,
    };
    const rustData: OHLCVData[] = Array.from({ length: 60 }, (_, index) => {
        const close = 100 + index * 0.5;
        return {
            time: (1_700_000_000 + index * 3_600) as Time,
            open: close - 0.1,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1_000,
        };
    });
    // Percent sizing over 10,000 capital: each trade's pnlPercent is pnl / 100.
    const pnls = [50, -20, 30, -10, 40, 5];
    const rustTrades = pnls.map((pnl, index) => buildRustTrade(index + 1, 100 + index, pnl));
    const netProfit = pnls.reduce((sum, pnl) => sum + pnl, 0);
    const winningTrades = pnls.filter((pnl) => pnl > 0).length;
    const rustResult: BacktestResult = {
        trades: rustTrades,
        netProfit,
        netProfitPercent: netProfit / 100,
        winRate: (winningTrades / pnls.length) * 100,
        expectancy: netProfit / pnls.length,
        avgTrade: netProfit / pnls.length,
        profitFactor: 3,
        maxDrawdown: 20,
        maxDrawdownPercent: 0.2,
        totalTrades: pnls.length,
        winningTrades,
        losingTrades: pnls.length - winningTrades,
        avgWin: 31.25,
        avgLoss: 15,
        sharpeRatio: 0,
        equityCurve: [],
    };
    const original = rustEngine.runBacktestWithStatus;
    rustEngine.runBacktestWithStatus = async () => ({ ok: true, result: rustResult });
    try {
        const outcome = await executeBacktest({
            ohlcvData: rustData,
            closedCandleDataOverride: rustData,
            interval: "1h",
            primarySymbol: "RUSTOWN",
            strategyKey: "rust_ownership_test",
            strategy: {
                name: "Rust ownership test",
                description: "Simple entry stream for the Rust normalization check.",
                defaultParams: {},
                paramLabels: {},
                execute: (candles) => [
                    { time: candles[0]!.time, type: "buy", price: candles[0]!.close },
                    { time: candles[10]!.time, type: "sell", price: candles[10]!.close },
                    { time: candles[20]!.time, type: "buy", price: candles[20]!.close },
                    { time: candles[30]!.time, type: "sell", price: candles[30]!.close },
                ],
            },
            strategyParams: {},
            backtestSettings: rustSettings,
            capitalSettings: resolveCapitalSettingsFromRaw({}),
            preResolvedSettings: resolveExecutorBacktestSettings(rustSettings, "1h"),
            context: {
                nowSec: 9_999_999_999,
                blockRange: null,
                engineMode: "rust_preferred",
            },
            backtestRunOptions: {},
        });
        assert.equal(outcome.engineUsed, "rust");
        const expectedSharpe = calculateSharpeRatioFromReturns(rustResult.trades.map((trade) => trade.pnlPercent));
        assert.notEqual(expectedSharpe, 0);
        assert.equal(
            outcome.result.sharpeRatio,
            expectedSharpe,
            "Rust scalar Sharpe is normalized from returned history at the boundary",
        );
        assert.equal(outcome.result.performanceAnalytics, undefined);
    } finally {
        rustEngine.runBacktestWithStatus = original;
    }
}

function buildRustTrade(id: number, entryPrice: number, pnl: number): BacktestResult["trades"][number] {
    return {
        id,
        type: "long" as const,
        entryTime: (1_700_000_000 + id * 3_600) as Time,
        entryPrice,
        exitTime: (1_700_000_000 + (id + 1) * 3_600) as Time,
        exitPrice: entryPrice + pnl / 100,
        pnl,
        pnlPercent: pnl / 100,
        size: 100,
        exitReason: "signal" as const,
    };
}

main().catch((error) => {
    console.error("FAIL: backtest-executor-timings.spec.ts", error);
    process.exit(1);
});
