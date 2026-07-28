import assert from "node:assert/strict";
import {
    formatTopMeanPerformanceLines,
    type TopMeanPerformanceDiagnostic,
} from "../lib/batch-backtest/sp500-top-mean-performance";

const diagnostic: TopMeanPerformanceDiagnostic = {
    schema: "sp500_top_mean_performance.v1",
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    totalMs: 1_000,
    pairCount: 100,
    completedPairs: 98,
    failedPairs: 2,
    workerCount: 4,
    pairsPerSecond: 98,
    engine: {
        requested: "rust",
        actual: "typescript",
        typescriptRequirementReasons: [
            "execution model is not signal_close",
            "slippage is enabled",
            "same-bar exits are disabled",
        ],
    },
    phases: {
        preflightMs: 10,
        backtestingMs: 600,
        snapshotMs: 20,
        replayMs: 350,
        resultWriteMs: 20,
    },
    replay: {
        scanMs: 10,
        eventsMs: 20,
        targetsMs: 30,
        outcomesMs: 200,
        aggregateMs: 90,
        targetLoadMs: 400,
        targetDatasets: 96,
    },
    worker: {
        workers: 4,
        spawnedWorkers: 4,
        reusedWorkers: 0,
        shards: 15,
        pendingShards: 15,
        shardSize: 7,
        workerBundleMs: 40,
        workerStartupMs: 5,
        wallMs: 600,
        attemptedPairs: 100,
        completedPairs: 98,
        failedPairs: 2,
        loadMs: 300,
        prepareMs: 20,
        backtestMs: 200,
        signalGenerationMs: 40,
        exitProcessingMs: 10,
        exitStrategyMs: 6,
        exitMergeMs: 3,
        exitBookkeepingMs: 1,
        exitOverrideSignals: 0,
        engineMs: 130,
        engineDiagnosticPairs: 4,
        engineDiagnostics: {
            total: 120,
            dataClean: 5,
            indicatorResolution: 10,
            signalPreparation: 15,
            signalIndexing: 5,
            entryEvaluation: 0,
            tradeSimulation: 70,
            forcedClose: 2,
            drawdown: 0,
            metrics: 8,
        },
        artifactMs: 5,
        pairWallMs: 530,
        shardWallMs: 540,
        cache: {
            legHits: 10,
            legMisses: 20,
            pairHits: 0,
            pairMisses: 100,
            diskHits: 80,
            diskMisses: 20,
            diskWrites: 20,
        },
    },
};

const lines = formatTopMeanPerformanceLines(diagnostic);
assert.equal(lines.length, 10);
assert.match(lines[0]!, /total=1000\.0ms/);
assert.match(lines[0]!, /throughput=98\.0 pairs\/s/);
assert.equal(
    lines[1],
    "PERFORMANCE ENGINE | requested=rust | actual=typescript | fallback=execution model is not signal_close; slippage is enabled; same-bar exits are disabled",
);
assert.match(lines[3]!, /targetLoad=400\.0ms\/96/);
assert.match(lines[4]!, /shards=15\/15/);
assert.match(lines[5]!, /load=300\.0ms/);
assert.equal(
    lines[6],
    "PERFORMANCE BACKTEST | signals=40.0ms | exits=10.0ms | engine=130.0ms | other=20.0ms",
);
assert.equal(
    lines[7],
    "PERFORMANCE EXITS | strategy=6.0ms | merge=3.0ms | bookkeeping=1.0ms | overrideSignals=0",
);
assert.match(lines[8]!, /sampled=4/);
assert.match(lines[8]!, /simulation=70\.0ms/);
assert.match(lines[9]!, /disk=80 hit\/20 miss\/20 write/);

console.log("PASS: sp500-top-mean-performance.spec.ts");
