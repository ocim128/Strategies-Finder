import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    atomicWriteJson, computeRunFingerprint, getRunDir, getShardPath,
    loadManifest, saveManifest, writeShardArtifacts,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import {
    TopMeanCoordinatorEngine, type TopMeanCoordinatorEngineDeps,
    type TopMeanCoordinatorRunRequest, type TopMeanResultSummary,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import { handleSp500TopMeanStatusRequest } from "../lib/batch-backtest/sp500-top-mean-vite-routes";
import type { EnumerationResult } from "../lib/batch-backtest/sp500-pair-enumerator";
import { CAUSAL_ARM_FIELDS, REPLAY_ARM_TO_FINDER_ARM } from "../lib/batch-backtest/open-score-replay/arm-contract";

async function fixture(deps: TopMeanCoordinatorEngineDeps = {}, replayMode: "horizon" | "asset_switch" = "horizon") {
    const root = await mkdtemp(join(tmpdir(), "top-mean-write-lifecycle-"));
    const request: TopMeanCoordinatorRunRequest = {
        runId: "write_lifecycle", strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20 },
        backtestSettings: {} as TopMeanCoordinatorRunRequest["backtestSettings"],
        capitalSettings: {} as TopMeanCoordinatorRunRequest["capitalSettings"],
        interval: "4h", replayMode, ...(replayMode === "horizon" ? { horizons: [5] } : {}), workerCount: 1,
        resume: true, saveArchiveLog: false, useRustEnginePreference: false,
        sampleFromSec: 1_600_000_000, sampleToSec: 1_601_000_000,
    };
    const enumeration: EnumerationResult = {
        canonicalPairs: ["AAA+BBB"], eligibleAssets: ["AAA", "BBB"], eligibleTargets: [],
        excludedAssets: [], skippedPairTokens: [], rejectedPairTokens: [],
        counts: {
            sp500AssetsCount: 2, catalogAssetsCount: 2, usable30mSeedCount: 2,
            usableTargetIntervalCount: 2, pairCount: 1, excludedAssetsCount: 0, excludedPairsCount: 0,
        },
    };
    writeShardArtifacts(request.runId, 0, [{
        schema: "compact_pair_artifact.v1", pairIndex: 0, symbol: "AAA+BBB",
        baseAsset: "AAA", quoteAsset: "BBB", baseSymbol: "AAA", quoteSymbol: "BBB",
        trades: [], dataEndTime: 1_600_000_000,
    }], root);
    saveManifest({
        schema: "top_mean_run_manifest.v1", runId: request.runId, status: "interrupted",
        fingerprint: computeRunFingerprint({
            strategyKey: request.strategyKey, strategyParams: request.strategyParams,
            backtestSettings: request.backtestSettings, capitalSettings: request.capitalSettings,
            interval: request.interval, useRustEnginePreference: request.useRustEnginePreference,
            canonicalAssets: enumeration.eligibleAssets, canonicalPairs: enumeration.canonicalPairs }),
        strategyKey: request.strategyKey, interval: request.interval, pairCount: 1,
        shardSize: 1, totalShards: 1, completedShards: [0], failedShards: [],
        completedPairsCount: 1, failedPairsCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
        replayMode,
    }, root);
    const engine = new TopMeanCoordinatorEngine(request, root, {
        enumeration, evaluationNowSec: 1_700_000_000, ...deps,
    });
    return { root, request, engine, enumeration };
}

