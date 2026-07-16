/**
 * Parallel Stability Mine orchestrator (Phase 3 acceleration).
 *
 * Spawns N worker_threads partitioning the rerun range, then merges the partial
 * accumulators deterministically (ascending rerun-order) so parallel output is
 * byte-identical to the sequential TypeScript path for a fixed seed.
 *
 * Why this is a leaf-ish module: it imports `worker_threads` (Node-only) and
 * the worker file. It is only imported by `batch-backtest-vite-plugin.ts` (the
 * server-side path). It never enters the browser bundle.
 *
 * Fallback contract (plan §"Failure Handling"): on any worker error OR if the
 * worker threads cannot start, the orchestrator returns `{ ok: false }` and the
 * caller (the server plugin) runs the sequential TypeScript path. The plan's
 * "Worker crash" rule is "retry sequential TypeScript once" — implemented by
 * the caller, not here, so the caller owns the single-retry decision.
 */

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sampleItems, type BatchStabilityAccumulator } from "./batch-stability-mine";
import type { BatchSyntheticMinerProfile } from "./batch-synthetic-state-miner";
import type { BatchSyntheticTargetArtifact } from "./batch-synthetic-state-miner";
import type { StabilityWorkerData, StabilityWorkerResult } from "./batch-stability-worker";

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Default worker count: physical-ish cores minus one, clamped to [2, 8].
 *
 * Why the caps:
 *   - lower bound 2: with 1 worker there is no parallelism; the caller should
 *     use the sequential path instead.
 *   - upper bound 8: the miner is CPU-bound but per-rerun work also depends on
 *     artifact load (I/O). Beyond ~8 workers the OS file cache contention and
 *     merge overhead dominate on the workloads this targets (200-1000 pairs).
 *
 * `availableParallelism()` reports logical cores; on a 16-thread / 8-core
 * machine this returns 16, so the minus-one + cap keeps us at 8 (physical).
 */
export function resolveStabilityWorkerCount(explicit?: number): number {
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.floor(explicit));
    }
    let cores = 4;
    try {
        cores = availableParallelism() || cores;
    } catch {
        // availableParallelism is available from Node 18.7+; fall back if old.
    }
    return Math.max(2, Math.min(8, cores - 1));
}

// ---------------------------------------------------------------------------
// Deterministic merge
// ---------------------------------------------------------------------------

/**
 * Merge partial accumulators in array order (the caller MUST pass them in
 * ascending rerun-range order). Determinism:
 *
 *   - `retPct`, `liftPct`, `rr`, `dist`, `hmaxLiftPct`: arrays are concatenated
 *     in worker order. `medianOrNull` sorts before reducing, so the final
 *     median is independent of input order — but we still concatenate in
 *     rerun-order to keep the intermediate arrays reproducible.
 *   - `agreeingSets`: concatenated in rerun-order. Jaccard diversity is a
 *     pairwise average over all set pairs, which is order-independent — but
 *     again, rerun-order concatenation keeps the array reproducible.
 *   - `hits`, `high`/`medium`/`low`, `pairWarnings`, `hitEvents`: summed.
 *
 * The merge reproduces what a single sequential loop over `[0, totalReruns)`
 * would have produced because each rerun's contribution is appended in the
 * same order the sequential loop would have visited it.
 */
export function mergeStabilityAccumulators(
    partials: readonly StabilityWorkerResult[],
    totalReruns: number,
    subsetSize: number,
    seed: number,
    totalPairs: number,
    targetAssets: number,
): { accumulator: BatchStabilityAccumulator; profile: BatchSyntheticMinerProfile } {
    const merged = mergeAccumulatorRows(partials, totalReruns, subsetSize, seed, totalPairs, targetAssets);
    const profile = mergeProfiles(partials);
    return { accumulator: merged, profile };
}

