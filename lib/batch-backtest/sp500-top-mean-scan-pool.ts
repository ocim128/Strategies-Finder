/**
 * Parallel stage-1 replay scan for TOP_MEAN (see sp500-top-mean-scan-worker.ts).
 *
 * Fan the completed shards out to short-lived worker threads, collect their
 * packed per-shard delta columns, and merge them in the manifest's completed-
 * shard order. The merge reproduces the sequential scan's global first-
 * encounter asset indexing exactly (shard order + in-shard artifact order are
 * preserved, and each shard's local name table is encountered in the same
 * base-then-quote sequence), so downstream sweep/outcome stages consume an
 * {@link ArtifactScanResult} that is semantically identical to
 * {@link scanArtifacts}'s output.
 *
 * Failure policy: ANY worker error, missing shard result, or failed shard
 * read returns "fallback" and the replay engine reruns the sequential scan —
 * the fast path is a pure accelerator, never a behavior change. Cap-tilt
 * runs stay sequential entirely (the caller gates on it).
 */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { debugLogger } from "../debug-logger";
import { loadManifest } from "./sp500-top-mean-artifact-store";
import { resolveTopMeanScanWorkerPath } from "./sp500-top-mean-worker-pool";
import type { ArtifactScanResult } from "./open-score-replay/artifact-scan";
import { ScoreDeltaBuffer } from "./open-score-replay/score-delta-buffer";
import type { TopMeanScanShardResult } from "./sp500-top-mean-scan-worker";

/** Below this shard count the spawn + merge overhead exceeds the scan saving. */
export const PARALLEL_SCAN_MIN_SHARDS = 8;
export const PARALLEL_SCAN_MAX_WORKERS = 8;

export type ParallelArtifactScanOutcome =
    | { status: "ok"; result: ArtifactScanResult; tradelessPairs: number }
    | { status: "cancelled"; pairs: number }
    | { status: "fallback" };

interface WorkerResult {
    ok: boolean;
    shards: TopMeanScanShardResult[];
}

function spawnScanWorker(
    workerPath: string,
    runId: string,
    baseDir: string | undefined,
    shardIndexes: number[],
    enableCausalArms?: boolean,
    enableDirectionalArm?: boolean,
): { worker: Worker; done: Promise<WorkerResult> } {
    const worker = new Worker(workerPath, {
        workerData: { runId, baseDir, shardIndexes, enableCausalArms, enableDirectionalArm },
    });
    const collected: TopMeanScanShardResult[] = [];
    let failed = false;
    const done = new Promise<WorkerResult>((resolve) => {
        worker.on("message", (msg: { type?: string; shards?: TopMeanScanShardResult[] }) => {
            if (msg?.type === "topMeanScanResult" && Array.isArray(msg.shards)) collected.push(...msg.shards);
        });
        worker.on("error", () => {
            failed = true;
            resolve({ ok: false, shards: [] });
        });
        worker.on("exit", () => resolve({ ok: !failed, shards: collected }));
    });
    return { worker, done };
}

/**
 * Reorder one pair's delta segment into the sequential comparator's order
 * (timeSec ASC, global assetIndex ASC, isEntry DESC). Workers sort with
 * shard-local indexes, so whenever a pair's quote leg carries a smaller
 * GLOBAL index than its base the remapped rows arrive swapped relative to
 * what the sequential scan's stable sort produced. Equal tuples keep their
 * insertion order in both paths (stable sorts, identical push order), so
 * re-applying the comparator after the remap restores exact sequential order.
 */
