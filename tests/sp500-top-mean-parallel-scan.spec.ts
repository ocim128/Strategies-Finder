import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    iterateRunCompactArtifacts,
    saveManifest,
    writeShardArtifacts,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import { scanArtifacts, type ArtifactScanResult } from "../lib/batch-backtest/open-score-replay/artifact-scan";
import { runParallelArtifactScan } from "../lib/batch-backtest/sp500-top-mean-scan-pool";
import type { CompactPairArtifact, CompactTrade, TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";

const SHARD_COUNT = 8;

function trade(type: "long" | "short", entrySec: number, exitSec: number | null, pnl: number): CompactTrade {
    return {
        type,
        entryTime: new Date(entrySec * 1000).toISOString(),
        exitTime: exitSec === null ? "" : new Date(exitSec * 1000).toISOString(),
        ...(exitSec === null ? { exitReason: "end_of_data" } : {}),
        pnl,
    };
}

function artifact(pairIndex: number, base: string, quote: string, trades: CompactTrade[], netProfit: number): CompactPairArtifact {
    return {
        schema: "compact_pair_artifact.v1",
        pairIndex,
        symbol: `${base}/${quote}`,
        baseAsset: base,
        quoteAsset: quote,
        baseSymbol: `${base}\u2022`,
        quoteSymbol: `${quote}\u2022`,
        trades,
        netProfit,
    };
}

/**
 * 8 shards x 2 artifacts. Deliberately covers: unsorted trade order (per-pair
 * sort), an open end_of_data position, a tradeless pair (omitted but assets
 * indexed + static degree counted), a base==quote pair (omitted, assets NOT
 * indexed), a non-finite pnl stream (pnlKnown false), and cross-shard shared
 * assets (global index reuse in merge order).
 */
function buildArtifacts(): CompactPairArtifact[][] {
    const shards: CompactPairArtifact[][] = [];
    for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
        const base = shard * 100;
        shards.push([
            artifact(base + 0, "AAPL", "MSFT", [
                trade("long", base + 300, base + 400, 25),
                trade("short", base + 100, base + 200, -10),
                trade("long", base + 50, base + 150, 40),
            ], 55),
            artifact(base + 1, "NVDA", "AAPL", [
                trade("long", base + 200, null, 12),
            ], 12),
        ]);
    }
    // Swap in the special cases on shard 0 and 1.
    shards[0]![1] = artifact(1, "TSLA", "TSLA", [trade("long", 10, 20, 5)], 5); // base==quote omit
    shards[1]![0] = artifact(100, "WMT", "HD", [], 0); // tradeless omit
    shards[2]![1] = artifact(201, "KO", "PEP", [
        trade("long", 500, 600, Number.NaN), // non-finite pnl -> pnlKnown false
    ], 30);
    return shards;
}

function saveFixtureRun(baseDir: string, runId: string, shards: CompactPairArtifact[][], opts?: { omitLastShardFile?: boolean }): void {
    // completedShards always CLAIMS every shard; omitLastShardFile leaves the
    // last shard's file unwritten so the manifest lies about a completed shard.
    for (let i = 0; i < shards.length; i += 1) {
        if (opts?.omitLastShardFile && i === shards.length - 1) continue;
        writeShardArtifacts(runId, i, shards[i]!, baseDir);
    }
    const pairCount = shards.reduce((sum, s) => sum + s.length, 0);
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId,
        status: "completed",
        fingerprint: "spec",
        strategyKey: "spec",
        interval: "30m",
        pairCount,
        shardSize: 2,
        totalShards: shards.length,
        completedShards: shards.map((_, i) => i),
        failedShards: [],
        completedPairsCount: pairCount,
        failedPairsCount: 0,
        createdAt: 0,
        updatedAt: 0,
    };
    saveManifest(manifest, baseDir);
}

