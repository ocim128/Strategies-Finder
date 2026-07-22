import assert from "node:assert/strict";
import { TopMeanCoordinatorEngine } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";

async function testEngineValidationAndConflict(): Promise<void> {
    const request = {
        runId: "spec_test_run_1",
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20 },
        backtestSettings: { mode: "long" },
        capitalSettings: { initialCapital: 10000 },
        interval: "4h",
        horizons: [12, 24, 48],
        maxPairs: 2,
    };

    const engine = new TopMeanCoordinatorEngine(request as any);
    const status = engine.getStatus();

    assert.equal(status.runId, "spec_test_run_1");
    assert.equal(status.status, "running");
    assert.equal(status.phase, "preflight");

    // Test stop
    engine.stop();
    const stoppedStatus = engine.getStatus();
    assert.equal(stoppedStatus.phase, "interrupted");

    console.log("PASS: sp500-top-mean-server-plugin.spec.ts");
}

testEngineValidationAndConflict().catch((err) => {
    console.error("FAIL: sp500-top-mean-server-plugin.spec.ts", err);
    process.exit(1);
});
