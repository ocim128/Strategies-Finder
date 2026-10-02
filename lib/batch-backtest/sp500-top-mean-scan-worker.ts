/**
 * TOP_MEAN parallel replay scan worker (stage 1 of the OPEN_SCORE USD replay).
 *
 * The sequential scan re-reads and re-parses every persisted shard on the
 * coordinator's single thread (~51 s per replay pass on a 50k-pair run) while
 * the machine idles after the backtest pool terminates. This worker scans a
 * slice of completed shards with the EXACT per-artifact logic of
 * {@link scanPairArtifact} and ships compact COLUMNAR results: per-pair
 * ScoreDeltaBuffer columns packed per shard, with shard-local asset indexes
 * that the coordinator remaps into the global first-encounter order at merge
 * time — reproducing the sequential scan's asset indexing bit-for-bit.
 *
 * Any failure (unreadable shard, worker crash, bundle failure) makes the pool
 * return "fallback" and the replay engine reruns the sequential scan, so the
 * fast path can never change scan semantics.
 */
import { parentPort, workerData } from "node:worker_threads";
import { toBatchSyntheticPairAdapter, type CompactPairArtifact } from "./compact-pair-artifact";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import { readShardArtifactsAsync } from "./sp500-top-mean-artifact-store";
import { compareDeltas, scanPairArtifact, type PairArtifactScanContext } from "./open-score-replay/artifact-scan";
import type { ScoreDelta } from "./open-score-replay/internal-types";

export interface TopMeanScanWorkerData {
    runId: string;
    baseDir?: string;
    shardIndexes: number[];
}

/** NO_QUOTE_LEG marks pairs whose adapted artifact has no quote asset. */
export const TOP_MEAN_SCAN_NO_QUOTE_LEG = 0xffffffff;

export interface TopMeanScanShardResult {
    shardIndex: number;
    ok: boolean;
    /** Shard-local asset name table in first-encounter order (ok results). */
    names?: string[];
    /** [name, count] pairs replicating the sequential static-degree counting. */
    retainedDegree?: Array<[string, number]>;
    /** Loaded artifacts (sequential pairCount counts every loaded artifact). */
    loadedArtifacts?: number;
    /** Artifacts with no trades (the coordinator loader's noTradePairs side count). */
    tradelessPairs?: number;
    omittedPairs?: number;
    /** Per scanned pair: delta count, then flags (bit0 profitable, bit1 pnlKnown). */
    pairLengths?: Uint32Array;
    pairFlags?: Uint8Array;
    /** Packed per-shard ScoreDeltaBuffer columns (shard-local asset indexes). */
    timeSecs?: Float64Array;
    assetIndices?: Uint32Array;
    deltas?: Float64Array;
    pnlShares?: Float64Array;
    confidenceWeights?: Float64Array;
    deltaFlags?: Uint8Array;
}

interface ShardScanAccumulator {
    shardIndex: number;
    names: string[];
    retainedDegree: Map<string, number>;
    loadedArtifacts: number;
    tradelessPairs: number;
    omittedPairs: number;
    pairLengths: number[];
    pairFlags: number[];
    rows: ScoreDelta[];
    rowOffsets: number[];
}

