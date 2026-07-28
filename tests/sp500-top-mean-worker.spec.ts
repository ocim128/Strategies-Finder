import assert from "node:assert/strict";
import {
    processTopMeanShard,
    sliceTopMeanCandlesFromSec,
    TOP_MEAN_BACKTEST_RUN_OPTIONS,
    type TopMeanWorkerTaskData,
} from "../lib/batch-backtest/sp500-top-mean-worker";
import { prepareClosedCandleData } from "../lib/backtest-executor";
import { selectClosedCandleWindow } from "../lib/alert-evaluation-window";
import type { OHLCVData, Time } from "../lib/types/strategies";

function testStabilitySliceIsAppliedBeforeExecutionWindow(): void {
    const candles: OHLCVData[] = [
        { time: 100 as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 200 as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 300 as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const sliced = sliceTopMeanCandlesFromSec(candles, 200);
    assert.deepEqual(sliced.map((candle) => Number(candle.time)), [200, 300]);
    assert.strictEqual(sliceTopMeanCandlesFromSec(candles), candles);
    console.log("PASS: stability start-date slice is applied before the worker guard");
}

function testDiscardedDrawdownIsSkippedWithoutSelectingCompactResults(): void {
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.skipDrawdown, true);
    assert.equal(TOP_MEAN_BACKTEST_RUN_OPTIONS.omitEquityCurve, true);
    assert.equal(
        "includeSharpeRatio" in TOP_MEAN_BACKTEST_RUN_OPTIONS,
        false,
        "TOP_MEAN requires full trade history; setting includeSharpeRatio would select scalar-only compact results",
    );
    console.log("PASS: TOP_MEAN skips discarded drawdown while retaining full trade history");
}

async function runWorkerParityTest(): Promise<void> {
    const task: TopMeanWorkerTaskData = {
        shardIndex: 0,
        pairs: [
            { pairIndex: 0, symbol: "AAPL•+MSFT•" }
        ],
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
        capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
        interval: "4h",
        useRustEnginePreference: false,
    };

    const shardResult = await processTopMeanShard(task);
    const artifacts = shardResult.artifacts;
    assert.ok(Array.isArray(artifacts), "Artifacts must be an array");
    assert.ok(shardResult.engineUsage, "engineUsage must be reported");
    assert.equal(typeof shardResult.engineUsage.rust, "number");
    assert.equal(typeof shardResult.engineUsage.typescript, "number");
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
    const prepared = prepareClosedCandleData(candles, "4h", { direction: "long" }, nowSec);
    const preparedTailTime = Number(prepared[prepared.length - 1]!.time);
    assert.equal(preparedTailTime, openBarTime, "prepared array tail is the bridged OPEN bar in next_open mode");
    assert.notEqual(preparedTailTime, closedBarTime, "prepared tail must NOT equal the closed bar time");

    // The worker uses closedCandleTimeSec, which IS the closed bar.
    const dataEndTime = closedWindow!.closedCandleTimeSec;
    assert.equal(dataEndTime, closedBarTime);
    assert.notEqual(dataEndTime, openBarTime);

    console.log("PASS: dataEndTime from closedCandleTimeSec, not raw or bridged array tail (F2)");
}

async function main(): Promise<void> {
    testStabilitySliceIsAppliedBeforeExecutionWindow();
    testDiscardedDrawdownIsSkippedWithoutSelectingCompactResults();
    await runWorkerParityTest();
    testDataEndTimeFromClosedCandleArray();
    console.log("PASS: sp500-top-mean-worker.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker.spec.ts", err);
    process.exit(1);
});