function bufferView(buffer: ArtifactScanResult): unknown {
    return {
        assetNames: buffer.assetNames,
        validDegree: buffer.validDegree ? [...buffer.validDegree].sort((a, b) => a[0].localeCompare(b[0])) : undefined,
        pairEndpoints: buffer.pairEndpoints,
        retainedDegree: [...buffer.retainedDegree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        pairCount: buffer.pairCount,
        omittedPairs: buffer.omittedPairs,
        profitableStreams: buffer.profitableStreams,
        pnlKnownStreams: buffer.pnlKnownStreams,
        capTiltCoverage: buffer.capTiltCoverage,
        streams: buffer.streams.map((stream) => ({
            timeSecs: [...stream.timeSecs],
            entrySecs: stream.entrySecs ? [...stream.entrySecs] : undefined,
            assetIndices: [...stream.assetIndices],
            deltas: [...stream.deltas],
            pnlShares: [...stream.pnlShares],
            confidenceWeights: [...stream.confidenceWeights],
            flags: [...stream.flags],
        })),
    };
}

async function sequentialScan(runId: string, baseDir: string, enableCausalArms = false): Promise<ArtifactScanResult> {
    const outcome = await scanArtifacts({
        enableCausalArms,
        // Same seam as the coordinator loader: the adapter's partial result
        // satisfies everything the scan consumes.
        artifactLoader: (() => iterateRunCompactArtifacts(runId, baseDir, { strict: true })) as unknown as () => AsyncIterable<BatchSyntheticPairArtifact>,
        shouldStop: () => false,
        onPhase: () => undefined,
        capTiltWeight: null,
        lookupMarketCap: null,
        capTiltActive: false,
        sampleFromSec: undefined,
        sampleToSec: undefined,
    });
    assert.equal(outcome.ok, true, "sequential scan must succeed on the fixture");
    return outcome.result;
}

async function main(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "top-mean-parallel-scan-"));
    try {
        mkdirSync(join(baseDir, "artifacts", "sp500-top-mean"), { recursive: true });
        const shards = buildArtifacts();
        saveFixtureRun(baseDir, "parallel_scan_spec_1", shards);

        // Worker fast path (2 workers) must equal the sequential scan exactly.
        const parallel = await runParallelArtifactScan({
            runId: "parallel_scan_spec_1",
            baseDir,
            shouldStop: () => false,
            workerCount: 2,
        });
        assert.equal(parallel.status, "ok", "parallel scan must succeed on the fixture");
        assert.deepEqual(bufferView(parallel.status === "ok" ? parallel.result : ({} as never)),
            bufferView(await sequentialScan("parallel_scan_spec_1", baseDir)),
            "parallel merge must reproduce the sequential scan result");
        assert.equal(parallel.status === "ok" ? parallel.tradelessPairs : -1, 1,
            "the loader's noTradePairs side count must be preserved");

        const causal = await runParallelArtifactScan({ runId: "parallel_scan_spec_1", baseDir, shouldStop: () => false, workerCount: 2, enableCausalArms: true });
        assert.equal(causal.status, "ok");
        if (causal.status !== "ok") throw new Error("Expected causal parallel scan.");
        assert.deepEqual(bufferView(causal.result), bufferView(await sequentialScan("parallel_scan_spec_1", baseDir, true)));
        assert.equal(causal.result.validDegree!.get("TSLA"), undefined);
        assert.equal(causal.result.validDegree!.get("WMT"), 1);

        // Single-worker path (same-process semantics) must match too.
        const single = await runParallelArtifactScan({
            runId: "parallel_scan_spec_1",
            baseDir,
            shouldStop: () => false,
            workerCount: 1,
        });
        assert.equal(single.status, "ok");
        assert.deepEqual(bufferView(single.status === "ok" ? single.result : ({} as never)),
            bufferView(await sequentialScan("parallel_scan_spec_1", baseDir)),
            "single-worker parallel scan must equal the sequential scan");

        // Below the shard threshold: sequential fallback without spawning.
        saveFixtureRun(baseDir, "parallel_scan_spec_small", shards.slice(0, 2));
        assert.equal((await runParallelArtifactScan({ runId: "parallel_scan_spec_small", baseDir, shouldStop: () => false })).status, "fallback");

        // Missing manifest -> fallback.
        assert.equal((await runParallelArtifactScan({ runId: "no_such_run", baseDir, shouldStop: () => false })).status, "fallback");

        // Manifest claims a completed shard whose file is missing -> fallback
        // (the sequential path re-runs and owns the strict-mode failure).
        saveFixtureRun(baseDir, "parallel_scan_spec_missing", shards, { omitLastShardFile: true });
        assert.equal((await runParallelArtifactScan({ runId: "parallel_scan_spec_missing", baseDir, shouldStop: () => false })).status, "fallback");

        // Immediate stop cancels before merging.
        const cancelled = await runParallelArtifactScan({
            runId: "parallel_scan_spec_1",
            baseDir,
            shouldStop: () => true,
        });
        assert.equal(cancelled.status, "cancelled");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }

    console.log("PASS: sp500-top-mean-parallel-scan.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: sp500-top-mean-parallel-scan.spec.ts", error);
    process.exit(1);
});