function mergeAccumulatorRows(
    partials: readonly StabilityWorkerResult[],
    totalReruns: number,
    subsetSize: number,
    seed: number,
    totalPairs: number,
    targetAssets: number,
): BatchStabilityAccumulator {
    const rows = new Map<string, ReturnType<typeof createRowShell>>();
    let hitEvents = 0;
    for (const partial of partials) {
        for (const [key, row] of partial.accumulator.rows) {
            hitEvents += row.hits;
            let target = rows.get(key);
            if (!target) {
                target = createRowShell(row.asset, row.direction);
                rows.set(key, target);
            }
            target.hits += row.hits;
            target.high += row.high;
            target.medium += row.medium;
            target.low += row.low;
            target.retPct.push(...row.retPct);
            target.liftPct.push(...row.liftPct);
            target.rr.push(...row.rr);
            target.dist.push(...row.dist);
            target.hmaxLiftPct.push(...row.hmaxLiftPct);
            target.agreeingSets.push(...row.agreeingSets);
            target.pairWarnings += row.pairWarnings;
            target.asOfTimeKey = row.asOfTimeKey || target.asOfTimeKey;
            target.close = finiteOrExisting(row.close, target.close);
            target.barsHeld.push(...row.barsHeld);
            target.agreementTransitions.push(...row.agreementTransitions);
            target.freshHits += row.freshHits;
        }
    }
    return {
        reruns: totalReruns,
        subsetSize,
        seed,
        totalPairs,
        targetAssets,
        hitEvents,
        rows: rows as Map<string, import("./batch-stability-mine").BatchStabilityRowAccumulator>,
    };
}

interface MergedRowShell {
    asset: string;
    direction: "LONG" | "SHORT";
    hits: number;
    high: number;
    medium: number;
    low: number;
    retPct: number[];
    liftPct: number[];
    rr: number[];
    dist: number[];
    hmaxLiftPct: number[];
    pairWarnings: number;
    asOfTimeKey: string | null;
    close: number | null;
    barsHeld: number[];
    agreementTransitions: number[];
    freshHits: number;
    agreeingSets: string[][];
}

function createRowShell(asset: string, direction: "LONG" | "SHORT"): MergedRowShell {
    return {
        asset, direction,
        hits: 0, high: 0, medium: 0, low: 0,
        retPct: [], liftPct: [], rr: [], dist: [], hmaxLiftPct: [],
        pairWarnings: 0,
        asOfTimeKey: null, close: null, barsHeld: [], agreementTransitions: [], freshHits: 0,
        agreeingSets: [],
    };
}

function finiteOrExisting(value: number | null | undefined, existing: number | null): number | null {
    return value !== null && value !== undefined && Number.isFinite(value) ? value : existing;
}

/**
 * Sum the scalar profile fields across workers. The timing fields (prepare*Ms,
 * *Ms) are summed so the parent sees the total worker-thread CPU, and the
 * counter fields (targetsEvaluated, candidateSamples, etc.) are summed so the
 * profile reflects the whole run. `artifactConversionMs` is summed because
 * each worker independently loads/deserializes its sampled artifacts from disk
 * and, for compact files, converts them back to the raw TypeScript shape.
 */
function mergeProfiles(partials: readonly StabilityWorkerResult[]): BatchSyntheticMinerProfile {
    const out: BatchSyntheticMinerProfile = partials[0]?.profile
        ? { ...partials[0]!.profile }
        : emptyProfile();
    for (let i = 1; i < partials.length; i += 1) {
        const p = partials[i]!.profile;
        for (const key of Object.keys(out) as (keyof BatchSyntheticMinerProfile)[]) {
            const current = out[key];
            const incoming = p[key];
            if (typeof current === "number" && typeof incoming === "number") {
                (out[key] as number) = current + incoming;
            }
        }
    }
    return out;
}