describe("TOP_MEAN coordinator persistence boundaries", () => {
    for (const mode of ["horizon", "asset_switch"] as const) {
        it(`enables all seventeen arms in Batch ${mode}, including annual and restored zero-event sections`, async () => {
            const run = await fixture({}, mode);
            try {
                let result: TopMeanResultSummary | undefined;
                await run.engine.run((event: any) => {
                    assert.notEqual(event.type, "fatal", event.error);
                    if (event.type === "done") result = event.result;
                });
                assert.ok(result);
                assert.equal(result.causalArmDefinitions?.version, "finder-causal-arms-v2");
                assert.ok(result.causalArmDiagnostics);
                assert.equal(result.annualReports?.length, 1);
                const status = await handleSp500TopMeanStatusRequest(run.request.runId, run.root);
                assert.ok(!("ok" in status) && status.result);
                assert.deepEqual(status.result.causalArmDefinitions, result.causalArmDefinitions);
                assert.deepEqual(status.result.causalArmDiagnostics, result.causalArmDiagnostics);
                for (const section of [result, result.annualReports![0]!, status.result, status.result.annualReports![0]!]) {
                    assert.equal(section.causalArmDefinitions?.version, "finder-causal-arms-v2");
                    for (const field of CAUSAL_ARM_FIELDS) {
                        if (mode === "asset_switch") assert.equal(section.assetSwitch!.arms[field]!.status, "no_entry");
                        else {
                            assert.equal(section.horizons[0]!.armComparisons![REPLAY_ARM_TO_FINDER_ARM[field]]!.events, 0);
                            assert.equal(section.horizons[0]!.latestArms![REPLAY_ARM_TO_FINDER_ARM[field]]!.events, 0);
                        }
                    }
                }
            } finally { await rm(run.root, { recursive: true, force: true }); }
        });
    }
    it("persists the snapshot before emitting it and restores real final output through status", async () => {
        const writes: string[] = [];
        const run = await fixture({
            writeResult: async (path, payload) => {
                await atomicWriteJson(path, payload);
                writes.push(path);
            },
        });
        try {
            let result: TopMeanResultSummary | undefined;
            await run.engine.run((event: any) => {
                if (event.type === "current_snapshot") assert.equal(writes.length, 1);
                if (event.type === "done") {
                    assert.equal(writes.length, 2, "done waits for the final atomic write");
                    result = event.result;
                }
                assert.notEqual(event.type, "fatal", event.error);
            });
            assert.ok(result);
            const disk = JSON.parse(await readFile(join(getRunDir(run.request.runId, run.root), "result.json"), "utf8"));
            assert.equal(disk.runId, run.request.runId);
            assert.deepEqual(disk.counts, run.enumeration.counts);
            assert.ok("complete" in disk, "raw replay format remains on disk");
            assert.equal(disk.noTradePairs, 1);
            const status = await handleSp500TopMeanStatusRequest(run.request.runId, run.root);
            assert.ok(!("ok" in status) && status.result);
            assert.equal(status.result.runId, result.runId);
            assert.equal(status.result.completed, result.completed);
            assert.deepEqual(status.result.counts, result.counts);
            assert.deepEqual(status.result.horizons, result.horizons);
            assert.deepEqual(status.result.currentSnapshot, JSON.parse(JSON.stringify(result.currentSnapshot)));
            assert.equal(status.result.noTradePairs, result.noTradePairs);
        } finally { await rm(run.root, { recursive: true, force: true }); }
    });

    for (const stopAtWrite of [1, 2]) {
        it(`lets Stop win during asynchronous result write ${stopAtWrite}`, async () => {
            let writes = 0;
            let releaseWrite!: () => void;
            let enteredWrite!: () => void;
            const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
            const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
            const run = await fixture({
                writeResult: async (path, payload) => {
                    if (++writes === stopAtWrite) {
                        enteredWrite();
                        await release;
                    }
                    await atomicWriteJson(path, payload);
                },
            });
            const events: any[] = [];
            try {
                const running = run.engine.run((event) => events.push(event));
                await Promise.race([entered, running.then(() => { throw new Error("Run ended before the expected write."); })]);
                assert.equal(events.some((event) => event.type === "done"), false);
                run.engine.stop();
                releaseWrite();
                await running;
                assert.equal(events.at(-1).type, "done");
                assert.equal(events.at(-1).interrupted, true);
                assert.equal(events.at(-1).result, undefined);
                assert.equal(loadManifest(run.request.runId, run.root)?.status, "interrupted");
            } finally {
                releaseWrite();
                await run.engine.waitForTeardown();
                await rm(run.root, { recursive: true, force: true });
            }
        });
    }

    for (const profile of [undefined, "finder_arm"] as const) {
        for (const corruption of ["missing", "invalid_json"] as const) {
            it(`fails ${profile ?? "standalone"} on a ${corruption} completed shard`, async () => {
                const run = await fixture({ executionProfile: profile });
                try {
                    const path = getShardPath(run.request.runId, 0, run.root);
                    if (corruption === "missing") await rm(path);
                    else await writeFile(path, "{broken");
                    const events: any[] = [];
                    await run.engine.run((event) => events.push(event));
                    assert.equal(events.at(-1).type, "fatal");
                    assert.match(events.at(-1).error, new RegExp(`write_lifecycle.*shard 0.*${corruption}`));
                    assert.equal(events.some((event) => event.type === "done"), false);
                    assert.equal(loadManifest(run.request.runId, run.root)?.status, "failed");
                } finally { await rm(run.root, { recursive: true, force: true }); }
            });
        }
    }
});
