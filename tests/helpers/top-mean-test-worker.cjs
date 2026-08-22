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

if (!isMainThread && parentPort) {
    parentPort.on("message", (data) => {
        if (data.strategyKey === "__test_retry__") {
            parentPort.postMessage({
                type: "error",
                shardIndex: data.shardIndex,
                error: "deterministic retry failure",
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