function scanShard(shardIndex: number, artifacts: CompactPairArtifact[]): TopMeanScanShardResult {
    const names: string[] = [];
    const localIndexByName = new Map<string, number>();
    const ctx: PairArtifactScanContext = {
        assetIndex: (name: string): number => {
            let idx = localIndexByName.get(name);
            if (idx === undefined) {
                idx = names.length;
                localIndexByName.set(name, idx);
                names.push(name);
            }
            return idx;
        },
        capTiltWeight: null,
        lookupMarketCap: null,
        capTiltCoverage: null,
        capTiltWindowCoverage: { long: 0, known: 0, weighted: 0, unknown: 0 },
        capTiltCarryInCoverage: { long: 0, known: 0, weighted: 0, unknown: 0 },
        capTiltUnknownAssets: new Map<string, number>(),
        sampleFromSec: undefined,
        sampleToSec: undefined,
    };
    const retainedDegree = new Map<string, number>();
    const acc: ShardScanAccumulator = {
        shardIndex,
        names,
        retainedDegree,
        loadedArtifacts: 0,
        tradelessPairs: 0,
        omittedPairs: 0,
        pairLengths: [],
        pairFlags: [],
        rows: [],
        rowOffsets: [],
    };
    for (const compact of artifacts) {
        acc.loadedArtifacts += 1;
        // The adapter's partial result satisfies everything scanPairArtifact
        // consumes; the sequential path crosses the same seam via the
        // coordinator loader's cast.
        const artifact = toBatchSyntheticPairAdapter(compact) as unknown as BatchSyntheticPairArtifact;
        const outcome = scanPairArtifact(artifact, ctx);
        // Same static-degree contract as the sequential scan: count every leg
        // of every loaded artifact, trades or not.
        if (outcome.baseName) retainedDegree.set(outcome.baseName, (retainedDegree.get(outcome.baseName) ?? 0) + 1);
        if (outcome.quoteName && outcome.quoteName !== outcome.baseName) {
            retainedDegree.set(outcome.quoteName, (retainedDegree.get(outcome.quoteName) ?? 0) + 1);
        }
        if ((artifact.result?.trades ?? []).length === 0) acc.tradelessPairs += 1;
        if (outcome.omitted) {
            acc.omittedPairs += 1;
            continue;
        }
        outcome.deltas.sort(compareDeltas);
        acc.pairLengths.push(outcome.deltas.length);
        acc.pairFlags.push((outcome.profitable ? 1 : 0) | (outcome.pnlKnown ? 2 : 0));
        acc.rowOffsets.push(acc.rows.length);
        for (const row of outcome.deltas) acc.rows.push(row);
    }
    return packShard(acc);
}

function packShard(acc: ShardScanAccumulator): TopMeanScanShardResult {
    const total = acc.rows.length;
    const timeSecs = new Float64Array(total);
    const assetIndices = new Uint32Array(total);
    const deltas = new Float64Array(total);
    const pnlShares = new Float64Array(total);
    const confidenceWeights = new Float64Array(total);
    const deltaFlags = new Uint8Array(total);
    for (let i = 0; i < acc.rows.length; i += 1) {
        const row = acc.rows[i]!;
        timeSecs[i] = row.timeSec;
        assetIndices[i] = row.assetIndex;
        deltas[i] = row.delta;
        pnlShares[i] = row.pnlShare;
        confidenceWeights[i] = row.profitNowConfidenceWeight;
        deltaFlags[i] = row.isEntry | (row.voteApplied ? 2 : 0);
    }
    return {
        shardIndex: acc.shardIndex,
        ok: true,
        names: acc.names,
        retainedDegree: [...acc.retainedDegree.entries()],
        loadedArtifacts: acc.loadedArtifacts,
        tradelessPairs: acc.tradelessPairs,
        omittedPairs: acc.omittedPairs,
        pairLengths: new Uint32Array(acc.pairLengths),
        pairFlags: new Uint8Array(acc.pairFlags),
        timeSecs,
        assetIndices,
        deltas,
        pnlShares,
        confidenceWeights,
        deltaFlags,
    };
}

async function main(): Promise<void> {
    const data = workerData as TopMeanScanWorkerData;
    const shards: TopMeanScanShardResult[] = [];
    for (const shardIndex of data.shardIndexes) {
        try {
            const artifacts = await readShardArtifactsAsync(data.runId, shardIndex, data.baseDir);
            shards.push(artifacts
                ? scanShard(shardIndex, artifacts)
                : { shardIndex, ok: false });
        } catch {
            shards.push({ shardIndex, ok: false });
        }
    }
    if (!parentPort) throw new Error("top-mean scan worker requires a parent port");
    const transfer = shards.flatMap((shard) => [
        shard.pairLengths?.buffer, shard.pairFlags?.buffer, shard.timeSecs?.buffer,
        shard.assetIndices?.buffer, shard.deltas?.buffer, shard.pnlShares?.buffer,
        shard.confidenceWeights?.buffer, shard.deltaFlags?.buffer,
    ].filter((buf): buf is ArrayBufferLike => buf instanceof ArrayBuffer));
    parentPort.postMessage({ type: "topMeanScanResult", shards }, transfer);
}

void main();