function emptyProfile(): BatchSyntheticMinerProfile {
    // Avoid an import cycle by constructing a zero-filled profile inline. The
    // shape MUST stay in sync with createBatchSyntheticMinerProfile (locked by
    // typecheck).
    return {
        prepareTargetsMs: 0, preparePairsMs: 0, subsetTargetFilterMs: 0, runPreparedMs: 0,
        buildVerdictsMs: 0, sortVerdictsMs: 0, linkedPairFilterMs: 0, horizonMs: 0,
        currentSnapshotMs: 0, candidateSamplesMs: 0, windowingMs: 0, distanceScaleMs: 0,
        analogSelectionMs: 0, summarizeMs: 0, pairContributionsMs: 0, classifyMs: 0,
        targetsEvaluated: 0, artifactsEvaluated: 0, linkedPairsEvaluated: 0,
        candidateSamples: 0, preOosSamples: 0, oosSamples: 0,
        earlyNoLinkedPairs: 0, earlyShortTargetHistory: 0, earlyNoCurrentState: 0,
        earlyNotEnoughCandidates: 0, analogCandidatesScored: 0, topKSelected: 0,
        assetIndexHits: 0, assetIndexMisses: 0, artifactConversionMs: 0,
        parallelWorkerCount: 0,
    } as BatchSyntheticMinerProfile;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type ParallelStabilityOutcome =
    | { ok: true; result: StabilityWorkerResult[]; workerCount: number }
    | { ok: false; reason: "spawn_failed" | "worker_error" | "no_artifacts"; message: string };

/**
 * Resolve the worker file path, bundling the TypeScript worker to a real `.js`
 * file on first use so Node `worker_threads` can load it.
 *
 * Why this is needed: `worker_threads` cannot evaluate `.ts` files. The dev
 * server (`vite dev`) runs the plugin in plain Node with no TS-aware loader
 * propagated to workers, so spawning the `.ts` worker directly throws
 * "Unknown file extension .ts". Tests run under `esno` which CAN load `.ts`,
 * but production cannot, so the parallel path must produce a `.js` itself.
 *
 * Approach: esbuild (already a transitive dep via Vite) bundles
 * `batch-stability-worker.ts` + its dependency closure into a single
 * self-contained `.cjs` file under a deterministic cache directory
 * `strategies-finder-workers/<content-hash>/worker.cjs` in the OS temp dir.
 *
 * Cache invalidation (audit Finding 8): the hash is computed from esbuild's
 * `metafile` dependency graph — every input file path plus its mtime — so an
 * edit to ANY file in the worker's transitive closure (not just the entry)
 * invalidates the bundle. The previous key used only the entry mtime, which
 * left the worker running stale code when a dependency (e.g.
 * `batch-stability-mine.ts`) changed within a dev session while the sequential
 * fallback used current code — a silent parity divergence in a
 * correctness-sensitive deterministic path. The hash-derived directory name
 * also stops the unbounded temp-dir accumulation the prior `mkdtemp` caused
 * (one new dir per source edit); old hash dirs are swept opportunistically by
 * mtime on each resolve.
 *
 * The bundle is platform-portable CJS with no external runtime deps (esbuild
 * inlines `node:*` builtins as empty externals).
 *
 * On any esbuild error (e.g. esbuild not resolvable), returns the raw `.ts`
 * path so the caller falls back to sequential TS with the spawn failure
 * captured as the fallback reason — never throws.
 */
const WORKER_BUNDLE_CACHE = new Map<string, string>();

/**
 * How long an unreferenced worker-bundle generation must sit in the temp dir
 * before {@link sweepStaleWorkerBundles} reclaims it. Conservative (1h): the
 * generation is content-addressed so a re-resolve with the same dependency
 * graph reuses it; the sweep only clears generations left behind by source
 * edits across sessions.
 */
const WORKER_BUNDLE_STALE_MS = 60 * 60 * 1000;

/**
 * Hash namespace so a future change to the hashing scheme (e.g. including
 * bytes, not just mtimes) invalidates every prior generation deliberately
 * rather than silently reusing a now-misnamed dir.
 */
const MODULE_BUNDLE_HASH_VERSION = "v1";

async function resolveWorkerPath(): Promise<string> {
    const sourcePath = locateWorkerSource();
    // Already-bundled (e.g. published dist) — use as-is.
    const sibling = sourcePath.replace(/\.ts$/, ".js");
    try {
        if (sourcePath.endsWith(".js") || (await import("node:fs/promises").then((fs) => fs.access(sibling).then(() => true).catch(() => false)))) {
            return sourcePath.endsWith(".js") ? sourcePath : sibling;
        }
    } catch {
        /* fall through to bundle */
    }
    try {
        const bundled = await bundleWorkerWithEsbuild(sourcePath);
        // In-process memo key is the final outfile path; stable across calls
        // for the same dependency graph because the dir is content-hash-named.
        WORKER_BUNDLE_CACHE.set(bundled, bundled);
        return bundled;
    } catch {
        // esbuild unavailable or bundling failed — return the .ts path; the
        // spawn will fail and the caller falls back to sequential TS.
        return sourcePath;
    }
}

function locateWorkerSource(): string {
    const here = moduleThisFileDir();
    return join(here, "batch-stability-worker.ts");
}

function moduleThisFileDir(): string {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return dirname(__filename);
    }
}

