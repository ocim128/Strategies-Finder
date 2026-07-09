import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildBatchBenchmarkBottlenecks,
    type BatchBenchmarkCacheStats,
    type BatchBenchmarkSnapshot,
} from "../lib/batch-backtest/batch-benchmark-snapshot";
import { createBatchSyntheticMinerProfile } from "../lib/batch-backtest/batch-synthetic-state-miner";

function emptyCache(): BatchBenchmarkCacheStats {
    return {
        syntheticLeg: { hits: 0, misses: 0, hitRate: 0, size: 0, max: 24 },
        syntheticPair: { hits: 0, misses: 0, hitRate: 0, size: 0, max: 16 },
        disk: { hits: 0, misses: 0, hitRate: 0, writes: 0 },
    };
}

describe("batch benchmark bottlenecks", () => {
    it("normalizes summed parallel worker timings before warning about artifact load", () => {
        const profile = createBatchSyntheticMinerProfile();
        profile.candidateSamplesMs = 64_000;
        profile.artifactConversionMs = 14_600;
        profile.parallelWorkerCount = 5;

        const phases: BatchBenchmarkSnapshot["phases"] = {
            run: {
                totalMs: 14_500,
                loaded: 448,
                failed: 0,
                synthetic: 448,
                real: 0,
                avgMsPerLoaded: 32.36,
            },
            mine: null,
            stability: {
                totalMs: 23_400,
                reruns: 5,
                subsetSize: 200,
                totalPairs: 448,
                sampledPairEvaluations: 1000,
                targetAssets: 39,
                targets: 15,
                verdicts: 15,
                hitEvents: 19,
                avgMsPerRerun: 4680,
                avgMsPerSampledPair: 23.4,
                hitEventsPerRerun: 3.8,
                hitEventsPerSampledPair: 0.019,
                minerProfile: profile,
                engine: "typescript_parallel",
                rustFallbackReason: null,
            },
        };

        const notes = buildBatchBenchmarkBottlenecks(phases, emptyCache(), "server_stream");
        expect(notes.some((note) => note.includes("artifact load/conversion"))).to.equal(false);
        expect(notes.some((note) => note.includes("parallel worker CPU is dominated by candidate samples"))).to.equal(true);
    });
});

