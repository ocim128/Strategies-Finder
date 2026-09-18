const { isMainThread, parentPort } = require("node:worker_threads");

function timing(data) {
    return {
        attemptedPairs: data.pairs.length,
        completedPairs: data.pairs.length,
        failedPairs: 0,
        loadMs: 0,
        prepareMs: 0,
        backtestMs: 0,
        signalGenerationMs: 0,
        exitProcessingMs: 0,
        exitStrategyMs: 0,
        exitStrategyLoadMs: 0,
        exitStrategyNormalizeMs: 0,
        exitSignalGenerationMs: 0,
        exitMergeMs: 0,
        exitBookkeepingMs: 0,
        exitOverrideSignals: 0,
        engineMs: 0,
        engineDiagnosticPairs: 0,
        engineDiagnostics: {
            total: 0,
            dataClean: 0,
            indicatorResolution: 0,
            signalPreparation: 0,
            signalIndexing: 0,
            entryEvaluation: 0,
            tradeSimulation: 0,
            forcedClose: 0,
            drawdown: 0,
            metrics: 0,
        },
        artifactMs: 0,
        pairWallMs: 0,
        shardWallMs: 0,
        cache: {
            legHits: 0,
            legMisses: 0,
            pairHits: 0,
            pairMisses: 0,
            diskHits: 0,
            diskMisses: 0,
            diskWrites: 0,
        },
    };
}

// Deterministic fixture for the retry-success manifest finding (worker pool
// audit). The FIRST task this worker receives posts a type:"error" message
// (which records the shard in failedShards); every LATER task completes
// normally. The retried shard therefore lands in BOTH failedShards and
// completedShards unless the pool clears the failure when the durable write
// succeeds — exactly what the pool spec asserts.
if (!isMainThread && parentPort) {
    let firstTask = true;
    parentPort.on("message", (data) => {
        if (firstTask) {
            firstTask = false;
            parentPort.postMessage({
                type: "error",
                shardIndex: data.shardIndex,
                error: "deterministic first-attempt failure",
            });
            return;
        }
        for (const pair of data.pairs) {
            parentPort.postMessage({
                type: "progress",
                shardIndex: data.shardIndex,
                pairIndex: pair.pairIndex,
                symbol: pair.symbol,
                status: "completed",
                engineUsed: "typescript",
            });
        }
        parentPort.postMessage({
            type: "shard_complete",
            shardIndex: data.shardIndex,
            artifacts: [],
            engineUsage: { rust: 0, typescript: data.pairs.length },
            performance: timing(data),
        });
    });
}
