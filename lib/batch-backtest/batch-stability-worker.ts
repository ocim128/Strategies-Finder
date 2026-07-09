/**
 * Stability Mine worker (Phase 3 parallel acceleration).
 *
 * One worker handles a contiguous range of reruns `[startRerun, endRerun)` and
 * returns a partial `BatchStabilityAccumulator`. The server plugin spawns N
 * workers partitioning the rerun range, then merges the partials in ascending
 * rerun-order for deterministic output.
 *
 * Why reruns (not pairs): the per-rerun cost is `sampleSubset + runMiner`,
 * which is independent across reruns (each samples a fresh subset with
 * `seed + runIndex`). Partitioning by rerun range gives clean parallelism with
 * zero cross-worker coupling. Partitioning by pairs would require every worker
 * to see every target and would couple the accumulator merge to pair-sets.
 *
 * Each worker reads the artifact FILES from disk independently (plan
 * §"Risks/Blockers": "prefer file references plus per-worker subset loading").
 * The OS file cache absorbs the repeated reads across workers on the same
 * temp directory.
 *
 * Browser-safety: this module is imported by `worker_threads`, NOT by the
 * browser bundle. It stays on the same leaf-only import diet as
 * `batch-synthetic-state-miner.ts` (the existing miner already runs server-
 * side under the vite plugin).
 */

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { deserialize } from "node:v8";
import {
    addStabilityVerdicts,
    createStabilityAggregate,
    sampleItems,
    type BatchStabilityAccumulator,
} from "./batch-stability-mine";
import {
    createBatchSyntheticMinerProfile,
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    type BatchSyntheticMinerProfile,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticPreparedPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";

/**
 * Input passed via `workerData`. The worker receives file paths (not artifact
 * bytes) so the structured-clone cost at worker startup stays bounded
 * regardless of pair count.
 */
export interface StabilityWorkerData {
    artifactFiles: string[];
    /**
     * Exact sampled pair indexes for each rerun in `[startRerun, endRerun)`,
     * in rerun order. Indexes refer to `artifactFiles`.
     *
     * When present, the worker loads only the union of these indexes and uses
     * these lists directly instead of re-running `sampleItems(...)` over the
     * full artifact array. This preserves deterministic sampling while avoiding
     * full-universe artifact load/prep in every worker.
     */
    selectedIndexesByRerun?: number[][];
    targets: BatchSyntheticTargetArtifact[];
    interval: string;
    subsetSize: number;
    startRerun: number;
    endRerun: number;
    seed: number;
    /** Total pair count (for the accumulator's `totalPairs` field). */
    totalPairs: number;
}

/**
 * Output returned to the parent. The accumulator is plain data (Map of plain
 * objects with arrays / strings), so it survives structured clone without
 * custom serialization. `profile` is this worker's share of the miner profile;
 * the parent sums the scalar fields across workers.
 */
export interface StabilityWorkerResult {
    accumulator: BatchStabilityAccumulator;
    profile: BatchSyntheticMinerProfile;
    rerunsExecuted: number;
}

/**
 * `performance.now()` when available, else `Date.now()`. Mirrors the miner's
 * private `nowMs` so worker timing fields are on the same clock as the parent
 * profile the plugin reports.
 */
function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

/**
 * Load artifact files from disk. Mirrors the server plugin's
 * `loadStoredMineArtifact` but reads directly from disk (the worker has no
 * access to the plugin's in-memory parse cache). The OS file cache absorbs the
 * repeated reads across workers on the same temp directory.
 */
function loadArtifactsFromDisk(
    files: readonly string[],
    indexes: readonly number[],
): Array<{ index: number; artifact: BatchSyntheticPairArtifact }> {
    const out: Array<{ index: number; artifact: BatchSyntheticPairArtifact }> = [];
    for (const index of indexes) {
        const file = files[index];
        if (!file) continue;
        const deserialized = deserialize(readFileSync(file)) as BatchSyntheticPairArtifact;
        out.push({ index, artifact: deserialized });
    }
    return out;
}

/**
 * Run a rerun range and accumulate. Exported for unit-testability (the test
 * imports this directly instead of spawning a worker thread).
 */
export function runStabilityRerunRange(data: StabilityWorkerData): StabilityWorkerResult {
    const profile = createBatchSyntheticMinerProfile();
    const selectedIndexesByRerun = normalizeSelectedIndexes(data);
    const requiredIndexes = Array.from(new Set(selectedIndexesByRerun.flat())).sort((a, b) => a - b);
    // Time prepare/load honestly. On the parallel path each worker pays these
    // costs independently; without timing them the merged profile would show
    // prepareTargetsMs/preparePairsMs/artifactConversionMs as 0 and hide real
    // per-worker cost inside runPreparedMs. `nowMs` mirrors the miner's helper.
    const loadStartedAt = nowMs();
    const loadedPairs = loadArtifactsFromDisk(data.artifactFiles, requiredIndexes);
    profile.artifactConversionMs += nowMs() - loadStartedAt;
    const preparePairsStartedAt = nowMs();
    const preparedPairsByIndex = new Map<number, BatchSyntheticPreparedPairArtifact>();
    for (const entry of loadedPairs) {
        const prepared = prepareBatchSyntheticPairArtifacts([entry.artifact]);
        if (prepared[0]) {
            preparedPairsByIndex.set(entry.index, prepared[0]);
        }
    }
    profile.preparePairsMs += nowMs() - preparePairsStartedAt;
    const prepareTargetsStartedAt = nowMs();
    const preparedTargets = prepareBatchSyntheticTargetArtifacts(data.targets);
    profile.prepareTargetsMs += nowMs() - prepareTargetsStartedAt;
    const accumulator = createStabilityAggregate(
        // reruns/subsetSize/seed on the accumulator describe the WHOLE run; the
        // parent overrides these at merge time. Per-worker they carry the
        // range shape so a standalone unit test still gets a sane object.
        data.endRerun - data.startRerun,
        data.subsetSize,
        data.seed,
        data.totalPairs,
        data.targets.length,
    );
    for (let runIndex = data.startRerun; runIndex < data.endRerun; runIndex += 1) {
        const selectedIndexes = selectedIndexesByRerun[runIndex - data.startRerun] ?? [];
        const subsetArtifacts = selectedIndexes
            .map((index) => preparedPairsByIndex.get(index))
            .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
        const subsetAssets = new Set(subsetArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset]));
        const subsetStart = performance.now();
        const subsetTargets = preparedTargets.filter((target) => subsetAssets.has(target.asset));
        profile.subsetTargetFilterMs += performance.now() - subsetStart;
        const result = runPreparedBatchSyntheticStateMiner({
            interval: data.interval,
            targets: subsetTargets,
            artifacts: subsetArtifacts,
            profile,
        });
        addStabilityVerdicts(accumulator, result.verdicts);
    }
    return { accumulator, profile, rerunsExecuted: data.endRerun - data.startRerun };
}

function normalizeSelectedIndexes(data: StabilityWorkerData): number[][] {
    if (Array.isArray(data.selectedIndexesByRerun)
        && data.selectedIndexesByRerun.length === data.endRerun - data.startRerun) {
        return data.selectedIndexesByRerun.map((indexes) =>
            indexes
                .map((index) => Math.floor(index))
                .filter((index) => index >= 0 && index < data.artifactFiles.length)
        );
    }
    const allPairIndexes = Array.from({ length: data.artifactFiles.length }, (_, index) => index);
    const out: number[][] = [];
    for (let runIndex = data.startRerun; runIndex < data.endRerun; runIndex += 1) {
        out.push(sampleItems(allPairIndexes, data.subsetSize, data.seed + runIndex));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

if (parentPort && workerData) {
    // Defer the import-time check so this module is also importable from tests
    // (where there is no parentPort). When run as a worker, execute and post
    // the result back.
    try {
        const data = workerData as StabilityWorkerData;
        const result = runStabilityRerunRange(data);
        parentPort.postMessage(result);
    } catch (error) {
        // Post the error back so the parent can fall back to sequential TS.
        parentPort.postMessage({
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
