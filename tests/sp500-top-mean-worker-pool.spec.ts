import assert from "node:assert/strict";
import { resolveTopMeanWorkerCount, TopMeanWorkerPool } from "../lib/batch-backtest/sp500-top-mean-worker-pool";

function testWorkerCountResolution(): void {
    const defaultCount = resolveTopMeanWorkerCount();
    assert.ok(defaultCount >= 1 && defaultCount <= 24, "Default worker count must be within [1, 24]");

    const explicitCount = resolveTopMeanWorkerCount(12);
    assert.equal(explicitCount, 12, "Explicit worker count 12 must be respected");

    const clampedHigh = resolveTopMeanWorkerCount(32);
    assert.equal(clampedHigh, 24, "Worker count above max must be clamped to 24");
}

function testWorkerPoolCancel(): void {
    const pool = new TopMeanWorkerPool();
    pool.cancel();
    assert.ok(true, "Pool cancellation should succeed cleanly");
}

async function testWorkerPathResolution(): Promise<void> {
    const { resolveTopMeanWorkerPath } = await import("../lib/batch-backtest/sp500-top-mean-worker-pool");
    const path = await resolveTopMeanWorkerPath();
    assert.ok(typeof path === "string" && path.length > 0, "Worker path must be resolved");
}

async function main(): Promise<void> {
    testWorkerCountResolution();
    testWorkerPoolCancel();
    await testWorkerPathResolution();
    console.log("PASS: sp500-top-mean-worker-pool.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker-pool.spec.ts", err);
    process.exit(1);
});
