import assert from "node:assert/strict";
import { executeBacktest, resolveExecutorBacktestSettings } from "../lib/backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../lib/backtest-capital-settings";
import { parabolic_sar_confirmation } from "../lib/strategies/lib/parabolic_sar_confirmation";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";

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
        annotatePolymarket: false,
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
            collectDiagnostics: true,
            collectExecutorTimings: true,
            omitEquityCurve: true,
            skipDrawdown: true,
            skipResultPostProcessing: true,
        },
    });

    assert.deepEqual(
        measured.result.trades,
        baseline.result.trades,
        "timing collection must not change the TOP_MEAN trade artifacts",
    );
    assert.ok(measured.executorTimings);
    assert.ok(measured.executorTimings.signalGenerationMs >= 0);
    assert.ok(measured.executorTimings.exitProcessingMs >= 0);
    assert.ok(measured.executorTimings.engineMs >= 0);
    assert.ok(measured.result.diagnostics);
    assert.ok(measured.result.diagnostics.timingsMs.total >= 0);

    console.log("PASS: backtest-executor-timings.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: backtest-executor-timings.spec.ts", error);
    process.exit(1);
});