/**
 * Parent directory for all stability-worker bundle generations. Named (not
 * `mkdtemp`) so generations are content-addressed and old ones can be swept
 * by mtime without parsing random suffixes.
 */
function workerBundleRoot(tmpdir: string): string {
    return join(tmpdir, "strategies-finder-workers");
}

/**
 * Best-effort sweep of stale bundle generations older than
 * {@link WORKER_BUNDLE_STALE_MS}. Never throws — sweep failures only mean
 * stale dirs linger (the OS temp cleanup or a future sweep will reclaim them).
 * Skips the directory matching {@link keepHash} (the just-written generation).
 */
async function sweepStaleWorkerBundles(tmpdir: string, keepHash: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const root = workerBundleRoot(tmpdir);
    let entries: string[];
    try {
        entries = await fs.readdir(root);
    } catch {
        return; // root doesn't exist yet — nothing to sweep.
    }
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
        if (entry === keepHash) return;
        const dir = join(root, entry);
        try {
            const stat = await fs.stat(dir);
            if (now - stat.mtimeMs > WORKER_BUNDLE_STALE_MS) {
                await fs.rm(dir, { recursive: true, force: true });
            }
        } catch {
            /* best-effort */
        }
    }));
}

async function bundleWorkerWithEsbuild(sourcePath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const crypto = await import("node:crypto");
    // Resolve esbuild from the repo's node_modules (Vite ships it transitively).
    // `import("esbuild")` resolves the ESM entry; the default export exposes
    // `build`. This works under both vite dev (Node) and esno (tests).
    const esbuild = (await import("esbuild")) as unknown as {
        build: (opts: {
            entryPoints: string[];
            bundle: boolean;
            platform: string;
            format: string;
            target: string;
            outfile: string;
            write: boolean;
            logLevel: string;
            metafile: boolean;
        }) => Promise<{
            metafile?: { inputs?: Record<string, unknown> };
        }>;
    };
    const tmp = os.tmpdir();
    const root = workerBundleRoot(tmp);

    // First pass: build with metafile to capture the full dependency graph,
    // then derive the cache hash from every input path + mtime. Building into
    // a throwaway path keeps the content-addressed dir clean if hashing fails.
    const probeDir = await fs.mkdtemp(join(tmp, "stability-worker-probe-"));
    const probeOut = join(probeDir, "worker.cjs");
    let result: { metafile?: { inputs?: Record<string, unknown> } };
    try {
        result = await esbuild.build({
            entryPoints: [sourcePath],
            bundle: true,
            platform: "node",
            format: "cjs",
            target: "node18",
            outfile: probeOut,
            write: true,
            logLevel: "silent",
            metafile: true,
        });
    } finally {
        // Probe dir is disposable; content-addressed dir is created below.
        await fs.rm(probeDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }

    const hash = await computeDependencyHash(sourcePath, result.metafile, fs, crypto);
    const dir = join(root, hash);
    const outfile = join(dir, "worker.cjs");

    // If a prior process/session already wrote this generation, reuse it.
    // Otherwise rebuild into the content-addressed dir. Either way the output
    // path is stable for a given dependency graph.
    const exists = await fs.access(outfile).then(() => true).catch(() => false);
    if (!exists) {
        await fs.mkdir(dir, { recursive: true });
        await esbuild.build({
            entryPoints: [sourcePath],
            bundle: true,
            platform: "node",
            format: "cjs",
            target: "node18",
            outfile,
            write: true,
            logLevel: "silent",
            metafile: false,
        });
    }

    // Opportunistic cleanup; never block resolution on sweep failures.
    void sweepStaleWorkerBundles(tmp, hash);
    return outfile;
}

/**
 * Content hash of the worker's full dependency graph. Captures every input
 * file path plus its mtime as reported by esbuild's metafile, plus the entry
 * path/mtime as a baseline (the metafile already includes the entry, but
 * including it explicitly defends against a future esbuild version that
 * trims self-references). A change to ANY transitive dependency invalidates
 * the hash, forcing a rebundle — the bug fixed in audit Finding 8.
 */
async function computeDependencyHash(
    entryPath: string,
    metafile: { inputs?: Record<string, unknown> } | undefined,
    fs: typeof import("node:fs/promises"),
    crypto: typeof import("node:crypto"),
): Promise<string> {
    const inputs = metafile?.inputs ?? {};
    // Always include the entry explicitly so an empty metafile still keys on
    // the entry, and so the entry's own mtime participates even if a future
    // esbuild version omits self-references.
    const pathList = Array.from(new Set([entryPath, ...Object.keys(inputs)])).sort();
    let mtimes: string[];
    try {
        const stamped = await Promise.all(pathList.map(async (p) => {
            try {
                const stat = await fs.stat(p);
                return `${p}@${stat.mtimeMs}`;
            } catch {
                return `${p}@missing`;
            }
        }));
        mtimes = stamped.sort();
    } catch {
        mtimes = pathList;
    }
    const h = crypto.createHash("sha256");
    h.update(MODULE_BUNDLE_HASH_VERSION);
    for (const stamp of mtimes) {
        h.update("\u0000");
        h.update(stamp);
    }
    return h.digest("hex").slice(0, 24);
}

/**
 * Spawn workers partitioning `[0, reruns)` into `workerCount` contiguous ranges,
 * collect their partial results, and return them in ascending rerun-order.
 *
 * The parent precomputes the exact sampled pair indexes for every rerun and
 * passes those indexes to each worker. This preserves `sampleItems(...)`
 * semantics while letting the worker load only the union of files it actually
 * needs for its rerun range instead of reloading every artifact file in every
 * worker.
 *
 * The caller is responsible for:
 *   - merging the partials via `mergeStabilityAccumulators(...)`
 *   - finalizing via `finalizeStabilityAggregate(...)`
 *   - falling back to sequential TS on `ok: false`
 *   - interpreting cancellation as a server-side Stop
 */
export async function runParallelStability(args: {
    artifactFiles: string[];
    targets: BatchSyntheticTargetArtifact[];
    interval: string;
    subsetSize: number;
    reruns: number;
    seed: number;
    workerCount?: number;
    /** Optional abort signal; when aborted, workers are terminated and the run fails fast. */
    isCancelled?: () => boolean;
    /** Optional progress callback fired after each worker completes. */
    onProgress?: (completedReruns: number, totalReruns: number) => void;
}): Promise<ParallelStabilityOutcome> {
    if (args.artifactFiles.length === 0) {
        return { ok: false, reason: "no_artifacts", message: "no artifact files to mine" };
    }
    const workerCount = Math.max(1, Math.min(args.workerCount ?? resolveStabilityWorkerCount(), args.reruns));
    if (workerCount === 1 || args.reruns <= 1) {
        // No parallelism to extract; signal the caller to use sequential.
        return { ok: false, reason: "spawn_failed", message: "rerun count too small for parallelism; use sequential path" };
    }
    if (args.isCancelled?.()) {
        return { ok: false, reason: "worker_error", message: "cancelled" };
    }
    // Partition [0, reruns) into workerCount contiguous ranges.
    const ranges = partitionRerunRange(args.reruns, workerCount);
    // Resolve (and first-use-bundle) the worker .js. Failures here fall back
    // to sequential TS — better than a guaranteed spawn crash on the .ts path.
    let workerPath: string;
    try {
        workerPath = await resolveWorkerPath();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: "spawn_failed", message: `worker resolve failed: ${message}` };
    }
    let completedReruns = 0;
    let cancelled = false;
    let cancelTimer: ReturnType<typeof setInterval> | null = null;
    const activeWorkers: ActiveStabilityWorker[] = [];
    const cancelActiveWorkers = (): void => {
        if (cancelled) return;
        cancelled = true;
        for (const worker of activeWorkers) {
            worker.terminate();
        }
    };

    try {
        // Spawn all workers up front. Each is independent (no shared state).
        // Collect their promises; one for each range.
        const allPairIndexes = Array.from({ length: args.artifactFiles.length }, (_, index) => index);
        const promises = ranges.map((range, order) => {
            const selectedIndexesByRerun: number[][] = [];
            for (let runIndex = range.start; runIndex < range.end; runIndex += 1) {
                selectedIndexesByRerun.push(sampleItems(allPairIndexes, args.subsetSize, args.seed + runIndex));
            }
            const worker = spawnOneWorker(workerPath, {
                artifactFiles: args.artifactFiles,
                selectedIndexesByRerun,
                targets: args.targets,
                interval: args.interval,
                subsetSize: args.subsetSize,
                startRerun: range.start,
                endRerun: range.end,
                seed: args.seed,
                totalPairs: args.artifactFiles.length,
            });
            activeWorkers.push(worker);
            return worker.promise.then((result) => {
                if (cancelled || args.isCancelled?.()) {
                    cancelActiveWorkers();
                    throw new Error("cancelled");
                }
                completedReruns += result.rerunsExecuted;
                args.onProgress?.(completedReruns, args.reruns);
                return { order, result };
            });
        });

        if (args.isCancelled) {
            cancelTimer = setInterval(() => {
                if (args.isCancelled?.()) cancelActiveWorkers();
            }, 250);
        }
        const settled = await Promise.all(promises);
        if (cancelTimer) {
            clearInterval(cancelTimer);
            cancelTimer = null;
        }
        if (cancelled || args.isCancelled?.()) {
            cancelActiveWorkers();
            return { ok: false, reason: "worker_error", message: "cancelled" };
        }
        settled.sort((a, b) => a.order - b.order);
        return { ok: true, result: settled.map((entry) => entry.result), workerCount };
    } catch (error) {
        if (cancelTimer) {
            clearInterval(cancelTimer);
            cancelTimer = null;
        }
        if (cancelled || args.isCancelled?.()) {
            cancelActiveWorkers();
            return { ok: false, reason: "worker_error", message: "cancelled" };
        }
        cancelActiveWorkers();
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: "worker_error", message };
    }
}

