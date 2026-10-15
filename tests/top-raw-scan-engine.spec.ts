import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopRawScanEngine } from "../lib/batch-backtest/top-raw-scan-engine";
import { ScanWorkerPool, ScanPoolStoppedError } from "../lib/batch-backtest/top-raw-scan-pool";
import { ScanStore, scanHash } from "../lib/batch-backtest/top-raw-scan-store";
import { scanSourceIntervals } from "../lib/batch-backtest/top-raw-scan-preflight";
import { summarizeScanFailures, SCAN_FAILURE_LIMITS } from "../lib/batch-backtest/top-raw-scan-diagnostics";
import { withTimeout } from "./helpers/with-timeout";
import { createScanPopulation } from "../lib/batch-backtest/top-raw-scan-sampling";
import { readScanStatus, validateScanRequest } from "../lib/batch-backtest/top-raw-scan-vite-routes";
import type { ScanPair, ScanRequest, ScanVote } from "../lib/batch-backtest/top-raw-scan-contract";
import type { ScanWorkerTask } from "../lib/batch-backtest/top-raw-scan-worker";
import { makeBacktestSettings, makeCapitalSettings } from "./helpers/backtest-settings-fixtures";

const universe = Array.from({ length: 10 }, (_, i) => `ASSET${i}•`);
const request = (runId: string, options: Partial<ScanRequest> = {}): ScanRequest => ({ runId, strategyKey: "dema_confirmation", strategyParams: { lookback: 20 }, backtestSettings: makeBacktestSettings(), capitalSettings: makeCapitalSettings(), interval: "4h", assetListText: universe.join("\n"), opponentsPerAsset: 2, finalistCount: 3, seed: 7, workerCount: 2, useRustEnginePreference: false, ...options });
class FixturePool extends ScanWorkerPool {
    calls = 0; released = false; failKey = "";
    failReason = "Missing endpoint.";
    flat = false;
    disjoint = false;
    individual = false;
    profitNow?: (pair: ScanPair) => number;
    profitNowConf?: (pair: ScanPair) => number;
    omitProfitNow = false;
    onTask?: (task: ScanWorkerTask) => void | Promise<void>;
    constructor(private readonly root: string) { super(); }
    override get size() { return 2; }
    override async initialize() { this.workerPath = join(this.root, "implementation.txt"); }
    override async task<T>(_slot: number, task: ScanWorkerTask): Promise<T> {
        await this.onTask?.(task);
        if (task.type === "engine_identity") return "typescript_only" as T;
        if (task.type === "preflight") {
            const offset = this.individual ? 1_000_000 * universe.indexOf(task.asset) : this.disjoint && task.asset === universe[9] ? 1000 : 0;
            return Array.from({ length: 300 }, (_, i) => 1700006400 + offset + i * 14400) as T;
        }
        this.calls += task.pairs.length;
        return task.pairs.map(pair => ({ key: pair.key, vote: this.flat ? 0 : pair.base.includes("3") ? 2 : pair.quote.includes("3") ? -2 : pair.base.includes("1") ? -1 : 0, active: this.flat ? 0 : 2, engine: "typescript", ...(this.omitProfitNow ? {} : { profitNow: this.profitNow ? this.profitNow(pair) : 0, profitNowConf: this.profitNowConf ? this.profitNowConf(pair) : 0 }), ...(pair.key === this.failKey ? { error: this.failReason } : {}) })) as T;
    }
    override stop() { this.released = true; }
    override async dispose() { this.stop(); }
}
async function fixture(run: (root: string, store: ScanStore) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "top-raw-scan-spec-"));
    try {
        const dir = join(root, "price-data", "ibkr"); await mkdir(join(dir, "csv", "30m"), { recursive: true });
        await writeFile(join(root, "implementation.txt"), "frozen-worker-version");
        await writeFile(join(dir, "catalog.json"), JSON.stringify({ entries: universe.map(asset => ({ symbol: asset.slice(0, -1) })) }));
        for (const asset of universe) await writeFile(join(dir, "csv", "30m", `${asset.slice(0, -1)}.csv`), "fixture");
        await run(root, new ScanStore(root));
    } finally { await rm(root, { recursive: true, force: true }); }
}
describe("TOP_RAW orchestration and recovery", () => {
    it("restores accepted daily/4h source layouts at universe boundaries and reopens after restart", async () => fixture(async (root, store) => {
        const initial = request("layout_seed");
        await new TopRawScanEngine(initial, store, new FixturePool(root), root).run();
        const template = (await store.readManifest(initial.runId))!;
        assert.equal(scanSourceIntervals("AAPL•", "1d").length, 3);
        for (const [n, interval] of [[3334, "1d"], [5000, "1d"], [5000, "4h"]] as const) {
            const manifest = structuredClone(template), runId = `layout_${n}_${interval}`;
            const assets = Array.from({ length: n }, (_, i) => `ASSET${i}•`);
            const req = request(runId, { assetListText: assets.join("\n"), interval });
            const { assetListText: _text, ...semantic } = req;
            manifest.request = req; manifest.requestHash = scanHash({ ...semantic, assets: [...assets].sort() });
            manifest.assets = assets;
            manifest.sources = [template.sources[0]!, ...assets.flatMap(asset => scanSourceIntervals(asset, interval).map(source => ({ asset, path: join(root, "absent", source, `${asset}.csv`), revision: "missing" })))];
            manifest.result.runId = runId; manifest.result.eligibleAssets = assets; manifest.status.runId = runId;
            await store.saveManifest(manifest);
            assert.equal((await store.readManifest(runId))!.sources.length, 1 + n * (interval === "1d" ? 3 : 2));
            assert.equal((await readScanStatus(runId, store))!.phase, "completed");
            const pool = new FixturePool(root);
            const resumed = await new TopRawScanEngine({ ...req, resume: true }, store, pool, root).run();
            assert.equal(resumed.phase, "completed", resumed.message); assert.equal(pool.calls, 0);
            manifest.result.status = "interrupted"; manifest.status.phase = "interrupted"; manifest.completedShards = [];
            await store.saveManifest(manifest);
            const interruptedPool = new FixturePool(root);
            const engine = new TopRawScanEngine({ ...req, resume: true }, store, interruptedPool, root);
            const admitted = await engine.run(status => { if (status.phase === "discovery") engine.stop(); });
            assert.equal(admitted.phase, "interrupted", admitted.message); assert.equal(interruptedPool.calls, 0);
            assert.equal(admitted.result!.eligibleAssets.length, n);
            const invalid = structuredClone(manifest);
            invalid.sources.push(...Array.from({ length: n * 3 + 1 }, () => manifest.sources[1]!));
            await store.saveManifest(invalid); await assert.rejects(store.readManifest(runId), /Invalid scan manifest/);
            invalid.sources = [...manifest.sources, manifest.sources[1]!];
            await store.saveManifest(invalid); await assert.rejects(store.readManifest(runId), /Invalid scan manifest/);
        }
    }));
    it("retries only failed discovery/refinement edges and retains bounded fresh/cached diagnostics", async () => fixture(async (root, store) => {
        for (const phase of ["discovery", "refinement"]) {
            const req = request(`retry_${phase}`), pool = new FixturePool(root);
            pool.failReason = phase === "discovery" ? "Transient backend error" : "Missing endpoint at frozen E";
            pool.onTask = task => { if (task.type === "pairs" && (phase === "discovery" || pool.calls >= 10)) pool.failKey = task.pairs[0]!.key; };
            const failed = await new TopRawScanEngine(req, store, pool, root).run();
            assert.equal(failed.phase, "failed"); assert.equal(failed.result!.pairCounts.failed, 1);
            assert.equal(failed.result!.failureDiagnostics!.groups[0]!.reason, pool.failReason);
            const snapshot = (await store.readManifest(req.runId))!;
            const failedKey = pool.failKey;
            const stillBad = new FixturePool(root); stillBad.failKey = failedKey; stillBad.failReason = pool.failReason;
            const repeated = await new TopRawScanEngine({ ...req, resume: true }, store, stillBad, root).run();
            assert.equal(stillBad.calls, 1); assert.equal(repeated.phase, "failed");
            assert.deepEqual(repeated.result!.failureDiagnostics, failed.result!.failureDiagnostics);
            assert.equal((await store.readResult(req.runId))!.failureDiagnostics!.total, 1);
            const healthy = new FixturePool(root), retries: string[] = [];
            healthy.onTask = task => { if (task.type === "pairs") retries.push(...task.pairs.map(pair => pair.key)); };
            const recovered = await new TopRawScanEngine({ ...req, resume: true }, store, healthy, root).run();
            assert.equal(recovered.phase, "completed", recovered.message);
            assert.equal(retries[0], failedKey);
            if (phase === "refinement") assert.equal(healthy.calls, 1);
            else assert.equal(healthy.calls, 1 + recovered.result!.pairCounts.refinement);
            assert.equal(recovered.result!.pairCounts.failed, 0); assert.equal(recovered.result!.failureDiagnostics!.total, 0);
            assert.equal(recovered.result!.asOf, snapshot.asOf); assert.equal(recovered.result!.fingerprint, snapshot.result.fingerprint);
            assert.deepEqual(recovered.result!.sourceRevisions, snapshot.result.sourceRevisions);
        }
        const bounded = summarizeScanFailures(Array.from({ length: 500 }, (_, i) => ({ key: `A${i}|B`, vote: 0, active: 0, engine: "typescript" as const, error: `${i % 20}: ${"failure".repeat(300)}` })));
        assert.equal(bounded.total, 500); assert.equal(bounded.groups.length, SCAN_FAILURE_LIMITS.groups);
        assert.equal(bounded.groups.reduce((n, group) => n + group.count, bounded.otherCount), 500);
        assert.ok(JSON.stringify(bounded).length < 10000);
    }));
    it("keeps shard recovery atomic when Stop interrupts a failed-edge retry write", async () => fixture(async (root, store) => {
        const req = request("retry_stop"), first = new FixturePool(root);
        first.onTask = task => { if (task.type === "pairs") first.failKey = task.pairs[0]!.key; };
        await new TopRawScanEngine(req, store, first, root).run();
        const before = (await store.readManifest(req.runId))!;
        const stopStore = new ScanStore(root), save = stopStore.saveShard.bind(stopStore);
        const engine = new TopRawScanEngine({ ...req, resume: true }, stopStore, new FixturePool(root), root);
        stopStore.saveShard = async (...args) => { await save(...args); engine.stop(); };
        const stopped = await engine.run(); assert.equal(stopped.phase, "interrupted");
        const shard = await store.readShard(req.runId, 0, before.result.fingerprint);
        assert.ok(shard!.every(vote => !vote.error));
        const healthy = new FixturePool(root);
        const resumed = await new TopRawScanEngine({ ...req, resume: true }, store, healthy, root).run();
        assert.equal(resumed.phase, "completed"); assert.equal(healthy.calls, resumed.result!.pairCounts.refinement);
        // Failed atomic publication leaves the previous failed record available for retry.
        const secondReq = request("retry_write_failure"), second = new FixturePool(root);
        second.onTask = task => { if (task.type === "pairs") second.failKey = task.pairs[0]!.key; };
        await new TopRawScanEngine(secondReq, store, second, root).run();
        const brokenStore = new ScanStore(root); brokenStore.saveShard = async () => { throw new Error("retry rename denied"); };
        const broken = await new TopRawScanEngine({ ...secondReq, resume: true }, brokenStore, new FixturePool(root), root).run();
        assert.equal(broken.phase, "failed"); assert.match(broken.message, /retry rename denied/);
        assert.equal(broken.result!.failureDiagnostics!.total, 1, "cached failed vote survives an unpublished retry");
        const finalPool = new FixturePool(root);
        const final = await new TopRawScanEngine({ ...secondReq, resume: true }, store, finalPool, root).run();
        assert.equal(final.phase, "completed"); assert.equal(finalPool.calls, 1 + final.result!.pairCounts.refinement);
    }));
    it("publishes terminal stream/poll status only after teardown, persistence and release", async () => fixture(async (root, store) => {
        for (const phase of ["completed", "failed", "interrupted", "reopen", "stop_teardown"] as const) for (const gate of ["dispose", "persist"] as const) {
            if (["reopen", "stop_teardown"].includes(phase) && gate === "persist") continue;
            const req = request(`boundary_${phase}_${gate}`);
            if (phase === "reopen") await new TopRawScanEngine(req, store, new FixturePool(root), root).run();
            let entered!: () => void, unblock!: () => void;
            const ready = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { unblock = resolve; });
            const pool = new FixturePool(root), gatedStore = new ScanStore(root);
            let once = false, released = false;
            const wait = async () => { if (!once) { once = true; entered(); await blocked; } };
            if (gate === "dispose") pool.dispose = async () => { await wait(); pool.stop(); };
            else {
                const save = gatedStore.saveManifest.bind(gatedStore);
                gatedStore.saveManifest = async manifest => {
                    if (["completed", "failed", "interrupted"].includes(manifest.status.phase)) await wait();
                    await save(manifest);
                };
            }
            const engine = new TopRawScanEngine({ ...req, ...(phase === "reopen" ? { resume: true } : {}) }, gatedStore, pool, root);
            if (phase === "failed") pool.onTask = task => { if (task.type === "pairs") pool.failKey = task.pairs[0]!.key; };
            const observed: string[] = [];
            const running = engine.run(status => {
                observed.push(status.phase);
                if (phase === "interrupted" && status.phase === "discovery" && status.completed) engine.stop();
                if (["completed", "failed", "interrupted"].includes(status.phase)) assert.ok(released, "release precedes terminal stream");
            }, () => { released = true; });
            try {
                await withTimeout(ready, 2000, `terminal ${phase}/${gate}`);
                assert.equal(released, false); assert.ok(!["completed", "failed", "interrupted"].includes(engine.getStatus().phase));
                assert.ok(observed.every(value => !["completed", "failed", "interrupted"].includes(value)));
                if (phase === "stop_teardown") engine.stop();
            } finally { unblock(); }
            const status = await running;
            assert.equal(status.phase, phase === "reopen" ? "completed" : phase === "stop_teardown" ? "interrupted" : phase); assert.equal(engine.getStatus().phase, status.phase);
        }
    }));
    it("refines against an independent exhaustive sum without double counting, and resumes without execution", async () => fixture(async (root, store) => {
        const pool = new FixturePool(root), req = request("refinement");
        const engine = new TopRawScanEngine(req, store, pool, root);
        const status = await engine.run(); assert.equal(status.phase, "completed");
        const result = status.result!; assert.equal(result.globalRankingExact, false); assert.ok(pool.released);
        const referencePool = new FixturePool(root), population = createScanPopulation(universe, req.seed);
        const full = [];
        for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) full.push(population.pair(universe[i]!, universe[j]!));
        const votes = await referencePool.task<ScanVote[]>(0, { type: "pairs", pairs: full, request: req, asOf: result.asOf, cutoff: result.cutoff, sources: [] });
        const expected = new Map(universe.map(asset => [asset, 0]));
        for (let i = 0; i < full.length; i++) { const pair = full[i]!, vote = votes[i]!; expected.set(pair.base, expected.get(pair.base)! + vote.vote); expected.set(pair.quote, expected.get(pair.quote)! - vote.vote); }
        for (const row of result.finalists) { assert.equal(row.exactRaw, expected.get(row.asset)); assert.equal(row.evaluatedOpponents, 9); }
        assert.equal(pool.calls, result.pairCounts.discovery + result.pairCounts.refinement);
        assert.ok(result.pairCounts.reused > 0);
        const resumePool = new FixturePool(root), resumed = await new TopRawScanEngine({ ...req, resume: true }, store, resumePool, root).run();
        assert.equal(resumed.phase, "completed"); assert.equal(resumePool.calls, 0);
        assert.deepEqual(resumed.result, result);
        const disk = JSON.parse(await readFile(store.path(req.runId, "result.json"), "utf8"));
        // Crash after atomic shard publication but before its phase checkpoint.
        const crashed = (await store.readManifest(req.runId))!;
        crashed.completedShards = []; crashed.status.phase = "refinement"; crashed.result.status = "refinement";
        await store.saveManifest(crashed);
        assert.equal((await readScanStatus(req.runId, store))!.phase, "interrupted");
        const recoveredPool = new FixturePool(root);
        const recovered = await new TopRawScanEngine({ ...req, resume: true }, store, recoveredPool, root).run();
        assert.equal(recovered.phase, "completed"); assert.equal(recoveredPool.calls, 0);
        assert.deepEqual(recovered.result!.finalists, result.finalists);
        assert.equal(disk.schema, "top_raw_scan.result.v1"); assert.ok(!JSON.stringify(disk).includes('"trades"'));
    }));
    it("marks exhaustive mode global exact and handles flat/no-positive results", async () => fixture(async (root, store) => {
        const pool = new FixturePool(root), status = await new TopRawScanEngine(request("all", { opponentsPerAsset: 64 }), store, pool, root).run();
        assert.equal(status.result!.globalRankingExact, true); assert.equal(status.result!.finalists.length, 10);
        assert.equal(status.result!.pairCounts.refinement, 0); assert.equal(pool.calls, 45);
        const flatPool = new FixturePool(root); flatPool.flat = true;
        const flat = await new TopRawScanEngine(request("flat"), store, flatPool, root).run();
        assert.equal(flat.phase, "completed"); assert.equal(flat.result!.reason, "no_positive_fully_evaluated_candidates"); assert.deepEqual(flat.result!.bestVerifiedCandidates, []);
    }));
    it("ranks leaders by the selected arm and enforces profit-now votes only for profit-now arms", async () => fixture(async (root, store) => {
        const raw = await new TopRawScanEngine(request("arm_raw", { opponentsPerAsset: 64 }), store, new FixturePool(root), root).run();
        assert.equal(raw.phase, "completed", raw.message); assert.equal(raw.result!.arm, "top_raw");
        const profitHook = (pair: ScanPair) => pair.base === universe[1] ? 50 : pair.quote === universe[1] ? -50 : 0;
        const profitPool = new FixturePool(root); profitPool.profitNow = profitHook;
        const profitReq = request("arm_profit", { arm: "top_raw_profit_now", opponentsPerAsset: 64 });
        const profit = await new TopRawScanEngine(profitReq, store, profitPool, root).run();
        assert.equal(profit.phase, "completed", profit.message);
        assert.equal(profit.result!.arm, "top_raw_profit_now");
        assert.deepEqual(profit.result!.bestVerifiedCandidates, [universe[1]]);
        const winner = profit.result!.finalists.find(row => row.asset === universe[1])!;
        assert.equal(winner.complete, true); assert.equal(winner.exactProfitNow, 50 * (universe.length - 1));
        // activeDegree counts pairs with a nonzero vote, so mirror the vote mock.
        const population = createScanPopulation(universe, profitReq.seed);
        const expectedActive = universe.filter(opponent => opponent !== universe[1]).filter(opponent => {
            const pair = population.pair(universe[1], opponent);
            return (pair.base.includes("3") ? 2 : pair.quote.includes("3") ? -2 : pair.base.includes("1") ? -1 : 0) !== 0;
        }).length;
        assert.equal(winner.exactActiveDegree, expectedActive);
        const confPool = new FixturePool(root); confPool.profitNow = profitHook; confPool.profitNowConf = pair => profitHook(pair) / 4;
        const conf = await new TopRawScanEngine(request("arm_conf", { arm: "top_raw_profit_now_conf", opponentsPerAsset: 64 }), store, confPool, root).run();
        assert.equal(conf.phase, "completed", conf.message);
        assert.equal(conf.result!.arm, "top_raw_profit_now_conf");
        assert.deepEqual(conf.result!.bestVerifiedCandidates, [universe[1]]);
        assert.equal(conf.result!.finalists.find(row => row.asset === universe[1])!.exactProfitNowConf, 12.5 * (universe.length - 1));
        const stale = new FixturePool(root); stale.omitProfitNow = true;
        const rejected = await new TopRawScanEngine(request("arm_profit_stale", { arm: "top_raw_profit_now", opponentsPerAsset: 64 }), store, stale, root).run();
        assert.equal(rejected.phase, "failed"); assert.match(rejected.message, /Invalid shard coverage/);
        const rejectedConf = new FixturePool(root); rejectedConf.omitProfitNow = true;
        const rejectedByConf = await new TopRawScanEngine(request("arm_conf_stale", { arm: "top_raw_profit_now_conf", opponentsPerAsset: 64 }), store, rejectedConf, root).run();
        assert.equal(rejectedByConf.phase, "failed"); assert.match(rejectedByConf.message, /Invalid shard coverage/);
        const tolerant = new FixturePool(root); tolerant.omitProfitNow = true;
        const accepted = await new TopRawScanEngine(request("arm_raw_stale", { opponentsPerAsset: 64 }), store, tolerant, root).run();
        assert.equal(accepted.phase, "completed", accepted.message);
        // A failing pair is a recorded error vote under every arm, never a
        // shard-rejection cause.
        const gap = new FixturePool(root);
        gap.failReason = "Pair does not contain frozen endpoint.";
        gap.onTask = task => { if (task.type === "pairs" && !gap.failKey) gap.failKey = task.pairs[0]!.key; };
        const gapped = await new TopRawScanEngine(request("arm_conf_gap", { arm: "top_raw_profit_now_conf", opponentsPerAsset: 64 }), store, gap, root).run();
        assert.equal(gapped.phase, "failed", gapped.message);
        assert.match(gapped.message, /incomplete_coverage/);
        assert.equal(gapped.result!.pairCounts.failed, 1);
        assert.equal(gapped.result!.failureDiagnostics!.total, 1);
        assert.match(gapped.result!.failureDiagnostics!.groups[0]!.reason, /frozen endpoint/);
    }));
    it("reports the root-cause failure instead of the pool's stop sentinel", async () => fixture(async (root, store) => {
        class MaskedPool extends FixturePool {
            override async task<T>(slot: number, task: ScanWorkerTask): Promise<T> {
                await this.onTask?.(task);
                if (task.type === "engine_identity") return "typescript_only" as T;
                if (task.type === "preflight") return Array.from({ length: 300 }, (_, i) => 1700006400 + i * 14400) as T;
                if (slot === 1) throw new Error("Source revision changed during execution.");
                throw new ScanPoolStoppedError();
            }
        }
        // More than one shard (45 pairs over two slots): the slot that hits the
        // real error must outrank the sibling stop-sentinel rejections.
        const status = await new TopRawScanEngine(request("masked_failure", { opponentsPerAsset: 64 }), store, new MaskedPool(root), root).run();
        assert.equal(status.phase, "failed"); assert.match(status.message, /Source revision changed/);
        assert.equal(status.result!.error, "Source revision changed during execution.");
        const restored = await readScanStatus("masked_failure", store);
        assert.equal(restored!.phase, "failed"); assert.match(restored!.message, /Source revision changed/);
    }));
    it("withholds completed rankings for failed discovery and refinement edges", async () => fixture(async (root, store) => {
        for (const phase of ["discovery", "refinement"]) {
            const pool = new FixturePool(root);
            pool.onTask = task => { if (task.type === "pairs" && (phase === "discovery" || pool.calls >= 10)) pool.failKey = task.pairs[0]!.key; };
            const status = await new TopRawScanEngine(request(phase), store, pool, root).run();
            assert.equal(status.phase, "failed"); assert.equal(status.result!.globalRankingExact, false); assert.deepEqual(status.result!.bestVerifiedCandidates, []);
            if (phase === "discovery") assert.equal(status.result!.finalists.length, 0);
            else assert.ok(status.result!.finalists.some(row => !row.complete && row.exactRaw === null));
        }
    }));
    it("Stop persists interruptions in preflight, discovery, refinement and final writes", async () => fixture(async (root, store) => {
        for (const phase of ["preflight", "discovery", "refinement", "persistence"]) {
            const req = request(`stop_${phase}`), pool = new FixturePool(root);
            let engine: TopRawScanEngine;
            const stopStore = new ScanStore(root);
            if (phase === "persistence") {
                const save = stopStore.saveResult.bind(stopStore);
                stopStore.saveResult = async result => { await save(result); if (result.status === "completed") engine.stop(); };
            }
            engine = new TopRawScanEngine(req, stopStore, pool, root);
            if (phase === "preflight") pool.onTask = task => { if (task.type === "preflight") engine.stop(); };
            const status = await engine.run(progress => { if (progress.phase === phase && progress.completed > 0) engine.stop(); });
            assert.equal(status.phase, "interrupted", phase); assert.ok(pool.released);
            const saved = await readScanStatus(req.runId, store); assert.equal(saved!.phase, "interrupted");
            const resumed = await new TopRawScanEngine({ ...req, resume: true }, store, new FixturePool(root), root).run();
            assert.equal(resumed.phase, "completed", `resume ${phase}: ${resumed.message}`);
        }
    }));
    it("fails source changes, changed requests, missing shards, and atomic persistence errors", async () => fixture(async (root, store) => {
        const req = request("mutation"), pool = new FixturePool(root);
        const initial = await new TopRawScanEngine(req, store, pool, root).run(); assert.equal(initial.phase, "completed");
        const mismatch = await new TopRawScanEngine({ ...req, resume: true, seed: 8 }, store, new FixturePool(root), root).run(); assert.match(mismatch.message, /mismatch/);
        await writeFile(join(root, "price-data", "ibkr", "csv", "30m", "ASSET0.csv"), "changed");
        const changed = await new TopRawScanEngine({ ...req, resume: true }, store, new FixturePool(root), root).run(); assert.equal(changed.phase, "failed"); assert.match(changed.message, /Source changed/);
        const failingStore = new ScanStore(root); failingStore.saveResult = async () => { throw new Error("atomic rename denied"); };
        const writeFailure = await new TopRawScanEngine(request("write_failure"), failingStore, new FixturePool(root), root).run(); assert.equal(writeFailure.phase, "failed"); assert.match(writeFailure.message, /atomic rename denied/); assert.equal(writeFailure.result!.globalRankingExact, false);
        const reqMissing = request("missing_shard");
        await new TopRawScanEngine(reqMissing, store, new FixturePool(root), root).run();
        const manifest = (await store.readManifest(reqMissing.runId))!;
        manifest.status.phase = "interrupted"; manifest.result.status = "interrupted"; await store.saveManifest(manifest);
        await rm(store.path(reqMissing.runId, `shard-${manifest.completedShards[0]}.json`));
        const missing = await new TopRawScanEngine({ ...reqMissing, resume: true }, store, new FixturePool(root), root).run();
        assert.equal(missing.phase, "failed"); assert.match(missing.message, /shard.*missing/);
    }));
    it("validates API limits and rejects stale replay settings", () => {
        assert.equal(validateScanRequest(request("valid")).seed, 7);
        assert.equal(validateScanRequest(request("valid")).arm, undefined);
        assert.equal(validateScanRequest({ ...request("armed"), arm: "top_raw_profit_now" }).arm, "top_raw_profit_now");
        assert.equal(validateScanRequest({ ...request("armed"), arm: "top_raw_profit_now_conf" }).arm, "top_raw_profit_now_conf");
        for (const patch of [{ horizons: [12] }, { replayMode: "horizon" }, { capTiltWeight: "off" }, { sampleFrom: "2025-01-01" }, { workerCount: 33 }, { resume: "true" }, { runId: "../oops" }, { strategyKey: "constructor" }, { strategyKey: "toString" }, { strategyKey: "__proto__" }, { arm: "bogus" }, { arm: 7 }]) assert.throws(() => validateScanRequest({ ...request("invalid"), ...patch }));
    });
    it("restores failed preflight and malformed reservations as terminal failures", async () => fixture(async (root, store) => {
        const req = request("preflight_failure", { assetListText: "MISSING•\nASSET0•" });
        const failed = await new TopRawScanEngine(req, store, new FixturePool(root), root).run();
        assert.equal(failed.phase, "failed");
        const restored = await readScanStatus(req.runId, store);
        assert.equal(restored!.phase, "failed"); assert.match(restored!.message, /Only 1 eligible/);
        assert.ok(restored!.preflight!.assetsToSync.some(row => row.asset === "MISSING•"));
        await writeFile(store.path(req.runId, "reservation.json"), "{invalid");
        const corrupt = await readScanStatus(req.runId, store);
        assert.equal(corrupt!.phase, "failed"); assert.match(corrupt!.message, /could not be restored/);
    }));
    it("excludes the stale history and completes on the newest candle the rest support", async () => fixture(async (root, store) => {
        const req = request("disjoint"), pool = new FixturePool(root); pool.disjoint = true;
        const status = await new TopRawScanEngine(req, store, pool, root).run();
        assert.equal(status.phase, "completed", status.message);
        assert.deepEqual(status.result!.eligibleAssets, universe.slice(0, 9));
        assert.deepEqual(status.result!.exclusions.map(row => row.asset), ["ASSET9•"]);
        assert.match(status.result!.exclusions[0]!.reason, /Missing a closed 4h candle with 200 bars of history/);
        assert.equal(Object.keys(status.result!.legEndpoints).length, 9);
        assert.ok(!(await store.readManifest(req.runId))!.sources.some(source => source.asset === "ASSET9•"));
        assert.equal(pool.calls, status.result!.pairCounts.discovery + status.result!.pairCounts.refinement);
        assert.equal(req.assetListText, universe.join("\n"), "the entered list stays unchanged");
        const reopened = await new TopRawScanEngine({ ...req, resume: true }, store, new FixturePool(root), root).run();
        assert.equal(reopened.phase, "completed"); assert.deepEqual(reopened.result, status.result);
    }));
    it("fails with a sync report only when fewer than two assets support the best candle", async () => fixture(async (root, store) => {
        const req = request("solo_support"), pool = new FixturePool(root); pool.individual = true;
        const failed = await new TopRawScanEngine(req, store, pool, root).run();
        assert.equal(failed.phase, "failed"); assert.equal(pool.calls, 0);
        assert.equal(failed.preflight!.usableAssetCount, 1); assert.equal(failed.preflight!.requestedAssetCount, 10);
        assert.equal(failed.preflight!.assetsToSync.length, 9);
        assert.ok(failed.preflight!.assetsToSync.every(row => /Missing a closed 4h candle with 200 bars of history/.test(row.reason!)));
        assert.match(failed.message, /Only 1 eligible assets have usable local data/);
        assert.match(failed.message, /All 10 requested assets were kept/);
        const restored = await readScanStatus(req.runId, store);
        assert.equal(restored!.phase, "failed"); assert.deepEqual(restored!.preflight, failed.preflight);
    }));
    it("invalidates a saved scan when a previously absent fallback CSV appears", async () => fixture(async (root, store) => {
        const req = request("fallback_created");
        const completed = await new TopRawScanEngine(req, store, new FixturePool(root), root).run();
        assert.equal(completed.phase, "completed");
        const manifest = (await store.readManifest(req.runId))!;
        assert.equal(manifest.sources.find(source => source.path.endsWith(join("4h", "ASSET0.csv")))!.revision, "missing");
        await mkdir(join(root, "price-data", "ibkr", "csv", "4h"), { recursive: true });
        await writeFile(join(root, "price-data", "ibkr", "csv", "4h", "ASSET0.csv"), "new fallback");
        const resumed = await new TopRawScanEngine({ ...req, resume: true }, store, new FixturePool(root), root).run();
        assert.equal(resumed.phase, "failed"); assert.match(resumed.message, /Source changed/);
        assert.equal(resumed.result!.globalRankingExact, false);
    }));
    it("honors Stop while selecting the supported candle or preparing a sync report", async () => fixture(async (root, store) => {
        const selecting = new FixturePool(root); selecting.disjoint = true;
        const engine = new TopRawScanEngine(request("stop_selection"), store, selecting, root);
        const stopped = await engine.run(status => { if (status.message.startsWith("Selecting the best-supported common candle")) engine.stop(); });
        assert.equal(stopped.phase, "interrupted", stopped.message); assert.equal(selecting.calls, 0); assert.ok(selecting.released);
        assert.equal((await readScanStatus("stop_selection", store))!.phase, "interrupted");
        const report = new FixturePool(root); report.individual = true;
        const reportEngine = new TopRawScanEngine(request("stop_diagnostics"), store, report, root);
        const stoppedReport = await reportEngine.run(status => { if (status.message.startsWith("Building sync report")) reportEngine.stop(); });
        assert.equal(stoppedReport.phase, "interrupted", stoppedReport.message); assert.equal(report.calls, 0); assert.ok(report.released);
        assert.equal((await readScanStatus("stop_diagnostics", store))!.phase, "interrupted");
    }));
    it("excludes an unavailable stock and scans the overlapping rest of the list", async () => fixture(async (root, store) => {
        const list = [...universe, "MISSING•"];
        const req = request("partial_universe", { assetListText: list.join("\n") }), pool = new FixturePool(root);
        const status = await new TopRawScanEngine(req, store, pool, root).run();
        assert.equal(status.phase, "completed", status.message);
        assert.equal(status.result!.eligibleAssets.length, 10);
        assert.deepEqual(status.result!.exclusions.map(row => row.asset), ["MISSING•"]);
        assert.match(status.result!.exclusions[0]!.reason, /Not in local catalog/);
        assert.equal(req.assetListText, list.join("\n"), "the entered list stays unchanged");
    }));
});
