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
    readShardArtifactsAsync,
    TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES,
    iterateRunCompactArtifacts,
    iterateRunRawCompactArtifacts,
    iterateRunShardsWithReadAhead,
    TOP_MEAN_SHARD_READ_AHEAD,
    reconcileInterruptedManifestsOnStartup,
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
            canonicalPairs: ["AAPL•+MSFT•"],
        });
        const fp2 = computeRunFingerprint({
            strategyKey: "test_strategy",
            strategyParams: { p: 1 },
            backtestSettings: { mode: "long" },
            capitalSettings: { initial: 10000 },
            interval: "4h",
            canonicalAssets: ["AAPL", "MSFT"],
            canonicalPairs: ["AAPL•+MSFT•"],
        });
        assert.equal(fp1, fp2, "Identical inputs must yield identical fingerprints");

        // 1b. Resume safety (audit resume-fingerprint finding): the ordered
        // pair sequence is part of the fingerprint — a resume against the
        // same assets but a re-cut pair list must NOT match.
        const fpDifferentPairs = computeRunFingerprint({
            strategyKey: "test_strategy",
            strategyParams: { p: 1 },
            backtestSettings: { mode: "long" },
            capitalSettings: { initial: 10000 },
            interval: "4h",
            canonicalAssets: ["AAPL", "MSFT"],
            canonicalPairs: ["MSFT•+AAPL•", "AAPL•+MSFT•"],
        });
        assert.notEqual(fp1, fpDifferentPairs, "Different pair composition must change the fingerprint");

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
                netProfit: 123.45,
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
        // The adapter must carry netProfit through: the pnl-gated OPEN_SCORE
        // arms (TOP_RAW_PROFIT / TOP_MEAN_PROFIT) read it off result.
        assert.equal(yielded[0].result.netProfit, 123.45);

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

        // Shard-overhead plan phase 3: bounded ordered read-ahead.
        const readAheadRunId = "spec_read_ahead_run";
        const readAheadShards: CompactPairArtifact[][] = [];
        for (let shardIndex = 0; shardIndex < 10; shardIndex += 1) {
            const shardArtifacts: CompactPairArtifact[] = [
                {
                    schema: "compact_pair_artifact.v1",
                    pairIndex: shardIndex,
                    symbol: `PAIR\u2022${shardIndex}+OTHER\u2022${shardIndex}`,
                    baseAsset: `PAIR\u2022${shardIndex}`,
                    quoteAsset: `OTHER\u2022${shardIndex}`,
                    baseSymbol: `PAIR\u2022${shardIndex}`,
                    quoteSymbol: `OTHER\u2022${shardIndex}`,
                    trades: [],
                    netProfit: shardIndex,
                },
            ];
            readAheadShards.push(shardArtifacts);
            writeShardArtifacts(readAheadRunId, shardIndex, shardArtifacts, testBaseDir);
        }
        const readAheadManifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId: readAheadRunId,
            status: "completed",
            fingerprint: "readahead",
            strategyKey: "test_strategy",
            interval: "4h",
            pairCount: 10,
            shardSize: 1,
            totalShards: 10,
            completedShards: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            failedShards: [],
            completedPairsCount: 10,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveManifest(readAheadManifest, testBaseDir);

        // (a) Raw and adapted sequences match the serial baseline exactly.
        const rawSequence: number[] = [];
        for await (const artifact of iterateRunRawCompactArtifacts(readAheadRunId, testBaseDir)) {
            rawSequence.push(artifact.pairIndex);
        }
        assert.deepEqual(rawSequence, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "raw iterator preserves completedShards order");
        const adaptedSequence: number[] = [];
        for await (const adapter of iterateRunCompactArtifacts(readAheadRunId, testBaseDir)) {
            adaptedSequence.push(adapter.result.netProfit as number);
        }
        assert.deepEqual(adaptedSequence, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "adapted iterator preserves the same order");

        // (b) Out-of-order completion: an injected reader resolving shards in
        // REVERSE order must not change the consumed order, and concurrent
        // reads must stay within the four-slot window (a 10-shard manifest
        // keeps the whole window busy).
        let activeReads = 0;
        let maxActiveReads = 0;
        const readAheadHarness = async (_runIdArg: string, shardIndex: number): Promise<CompactPairArtifact[] | null> => {
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            const shardArtifacts = readAheadShards[shardIndex]!;
            const delayMs = (readAheadShards.length - shardIndex) * 5;
            await new Promise((resolveTick) => setTimeout(resolveTick, delayMs));
            activeReads -= 1;
            return shardArtifacts;
        };
        const reordered: number[] = [];
        for await (const artifact of iterateRunShardsWithReadAhead(readAheadRunId, testBaseDir, (a) => a, readAheadHarness)) {
            reordered.push(artifact.pairIndex);
        }
        assert.deepEqual(reordered, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "out-of-order completion must not change consumed order");
        assert.ok(
            maxActiveReads <= TOP_MEAN_SHARD_READ_AHEAD,
            `concurrent reads must stay within the window (peak ${maxActiveReads})`,
        );
        assert.equal(maxActiveReads, TOP_MEAN_SHARD_READ_AHEAD, "a long manifest keeps the full read-ahead window busy");

        // (c) Early iterator return: reads started before the exit are all
        // settled (no orphaned background work). The window refills as slots
        // are consumed, so one refill may land before the consumer sees the
        // first artifact and breaks: 4 initial reads + 1 refill, never more.
        let earlyStarted = 0;
        let earlySettled = 0;
        const earlyHarness = async (_runIdArg: string, shardIndex: number): Promise<CompactPairArtifact[] | null> => {
            earlyStarted += 1;
            await new Promise((resolveTick) => setTimeout(resolveTick, 5));
            earlySettled += 1;
            return readAheadShards[shardIndex]!;
        };
        const earlyIterator = iterateRunShardsWithReadAhead(readAheadRunId, testBaseDir, (a) => a, earlyHarness);
        for await (const artifact of earlyIterator) {
            if (artifact.pairIndex === 0) break;
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 60));
        assert.ok(earlyStarted <= TOP_MEAN_SHARD_READ_AHEAD + 1, `no reads scheduled past the consumed slot's refill (started ${earlyStarted})`);
        assert.equal(earlySettled, earlyStarted, `every started read settles (started ${earlyStarted}, settled ${earlySettled})`);

        // (d) Unreadable shards are skipped exactly like the serial reader.
        const { getShardPath } = await import("../lib/batch-backtest/sp500-top-mean-artifact-store");
        const fsModule = await import("node:fs");
        fsModule.rmSync(getShardPath(readAheadRunId, 4, testBaseDir), { force: true });
        const withHole: number[] = [];
        for await (const artifact of iterateRunRawCompactArtifacts(readAheadRunId, testBaseDir)) {
            withHole.push(artifact.pairIndex);
        }
        assert.deepEqual(withHole, [0, 1, 2, 3, 5, 6, 7, 8, 9], "an unreadable shard is skipped without breaking order");

        // (e) mtime invalidation still applies through the read-ahead path:
        // replacing a shard file yields the new content on the next pass.
        const replacement: CompactPairArtifact[] = [
            {
                schema: "compact_pair_artifact.v1",
                pairIndex: 5,
                symbol: "REPLACED",
                baseAsset: "REPLACED",
                quoteAsset: "OTHER",
                baseSymbol: "REPLACED",
                quoteSymbol: "OTHER",
                trades: [],
            },
        ];
        writeShardArtifacts(readAheadRunId, 5, replacement, testBaseDir);
        const afterReplace: string[] = [];
        for await (const artifact of iterateRunRawCompactArtifacts(readAheadRunId, testBaseDir)) {
            afterReplace.push(artifact.symbol);
        }
        assert.ok(afterReplace.includes("REPLACED"), "a replaced shard is re-read, not served stale from the parsed cache");

        // (f) Empty manifest yields nothing.
        saveManifest({ ...readAheadManifest, completedShards: [] }, testBaseDir);
        const empty: number[] = [];
        for await (const artifact of iterateRunRawCompactArtifacts(readAheadRunId, testBaseDir)) {
            empty.push(artifact.pairIndex);
        }
        assert.equal(empty.length, 0);

        console.log("PASS: read-ahead shard iterator: order, window bound, early exit, holes, mtime, empty");

        // Large trade histories must evict by bytes before the 32-entry cap.
        const largeRow = {
            ...readAheadShards[0]![0]!,
            symbol: "X".repeat(Math.ceil(TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES / 3)),
        };
        const largeRunId = "spec_cache_byte_budget";
        const retained: CompactPairArtifact[][] = [];
        for (let i = 0; i < 3; i += 1) {
            writeShardArtifacts(largeRunId, i, [largeRow], testBaseDir);
            const parsed = await readShardArtifactsAsync(largeRunId, i, testBaseDir);
            assert.ok(parsed);
            retained.push(parsed);
        }
        assert.strictEqual(await readShardArtifactsAsync(largeRunId, 2, testBaseDir), retained[2], "newest shard remains cached");
        assert.notStrictEqual(await readShardArtifactsAsync(largeRunId, 0, testBaseDir), retained[0], "byte pressure evicts the oldest shard even with only three entries");
        writeShardArtifacts(largeRunId, 3, [{
            ...largeRow, symbol: "X".repeat(TOP_MEAN_PARSED_SHARD_CACHE_MAX_JSON_BYTES + 1),
        }], testBaseDir);
        const oversized = await readShardArtifactsAsync(largeRunId, 3, testBaseDir);
        assert.ok(oversized);
        assert.notStrictEqual(await readShardArtifactsAsync(largeRunId, 3, testBaseDir), oversized, "oversized shards are readable but never cached");
        console.log("PASS: parsed shard cache byte budget and oversized bypass");
    } finally {
        cleanup();
    }
}

runTests();