interface ActiveStabilityWorker {
    promise: Promise<StabilityWorkerResult>;
    terminate: () => void;
}

function spawnOneWorker(workerPath: string, data: StabilityWorkerData): ActiveStabilityWorker {
    let worker: Worker | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const promise = new Promise<StabilityWorkerResult>((resolve, reject) => {
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            fn();
        };
        try {
            worker = new Worker(workerPath, { workerData: data });
        } catch (error) {
            finish(() => reject(error));
            return;
        }
        timeout = setTimeout(() => {
            void worker?.terminate();
            finish(() => reject(new Error(`worker ${data.startRerun}-${data.endRerun} timed out`)));
        }, 5 * 60 * 1000);
        worker.on("message", (message: unknown) => {
            if (message && typeof message === "object" && "error" in (message as Record<string, unknown>)) {
                finish(() => {
                    void worker?.terminate().catch(() => {});
                    reject(new Error((message as { error: string }).error));
                });
                return;
            }
            finish(() => {
                resolve(message as StabilityWorkerResult);
                void worker?.terminate().catch(() => {});
            });
        });
        worker.on("error", (error) => {
            finish(() => reject(error));
        });
        worker.on("exit", (code) => {
            if (code !== 0) {
                finish(() => reject(new Error(`worker exited with code ${code}`)));
            }
        });
    });

    return {
        promise,
        terminate: () => {
            if (!settled && worker) {
                void worker.terminate().catch(() => {});
            }
        },
    };
}

/**
 * Partition `[0, total)` into `count` contiguous, mostly-equal ranges. Earlier
 * ranges get the remainder when `total` is not divisible by `count` so the
 * boundary is deterministic.
 */
export function partitionRerunRange(total: number, count: number): Array<{ start: number; end: number }> {
    const n = Math.max(1, Math.min(count, total));
    const base = Math.floor(total / n);
    const remainder = total % n;
    const ranges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
        const size = base + (i < remainder ? 1 : 0);
        ranges.push({ start: cursor, end: cursor + size });
        cursor += size;
    }
    return ranges;
}

/**
 * Test-only seam for the dependency-graph hash (audit Finding 8). Exposes the
 * pure hashing helper so a unit test can assert that an mtime change on a
 * transitive dependency input invalidates the hash — the regression that
 * silently served stale worker code when only the entry mtime keyed the cache.
 */
export const __testInternals = {
    computeDependencyHash,
    workerBundleRoot,
    WORKER_BUNDLE_STALE_MS,
};