function ensureSegmentOrder(
    timeSecs: Float64Array,
    assetIndices: Uint32Array,
    deltas: Float64Array,
    pnlShares: Float64Array,
    confidenceWeights: Float64Array,
    flags: Uint8Array,
    offset: number,
    length: number,
    entrySecs?: Float64Array,
): void {
    let sorted = true;
    for (let i = 1; i < length; i += 1) {
        const a = offset + i - 1;
        const b = offset + i;
        const cmp = timeSecs[a]! - timeSecs[b]!
            || assetIndices[a]! - assetIndices[b]!
            || (flags[b]! & 1) - (flags[a]! & 1);
        if (cmp > 0) {
            sorted = false;
            break;
        }
    }
    if (sorted) return;
    const order = new Uint32Array(length);
    for (let i = 0; i < length; i += 1) order[i] = i;
    order.sort((x, y) => {
        const a = offset + x!;
        const b = offset + y!;
        return timeSecs[a]! - timeSecs[b]!
            || assetIndices[a]! - assetIndices[b]!
            || (flags[b]! & 1) - (flags[a]! & 1);
    });
    const tempF64 = new Float64Array(length);
    const tempU32 = new Uint32Array(length);
    const tempU8 = new Uint8Array(length);
    if (entrySecs) {
        for (let i = 0; i < length; i++) tempF64[i] = entrySecs[offset + order[i]!]!;
        for (let i = 0; i < length; i++) entrySecs[offset + i] = tempF64[i]!;
    }
    for (let i = 0; i < length; i += 1) tempF64[i] = timeSecs[offset + order[i]!];
    for (let i = 0; i < length; i += 1) timeSecs[offset + i] = tempF64[i];
    for (let i = 0; i < length; i += 1) tempU32[i] = assetIndices[offset + order[i]!];
    for (let i = 0; i < length; i += 1) assetIndices[offset + i] = tempU32[i];
    for (let i = 0; i < length; i += 1) tempF64[i] = deltas[offset + order[i]!];
    for (let i = 0; i < length; i += 1) deltas[offset + i] = tempF64[i];
    for (let i = 0; i < length; i += 1) tempF64[i] = pnlShares[offset + order[i]!];
    for (let i = 0; i < length; i += 1) pnlShares[offset + i] = tempF64[i];
    for (let i = 0; i < length; i += 1) tempF64[i] = confidenceWeights[offset + order[i]!];
    for (let i = 0; i < length; i += 1) confidenceWeights[offset + i] = tempF64[i];
    for (let i = 0; i < length; i += 1) tempU8[i] = flags[offset + order[i]!];
    for (let i = 0; i < length; i += 1) flags[offset + i] = tempU8[i];
}

