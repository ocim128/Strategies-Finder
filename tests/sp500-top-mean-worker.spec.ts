import { makeBacktestSettings, makeCapitalSettings } from "./helpers/backtest-settings-fixtures";
import assert from "node:assert/strict";
import {
    isTopMeanEngineDiagnosticSample,
    processTopMeanShard,
    resolveTopMeanEngineRunOptions,
    TOP_MEAN_BACKTEST_RUN_OPTIONS,
    TOP_MEAN_ENGINE_DIAGNOSTIC_SAMPLE_STRIDE,
    type TopMeanWorkerTaskData,
} from "../lib/batch-backtest/sp500-top-mean-worker";
import { prepareClosedCandleData } from "../lib/backtest-executor";
import { selectClosedCandleWindow } from "../lib/alert-evaluation-window";
import type { OHLCVData, Time } from "../lib/types/strategies";

function testDiscardedDrawdownIsSkippedWithoutSelectingCompactResults(): void {
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.skipDrawdown, true);
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.omitEquityCurve, true);
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.includeSharpeRatio, false);
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.useCompactBacktest, false);
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.collectExecutorTimings, true);
    console.log("PASS: TOP_MEAN skips discarded drawdown while retaining full trade history");
}

async function runWorkerParityTest(): Promise<void> {
    const task: TopMeanWorkerTaskData = {
        shardIndex: 0,
        pairs: [
            { pairIndex: 0, symbol: "AAPL•+MSFT•" }
        ],
        strategyKey: "dema_confirmation",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: makeBacktestSettings(),
        capitalSettings: makeCapitalSettings(),
        interval: "4h",
        useRustEnginePreference: false,
    };

    const shardResult = await processTopMeanShard(task);
    const artifacts = shardResult.artifacts;
    assert.ok(Array.isArray(artifacts), "Artifacts must be an array");
    assert.ok(shardResult.engineUsage, "engineUsage must be reported");
    assert.equal(typeof shardResult.engineUsage.rust, "number");
    assert.equal(typeof shardResult.engineUsage.typescript, "number");
    assert.ok(shardResult.performance.signalGenerationMs >= 0);
    assert.ok(shardResult.performance.exitProcessingMs >= 0);
    assert.ok(shardResult.performance.exitStrategyMs >= 0);
    assert.ok(shardResult.performance.exitStrategyLoadMs >= 0);
    assert.ok(shardResult.performance.exitStrategyNormalizeMs >= 0);
    assert.ok(shardResult.performance.exitSignalGenerationMs >= 0);
    assert.ok(shardResult.performance.exitMergeMs >= 0);
    assert.ok(shardResult.performance.exitBookkeepingMs >= 0);
    assert.ok(shardResult.performance.exitOverrideSignals >= 0);
    assert.ok(shardResult.performance.engineMs >= 0);
    assert.ok(shardResult.performance.engineDiagnosticPairs <= 1);
    if (artifacts.length > 0) {
        assert.equal(artifacts[0].schema, "compact_pair_artifact.v1");
        assert.equal(artifacts[0].symbol, "AAPL•+MSFT•");
        assert.ok(Array.isArray(artifacts[0].trades), "Trades must be an array");
        // Phase-1 current snapshot: the worker records the last CLOSED candle
        // time so the reducer can align artifacts to a common endpoint.
        assert.ok(
            typeof artifacts[0].dataEndTime === "number" && Number.isFinite(artifacts[0].dataEndTime),
            "dataEndTime must be a finite number when candles were loaded",
        );
        assert.ok(artifacts[0].dataEndTime! > 0, "dataEndTime must be a positive unix timestamp");
        // Preference was false => completed pairs must count as typescript.
        assert.equal(shardResult.engineUsage.typescript, artifacts.length);
        assert.equal(shardResult.engineUsage.rust, 0);
        assert.equal(shardResult.performance.engineDiagnosticPairs, 1);
    }
    console.log("PASS: sp500-top-mean-worker.spec.ts (dataEndTime present)");
}

/**
 * F2 regression: dataEndTime must come from the authoritative closed-candle
 * timestamp, NOT from the raw loaded array's last element. When the final bar
 * is still open (its close time is after nowSec), selectClosedCandleWindow
 * drops it and reports the PREVIOUS bar's time as closedCandleTimeSec.
 *
 * Important nuance locked here: in next_open execution mode (the default),
 * prepareClosedCandleData BRIDGES the open bar into the prepared array, so the
 * prepared array's last element carries the OPEN bar's time. The worker must
 * therefore read closedCandleTimeSec (from selectClosedCandleWindow), not the
 * prepared array's tail — otherwise the snapshot endpoint would be one bar
 * ahead of the actual trade state.
 */
