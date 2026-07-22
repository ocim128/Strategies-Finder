import assert from "node:assert/strict";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CompactPairArtifact, TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import {
    computeRunFingerprint,
    saveManifest,
    loadManifest,
    writeShardArtifacts,
    readShardArtifacts,
    iterateRunCompactArtifacts,
    reconcileInterruptedManifestsOnStartup,
    getArtifactsRootDir,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";

const testBaseDir = resolve(process.cwd(), "temp_test_artifacts");

function cleanup(): void {
    if (existsSync(testBaseDir)) {
        rmSync(testBaseDir, { recursive: true, force: true });
    }
}

async function runTests(): Promise<void> {
    cleanup();
    mkdirSync(testBaseDir, { recursive: true });

    try {
        // 1. Test Fingerprint
        const fp1 = computeRunFingerprint({
            strategyKey: "test_strategy",
            strategyParams: { p: 1 },
            backtestSettings: { mode: "long" },
            capitalSettings: { initial: 10000 },
            interval: "4h",
            canonicalAssets: ["AAPL", "MSFT"],
        });
        const fp2 = computeRunFingerprint({
            strategyKey: "test_strategy",
            strategyParams: { p: 1 },
            backtestSettings: { mode: "long" },
            capitalSettings: { initial: 10000 },
            interval: "4h",
            canonicalAssets: ["AAPL", "MSFT"],
        });
        assert.equal(fp1, fp2, "Identical inputs must yield identical fingerprints");

        // 2. Test Manifest Save & Load
        const runId = "test_run_123";
        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "running",
            fingerprint: fp1,
            strategyKey: "test_strategy",
            interval: "4h",
            pairCount: 1,
            shardSize: 10,
            totalShards: 1,
            completedShards: [],
            failedShards: [],
            completedPairsCount: 0,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        saveManifest(manifest, testBaseDir);
        const loaded = loadManifest(runId, testBaseDir);
        assert.ok(loaded !== null);
        assert.equal(loaded?.runId, runId);
        assert.equal(loaded?.status, "running");

        // 3. Test Shard Write & Read
        const compactArtifacts: CompactPairArtifact[] = [
            {
                schema: "compact_pair_artifact.v1",
                pairIndex: 0,
                symbol: "AAPL•+MSFT•",
                baseAsset: "AAPL•",
                quoteAsset: "MSFT•",
                baseSymbol: "AAPL",
                quoteSymbol: "MSFT",
                trades: [
                    {
                        type: "long",
                        entryTime: 1000 as any,
                        exitTime: 2000 as any,
                        exitReason: "take_profit",
                    },
                ],
            },
        ];

        writeShardArtifacts(runId, 0, compactArtifacts, testBaseDir);
        const readShard = readShardArtifacts(runId, 0, testBaseDir);
        assert.ok(readShard !== null);
        assert.equal(readShard?.length, 1);
        assert.equal(readShard?.[0].symbol, "AAPL•+MSFT•");

        // Update manifest with completed shard
        manifest.completedShards.push(0);
        manifest.status = "completed";
        saveManifest(manifest, testBaseDir);

        // 4. Test Iterate Compact Artifacts Async Generator
        const yielded: any[] = [];
        for await (const item of iterateRunCompactArtifacts(runId, testBaseDir)) {
            yielded.push(item);
        }
        assert.equal(yielded.length, 1);
        assert.equal(yielded[0].symbol, "AAPL•+MSFT•");
        assert.equal(yielded[0].result.trades.length, 1);

        // 5. Startup Interrupted Manifest Reconciliation
        const runId2 = "test_run_running";
        const runningManifest: TopMeanRunManifest = {
            ...manifest,
            runId: runId2,
            status: "running",
        };
        saveManifest(runningManifest, testBaseDir);
        reconcileInterruptedManifestsOnStartup(testBaseDir);
        const reconciled = loadManifest(runId2, testBaseDir);
        assert.equal(reconciled?.status, "interrupted", "Running manifest should be marked interrupted on startup");

        console.log("PASS: compact-pair-artifact.spec.ts");
    } finally {
        cleanup();
    }
}

runTests();
