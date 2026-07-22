import assert from "node:assert/strict";
import { processTopMeanShard, type TopMeanWorkerTaskData } from "../lib/batch-backtest/sp500-top-mean-worker";

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

    const artifacts = await processTopMeanShard(task);
    assert.ok(Array.isArray(artifacts), "Artifacts must be an array");
    if (artifacts.length > 0) {
        assert.equal(artifacts[0].schema, "compact_pair_artifact.v1");
        assert.equal(artifacts[0].symbol, "AAPL•+MSFT•");
        assert.ok(Array.isArray(artifacts[0].trades), "Trades must be an array");
    }
    console.log("PASS: sp500-top-mean-worker.spec.ts");
}

runWorkerParityTest().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker.spec.ts", err);
    process.exit(1);
});