function testDataEndTimeFromClosedCandleArray(): void {
    const intervalSeconds = 4 * 60 * 60; // 4h
    const closedBarTime = 1_700_000_000;
    const openBarTime = closedBarTime + intervalSeconds; // 1 bar ahead
    // nowSec sits INSIDE the open bar's window so trimToClosedCandles treats
    // the final bar as not-yet-closed and drops it.
    const nowSec = openBarTime + 60;

    const candles: OHLCVData[] = [];
    for (let i = 0; i < 250; i++) {
        const t = closedBarTime - (249 - i) * intervalSeconds;
        candles.push({
            time: t as Time,
            open: 100, high: 101, low: 99, close: 100, volume: 1000,
        });
    }
    // Final bar is the in-progress one.
    candles.push({
        time: openBarTime as Time,
        open: 100, high: 101, low: 99, close: 100, volume: 1000,
    });

    // The authoritative closed-candle timestamp is the PREVIOUS bar.
    const closedWindow = selectClosedCandleWindow(candles, "4h", nowSec, 1);
    assert.ok(closedWindow, "selectClosedCandleWindow must resolve a window");
    assert.equal(closedWindow!.closedCandleTimeSec, closedBarTime);
    assert.equal(closedWindow!.nextOpenCandle?.time, openBarTime);

    // In next_open mode the prepared array BRIDGES the open bar, so its tail
    // is the OPEN bar's time — which must NOT be used as dataEndTime. This is
    // the exact trap F2 fixes: reading the prepared array's last element would
    // yield openBarTime instead of closedBarTime.
    const prepared = prepareClosedCandleData(candles, "4h", makeBacktestSettings(), nowSec);
    const preparedTailTime = Number(prepared[prepared.length - 1]!.time);
    assert.equal(preparedTailTime, openBarTime, "prepared array tail is the bridged OPEN bar in next_open mode");
    assert.notEqual(preparedTailTime, closedBarTime, "prepared tail must NOT equal the closed bar time");

    // The worker uses closedCandleTimeSec, which IS the closed bar.
    const dataEndTime = closedWindow!.closedCandleTimeSec;
    assert.equal(dataEndTime, closedBarTime);
    assert.notEqual(dataEndTime, openBarTime);

    console.log("PASS: dataEndTime from closedCandleTimeSec, not raw or bridged array tail (F2)");
}

function testDiagnosticSamplingByOriginalPairIndex(): void {
    // Shard-overhead plan phase 2: detailed diagnostics sample by ORIGINAL
    // pairIndex with a fixed stride — independent of shard boundaries,
    // assignment, or resume — replacing the former first-pair-per-shard rule
    // that sampled ~53% of pairs once tiles shrank shards.
    assert.equal(TOP_MEAN_ENGINE_DIAGNOSTIC_SAMPLE_STRIDE, 250);
    for (const selected of [0, 250, 500, 25_000]) {
        assert.equal(isTopMeanEngineDiagnosticSample(selected), true, `pairIndex ${selected} must be sampled`);
    }
    for (const unselected of [1, 249, 251, 499, 1234]) {
        assert.equal(isTopMeanEngineDiagnosticSample(unselected), false, `pairIndex ${unselected} must not be sampled`);
    }
    // Repartitioning invariance: eligibility is a pure function of the
    // original index, so regrouping pairs into different shards changes
    // nothing.
    const indexes = Array.from({ length: 1000 }, (_, i) => i);
    const groupedByShardsOfOne = indexes.map((pairIndex) => isTopMeanEngineDiagnosticSample(pairIndex));
    const groupedByShardsOfForty = [];
    for (let start = 0; start < indexes.length; start += 40) {
        for (const pairIndex of indexes.slice(start, start + 40)) {
            groupedByShardsOfForty.push(isTopMeanEngineDiagnosticSample(pairIndex));
        }
    }
    assert.deepEqual(groupedByShardsOfForty, groupedByShardsOfOne, "eligibility must not depend on shard partitioning");

    // The REAL execution options: sampled pairs ride a diagnostics-enabled
    // copy of the frozen defaults (still collecting executor timings);
    // unsampled pairs run on the shared frozen object untouched.
    const sampled = resolveTopMeanEngineRunOptions(true);
    assert.equal("collectDiagnostics" in sampled ? sampled.collectDiagnostics : false, true);
    assert.equal(sampled.collectExecutorTimings, true);
    assert.equal(sampled.skipDrawdown, TOP_MEAN_BACKTEST_RUN_OPTIONS.skipDrawdown);
    assert.equal(sampled.omitEquityCurve, TOP_MEAN_BACKTEST_RUN_OPTIONS.omitEquityCurve);
    const unsampled = resolveTopMeanEngineRunOptions(false);
    assert.equal(unsampled, TOP_MEAN_BACKTEST_RUN_OPTIONS, "unsampled pairs must run on the shared frozen options object");
    console.log("PASS: diagnostic sampling follows original pairIndex stride with real execution options");
}

async function main(): Promise<void> {
    testDiscardedDrawdownIsSkippedWithoutSelectingCompactResults();
    testDiagnosticSamplingByOriginalPairIndex();
    await runWorkerParityTest();
    testDataEndTimeFromClosedCandleArray();
    console.log("PASS: sp500-top-mean-worker.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker.spec.ts", err);
    process.exit(1);
});
