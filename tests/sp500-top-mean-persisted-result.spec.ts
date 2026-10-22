import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { atomicWriteJson, getRunDir, saveManifest } from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import { normalizePersistedTopMeanResult } from "../lib/batch-backtest/sp500-top-mean-persisted-result";
import { handleSp500TopMeanStatusRequest } from "../lib/batch-backtest/sp500-top-mean-vite-routes";
import { buildTopMeanHorizonSummaries, toWireSafeTopMeanResultSummary, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import { buildReplayComparison } from "../lib/batch-backtest/open-score-replay/statistics";
import { FINDER_ARM_PERFORMANCE_REPLAY_FIELDS } from "../lib/finder/finder-arm-performance-metrics";
import type { OpenScoreUsdReplayResult } from "../lib/batch-backtest/open-score-replay/types";
import type { TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { TopMeanResultReader, resultFileVersion } from "../lib/batch-backtest/sp500-top-mean-result-reader";

function manifest(): TopMeanRunManifest {
    return {
        schema: "top_mean_run_manifest.v1", runId: "persisted_contract", status: "completed",
        fingerprint: "fixture", strategyKey: "fixture", interval: "4h", pairCount: 1,
        shardSize: 1, totalShards: 1, completedShards: [0], failedShards: [],
        completedPairsCount: 1, failedPairsCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
}

function rawFixture() {
    const comparison = buildReplayComparison([0.01, 0.02], [0.03, 0.04], [1, 2], 2, 200);
    const arms = Object.fromEntries(Object.values(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((field) => [field, comparison]));
    return {
        mode: "horizon" as const, pairs: 1, assets: 2, complete: true,
        horizons: [{
            bars: 5, ...arms,
            topMeanByAsset: [
                { asset: "BBB", events: 1, topMean: 0.03, randomMean: 0.02, delta: 0.01 },
                { asset: "AAA", events: 1, topMean: 0.04, randomMean: 0.02, delta: 0.02 },
            ],
        }],
        eventDetails: Array.from({ length: TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55 }, (_, index) => ({
            decisionTime: index, entryTime: index + 1, exitTime: index + 6,
            horizonBars: 5, selector: "TOP_MEAN" as const, direction: "long" as const,
            asset: "AAA", selectedReturn: 0.03, controlReturn: 0.02, delta: 0.01, eligibleCandidates: 2,
        })),
        warnings: ["fixture warning"], reportLines: ["fixture report"],
    };
}

describe("TOP_MEAN persisted result normalization", () => {
    it("coalesces restored reads and invalidates on manifest revision, replacement, and deletion", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-result-cache-"));
        const runManifest = manifest();
        const path = join(getRunDir(runManifest.runId, root), "result.json");
        let reads = 0;
        const reader = new TopMeanResultReader(async (file) => { reads++; return readFile(file, "utf8"); });
        try {
            await atomicWriteJson(path, { horizons: [], reportLines: ["first"] });
            const [first, joined] = await Promise.all([reader.load(path, runManifest), reader.load(path, runManifest)]);
            assert.deepEqual(first, joined);
            assert.equal(reads, 1);
            await reader.load(path, runManifest);
            assert.equal(reads, 1, "unchanged results skip parsing and normalization");
            const updated = await reader.load(path, { ...runManifest, pairCount: 9, archiveComplete: true });
            assert.equal(reads, 2);
            assert.equal(updated.counts.pairCount, 9);
            assert.equal(updated.archiveComplete, true);
            const before = await stat(path);
            await atomicWriteJson(path, { horizons: [], reportLines: ["other"] });
            await utimes(path, before.atime, before.mtime);
            const replaced = await reader.load(path, runManifest);
            assert.equal(reads, 3, "same-size atomic replacement invalidates even with restored mtime");
            assert.deepEqual(replaced.reportLines, ["other"]);
            await rm(path);
            await assert.rejects(reader.load(path, runManifest), { code: "ENOENT" });
            await atomicWriteJson(path, { horizons: [], reportLines: ["retry"] });
            assert.deepEqual((await reader.load(path, runManifest)).reportLines, ["retry"]);
            assert.equal(reads, 4);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("bounds cached summary bytes and entries and retries failures", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-result-budget-"));
        const runManifest = manifest();
        let reads = 0;
        const read = async (path: string) => { reads++; return readFile(path, "utf8"); };
        const pathA = join(root, "a.json");
        const pathB = join(root, "b.json");
        try {
            await atomicWriteJson(pathA, { horizons: [] });
            await atomicWriteJson(pathB, { horizons: [] });
            const reader = new TopMeanResultReader(read, 1);
            await reader.load(pathA, runManifest);
            await reader.load(pathB, runManifest);
            await reader.load(pathA, runManifest);
            assert.equal(reads, 3, "entry eviction releases the old summary");
            const oneSummary = await reader.load(pathA, runManifest);
            const jsonBytes = Buffer.byteLength(JSON.stringify(oneSummary));
            const byteBounded = new TopMeanResultReader(read, 4, Math.floor(jsonBytes * 1.5));
            const beforeBudget = reads;
            await byteBounded.load(pathA, runManifest);
            await byteBounded.load(pathB, runManifest);
            await byteBounded.load(pathA, runManifest);
            assert.equal(reads - beforeBudget, 3, "combined byte budget evicts even below the entry cap");
            const uncached = new TopMeanResultReader(read, 4, 1);
            const beforeUncached = reads;
            await uncached.load(pathA, runManifest);
            await uncached.load(pathA, runManifest);
            assert.equal(reads - beforeUncached, 2, "oversized summaries bypass retention");
            await atomicWriteJson(pathA, { horizons: "invalid" });
            const beforeFailure = reads;
            await assert.rejects(reader.load(pathA, runManifest));
            await assert.rejects(reader.load(pathA, runManifest));
            assert.equal(reads - beforeFailure, 2, "failed reads never remain cached or pending");
            await atomicWriteJson(pathA, { horizons: [] });
            assert.ok(await reader.load(pathA, runManifest));
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("prevents a slower old manifest read from evicting a newer summary", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-result-order-"));
        const path = join(root, "result.json");
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let reads = 0;
        const reader = new TopMeanResultReader(async (file) => {
            if (++reads === 1) { entered(); await blocked; }
            return readFile(file, "utf8");
        });
        try {
            await atomicWriteJson(path, { horizons: [] });
            const old = reader.load(path, manifest());
            await started;
            const newerManifest = { ...manifest(), pairCount: 12 };
            await reader.load(path, newerManifest);
            release();
            await old;
            assert.equal((await reader.load(path, newerManifest)).counts.pairCount, 12);
            assert.equal(reads, 2);
        } finally { release(); await rm(root, { recursive: true, force: true }); }
    });

    it("validates download bytes once per exact revision without caching invalid JSON", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-download-validation-"));
        const path = join(root, "result.json");
        const reader = new TopMeanResultReader();
        let reads = 0;
        const read = async () => { reads++; return readFile(path, "utf8"); };
        try {
            await atomicWriteJson(path, { horizons: [] });
            const version = resultFileVersion(await stat(path, { bigint: true }));
            await reader.validateDownload(path, version, read);
            await reader.validateDownload(path, version, read);
            assert.equal(reads, 1);
            await assert.rejects(reader.validateDownload(path, "corrupted-revision", async () => "{"));
            await assert.rejects(reader.validateDownload(path, "corrupted-revision", async () => "{"));
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("does not publish an older file read after a newer atomic replacement", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-result-replacement-"));
        const path = join(root, "result.json");
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let reads = 0;
        const reader = new TopMeanResultReader(async (file) => {
            const ordinal = ++reads;
            const text = await readFile(file, "utf8");
            if (ordinal === 1) { entered(); await blocked; }
            return text;
        });
        try {
            await atomicWriteJson(path, { horizons: [], reportLines: ["old"] });
            const runManifest = manifest();
            const old = reader.load(path, runManifest);
            await started;
            await atomicWriteJson(path, { horizons: [], reportLines: ["new"] });
            await reader.load(path, runManifest);
            release();
            assert.deepEqual((await old).reportLines, ["old"]);
            assert.deepEqual((await reader.load(path, runManifest)).reportLines, ["new"]);
            assert.equal(reads, 2, "stale completion preserves the newer cached summary");
        } finally { release(); await rm(root, { recursive: true, force: true }); }
    });

    it("drops retired arms from historical summaries, previews and wire responses", () => {
        const raw = rawFixture();
        Object.assign(raw.horizons[0]!, { topCoverage: raw.horizons[0]!.topMeanByAsset });
        const saved = normalizePersistedTopMeanResult({
            ...raw,
            assetSwitch: { arms: { topMean: { totalNetPnl: 7 }, topStableSupport: { totalNetPnl: 8 }, topCoverage: { totalNetPnl: 9 } },
                trades: [{ arm: "topStableSupport", asset: "A" }, { arm: "topGraphStrength", asset: "B" }] },
            latestSelections: { selections: [{ selector: "TOP_STABLE_SUPPORT" }, { selector: "TOP_PRICE_STRENGTH" }] },
        }, manifest());
        assert.ok(saved);
        assert.deepEqual(Object.keys(saved.assetSwitch!.arms), ["topMean", "topStableSupport"]);
        assert.equal(saved.assetSwitch!.trades!.length, 1);
        assert.deepEqual(saved.latestSelections!.selections.map((row) => row.selector), ["TOP_STABLE_SUPPORT"]);
        const wire = toWireSafeTopMeanResultSummary(saved);
        assert.deepEqual(wire.assetSwitch!.arms, saved.assetSwitch!.arms);
        assert.ok(!JSON.stringify(wire).includes("topCoverage"));
        assert.ok(!JSON.stringify(wire).includes("TOP_PRICE_STRENGTH"));
    });

    it("caps production-shaped raw replay files and restores UI identifiers through status", async () => {
        const root = await mkdtemp(join(tmpdir(), "top-mean-persisted-"));
        const runManifest = manifest();
        const raw = rawFixture();
        try {
            saveManifest(runManifest, root);
            const path = join(getRunDir(runManifest.runId, root), "result.json");
            // Same full raw replay + additive metadata shape as the coordinator.
            await atomicWriteJson(path, {
                ...raw, replayMode: "horizon", selectionCooldownBars: 7,
                counts: { pairCount: 1, usableTargetIntervalCount: 2 },
                annualReports: [{
                    year: 2024, sampleFromSec: 1, sampleToSec: 2,
                    horizons: buildTopMeanHorizonSummaries(raw as unknown as OpenScoreUsdReplayResult),
                    eventDetails: raw.eventDetails.slice(0, 3), warnings: [], reportLines: [],
                }],
            });
            const status = await handleSp500TopMeanStatusRequest(runManifest.runId, root);
            assert.ok(!("ok" in status) && status.result);
            const result = status.result;
            assert.equal(result.runId, runManifest.runId);
            assert.equal(result.completed, true);
            assert.equal(result.selectionCooldownBars, 7);
            assert.equal(result.counts.usableTargetIntervalCount, 2);
            assert.equal(result.horizons[0]!.horizon, 5);
            assert.equal(result.horizons[0]!.events, 2);
            assert.deepEqual(result.horizons[0]!.topAssets.map((row) => row.asset), ["AAA", "BBB"]);
            assert.deepEqual(result.horizons[0]!.armComparisons?.TOP_RAW_PROFIT_NOW,
                result.horizons[0]!.topMean);
            assert.equal(result.openScoreEventDetails?.length, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS);
            assert.equal(result.openScoreEventDetailCount, raw.eventDetails.length);
            assert.equal(result.openScoreEventDetails?.[0]!.decisionTime, 55);
            assert.equal("eventDetails" in result, false, "raw alias must never bypass the cap");
            assert.equal("pairs" in result, false);
            assert.equal(result.annualReports?.[0]!.eventDetails, undefined);
            assert.equal(result.annualReports?.[0]!.eventDetailCount, 3);
            const disk = JSON.parse(await readFile(path, "utf8"));
            assert.equal(disk.eventDetails.length, raw.eventDetails.length, "full disk rows remain intact");
            assert.equal(disk.horizons[0].bars, 5);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("keeps summary files and exact pre-cap counts readable without mutating raw horizons", () => {
        const raw = rawFixture();
        const originalOrder = raw.horizons[0]!.topMeanByAsset.map((row) => row.asset);
        const summary = normalizePersistedTopMeanResult(raw, manifest());
        assert.ok(summary);
        assert.equal(summary.counts.pairCount, 1, "legacy files use the manifest pair count");
        assert.deepEqual(raw.horizons[0]!.topMeanByAsset.map((row) => row.asset), originalOrder);
        const wire = toWireSafeTopMeanResultSummary(summary);
        const restored = normalizePersistedTopMeanResult(wire, manifest());
        assert.ok(restored);
        assert.deepEqual(restored.horizons, wire.horizons);
        assert.equal(toWireSafeTopMeanResultSummary(restored).openScoreEventDetailCount, raw.eventDetails.length);
        assert.equal("eventDetails" in restored, false);
    });

    it("restores snapshot checkpoints and switch results without inventing horizon statistics", () => {
        const snapshot = { snapshot: { asOf: 123, winners: [] } };
        const restored = normalizePersistedTopMeanResult({ currentSnapshot: snapshot },
            { ...manifest(), status: "interrupted" });
        assert.ok(restored);
        assert.equal(restored.completed, false);
        assert.deepEqual(restored.currentSnapshot, snapshot);
        assert.deepEqual(restored.horizons, []);
        const switchResult = normalizePersistedTopMeanResult({
            mode: "asset_switch", horizons: [], assetSwitch: { decisionCount: 3 },
        }, manifest());
        assert.equal(switchResult?.replayMode, "asset_switch");
        assert.equal(switchResult?.assetSwitch?.decisionCount, 3);
        assert.deepEqual(switchResult?.horizons, []);
        assert.equal(normalizePersistedTopMeanResult(null, manifest()), null);
        assert.equal(normalizePersistedTopMeanResult({ horizons: [{}] }, manifest()), null);
        assert.equal(normalizePersistedTopMeanResult({ horizons: [], eventDetails: {} }, manifest()), null);
        assert.equal(normalizePersistedTopMeanResult({ horizons: [], annualReports: {} }, manifest()), null);
    });
});