export async function runParallelArtifactScan(args: {
    enableDirectionalArm?: boolean;
    enableCausalArms?: boolean;
    runId: string;
    baseDir?: string;
    shouldStop: () => boolean;
    /**
     * Optional progress sink with the replay engine's phase callback shape.
     * Called once per merged shard with phase "scan" so the coordinator's
     * PERFORMANCE diagnostic keeps measuring scan time on the fast path.
     */
    onPhase?: (phase: "scan", detail: string, completed: number, total: number) => void;
    /** Test seam: override the derived worker count. */
    workerCount?: number;
}): Promise<ParallelArtifactScanOutcome> {
    const manifest = loadManifest(args.runId, args.baseDir);
    const completedShards = manifest?.completedShards ?? [];
    if (completedShards.length < PARALLEL_SCAN_MIN_SHARDS) return { status: "fallback" };

    let workerPath: string;
    try {
        workerPath = await resolveTopMeanScanWorkerPath();
    } catch {
        return { status: "fallback" };
    }

    const workerCount = Math.max(1, Math.min(
        PARALLEL_SCAN_MAX_WORKERS,
        args.workerCount ?? availableParallelism(),
        completedShards.length,
    ));
    // Interleaved assignment: consecutive shards share legs/assets, so round-
    // robin spreads each asset's parse work across workers instead of giving
    // one worker every shard that touches a heavy seed.
    const assignments: number[][] = Array.from({ length: workerCount }, () => []);
    completedShards.forEach((shardIndex, position) => {
        assignments[position % workerCount]!.push(shardIndex);
    });

    const spawned = assignments.map((shardIndexes) =>
        spawnScanWorker(workerPath, args.runId, args.baseDir, shardIndexes, args.enableCausalArms, args.enableDirectionalArm));
    const terminateAll = (): void => {
        for (const { worker } of spawned) void worker.terminate();
    };

    try {
        const settled = await Promise.all(spawned.map(({ done }) => done));
        const shards = new Map<number, TopMeanScanShardResult>();
        for (const result of settled) {
            if (!result.ok) {
                terminateAll();
                return { status: "fallback" };
            }
            for (const shard of result.shards) {
                if (!shard.ok || shards.has(shard.shardIndex)) {
                    terminateAll();
                    return { status: "fallback" };
                }
                shards.set(shard.shardIndex, shard);
            }
        }
        if (shards.size !== completedShards.length) {
            terminateAll();
            return { status: "fallback" };
        }

        // --- Merge in completed-shard order (exact sequential semantics) ----
        const assetIndexByName = new Map<string, number>();
        const assetNames: string[] = [];
        const assetIndex = (name: string): number => {
            let idx = assetIndexByName.get(name);
            if (idx === undefined) {
                idx = assetNames.length;
                assetIndexByName.set(name, idx);
                assetNames.push(name);
            }
            return idx;
        };
        const validDegree = args.enableCausalArms ? new Map<string, number>() : undefined;
        const retainedDegree = new Map<string, number>();
        const streams: ScoreDeltaBuffer[] = [];
        const profitableStreams: boolean[] = [];
        const pnlKnownStreams: boolean[] = [];
        let pairCount = 0;
        let omittedPairs = 0;
        let tradelessPairs = 0;
        let missingDirectionalMaturityTrades = 0;

        let done = 0;
        for (const shardIndex of completedShards) {
            if (args.shouldStop()) {
                terminateAll();
                return { status: "cancelled", pairs: pairCount };
            }
            const shard = shards.get(shardIndex)!;
            const localToGlobal = new Uint32Array(shard.names!.length);
            for (let i = 0; i < shard.names!.length; i += 1) localToGlobal[i] = assetIndex(shard.names![i]!);
            const assetIndices = shard.assetIndices!;
            for (let i = 0; i < assetIndices.length; i += 1) {
                assetIndices[i] = localToGlobal[assetIndices[i]!]!;
            }
            const timeSecs = shard.timeSecs!;
            const deltas = shard.deltas!;
            const pnlShares = shard.pnlShares!;
            const confidenceWeights = shard.confidenceWeights!;
            const deltaFlags = shard.deltaFlags!;
            missingDirectionalMaturityTrades += shard.missingDirectionalMaturityTrades ?? 0;
            if (args.enableCausalArms && (!shard.entrySecs || !shard.validDegree)) return { status: "fallback" };
            const lengths = shard.pairLengths!;
            const flags = shard.pairFlags!;
            let offset = 0;
            for (let pair = 0; pair < lengths.length; pair += 1) {
                const length = lengths[pair]!;
                const end = offset + length;
                ensureSegmentOrder(timeSecs, assetIndices, deltas, pnlShares, confidenceWeights, deltaFlags, offset, length, shard.entrySecs);
                streams.push(new ScoreDeltaBuffer(length, {
                    ...(shard.entrySecs ? { entrySecs: shard.entrySecs.subarray(offset, end) } : {}),
                    timeSecs: timeSecs.subarray(offset, end),
                    assetIndices: assetIndices.subarray(offset, end),
                    deltas: deltas.subarray(offset, end),
                    pnlShares: pnlShares.subarray(offset, end),
                    confidenceWeights: confidenceWeights.subarray(offset, end),
                    flags: deltaFlags.subarray(offset, end),
                }));
                profitableStreams.push((flags[pair]! & 1) === 1);
                pnlKnownStreams.push((flags[pair]! & 2) === 2);
                offset = end;
            }
            for (const [name, count] of shard.validDegree ?? []) validDegree!.set(name, (validDegree!.get(name) ?? 0) + count);
            for (const [name, count] of shard.retainedDegree!) {
                retainedDegree.set(name, (retainedDegree.get(name) ?? 0) + count);
            }
            pairCount += shard.loadedArtifacts!;
            omittedPairs += shard.omittedPairs!;
            tradelessPairs += shard.tradelessPairs!;
            args.onPhase?.("scan", `scanned ${done + 1}/${completedShards.length} shards (parallel)`, done + 1, completedShards.length);
            done += 1;
        }
        return {
            status: "ok",
            tradelessPairs,
            result: {
                ...(validDegree ? { validDegree } : {}),
                assetIndexByName,
                assetNames,
                retainedDegree,
                streams,
                profitableStreams,
                pnlKnownStreams,
                pairCount,
                ...(args.enableDirectionalArm ? { missingDirectionalMaturityTrades } : {}),
                omittedPairs,
                // The parallel path runs only when cap-tilt is inactive, so the
                // coverage counters match the sequential scan's inactive shape.
                capTiltCoverage: null,
                capTiltWindowCoverage: { long: 0, known: 0, weighted: 0, unknown: 0 },
                capTiltCarryInCoverage: { long: 0, known: 0, weighted: 0, unknown: 0 },
                capTiltUnknownAssets: new Map<string, number>(),
            },
        };
    } catch (error) {
        debugLogger.warn("sp500_top_mean.parallel_scan_failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        return { status: "fallback" };
    } finally {
        for (const { worker } of spawned) {
            if (worker.threadId !== -1) void worker.terminate();
        }
    }
}
