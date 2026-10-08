/**
 * Read-side helpers for the offline TOP_MEAN selector rule checker
 * (`scripts/top-mean-rule-checker.ts`): frozen research-window constants,
 * Phase 0b archive loading, chronological block splitting, and the fixed-seed
 * block bootstrap intervals.
 *
 * These helpers were relocated from the retired pairlist pool-rule analyzer
 * (`scripts/analyze-pool-rules.ts`, removed with its P1/P2 research) because
 * the surviving checker and its specs still depend on them. The window and
 * quantile constants are frozen provenance for the checked archive runs —
 * changing them changes checker windows and intervals, so they stay literal.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
} from "./max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "./batch-open-score-usd-replay-engine";

/**
 * Frozen checker windows: the analyzer's discovery window (2025) and the
 * out-of-sample validation window (2026 through 2026-08-24) the checker
 * reports against.
 */
export const PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC = Math.floor(Date.parse("2025-01-10T00:00:00.000Z") / 1000);
export const PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC = Math.floor(Date.parse("2025-12-31T23:59:59.999Z") / 1000);
export const PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
export const PAIRLIST_POOL_RULE_VALIDATION_TO_SEC = Math.floor(Date.parse("2026-08-24T23:59:59.999Z") / 1000);
/** Bootstrap CI quantiles shared by both block-bootstrap intervals. */
export const PAIRLIST_POOL_RULE_CI_LOW_QUANTILE = 0.025;
export const PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE = 0.975;

export interface PoolRuleMeta {
    interval?: unknown;
    horizons?: unknown;
    canonicalAssets?: unknown;
    manifest?: {
        pairs?: { source?: { poolVersion?: unknown } };
        catalog?: { assets?: unknown };
    };
}

export interface PoolRuleEventRow {
    eventId?: unknown;
    decisionTime?: unknown;
    horizonBars?: unknown;
    selector?: unknown;
    direction?: unknown;
    delta?: unknown;
}

export interface PoolRuleArchive {
    meta: PoolRuleMeta;
    snapshots: readonly PoolSnapshotRecord[];
    outcomes: readonly CandidateOutcomeRecord[];
    eventRows: readonly PoolRuleEventRow[];
}

export interface PoolRuleValuePoint {
    eventId: string;
    decisionTimeSec: number;
    value: number;
    selectedAsset?: string;
}

function readJsonl<T>(filename: string): T[] {
    return readFileSync(filename, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as T;
            } catch (error) {
                throw new Error(`${filename}:${index + 1}: invalid JSON (${String(error)})`);
            }
        });
}

export function loadPoolRuleArchive(root: string, runId: string): PoolRuleArchive {
    const runDir = path.join(root, "archive", "batch-open-score", runId);
    const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8")) as PoolRuleMeta;
    return {
        meta,
        snapshots: readJsonl<PoolSnapshotRecord>(path.join(runDir, "pool-snapshots.jsonl")),
        outcomes: readJsonl<CandidateOutcomeRecord>(path.join(runDir, "candidate-outcomes.jsonl")),
        eventRows: readJsonl<PoolRuleEventRow>(path.join(runDir, "events-full.jsonl")),
    };
}

function quantile(sortedValues: readonly number[], fraction: number): number | null {
    if (sortedValues.length === 0) return null;
    return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length)))] ?? null;
}

function createLcg(seed: number): () => number {
    let state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

export function splitChronologicalBlocks(points: readonly PoolRuleValuePoint[]): number[][] {
    if (points.length === 0) return [];
    const order = points.map((_, index) => index).sort((left, right) =>
        points[left]!.decisionTimeSec - points[right]!.decisionTimeSec || points[left]!.eventId.localeCompare(points[right]!.eventId));
    const blocks: number[][] = [];
    const count = Math.min(MAX_ACTIVE_BLOCK_COUNT, points.length);
    for (let block = 0; block < count; block += 1) {
        const start = Math.floor((block * points.length) / count);
        const end = Math.floor(((block + 1) * points.length) / count);
        if (end <= start) continue;
        blocks.push(order.slice(start, end).map((index) => points[index]!.value));
    }
    return blocks;
}

export function bootstrapBlockMeans(blockMeans: readonly number[], samples = MAX_ACTIVE_BOOTSTRAP_SAMPLES): { lower: number | null; upper: number | null } {
    if (blockMeans.length < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    const next = createLcg(MAX_ACTIVE_BOOTSTRAP_SEED);
    const means: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        let total = 0;
        for (let block = 0; block < blockMeans.length; block += 1) total += blockMeans[Math.floor(next() * blockMeans.length)]!;
        means.push(total / blockMeans.length);
    }
    means.sort((left, right) => left - right);
    return { lower: quantile(means, PAIRLIST_POOL_RULE_CI_LOW_QUANTILE), upper: quantile(means, PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE) };
}

/**
 * Block bootstrap for the MEDIAN per-event delta, mirroring the replay
 * engine's reported delta: same fixed-seed LCG resamples chronological
 * blocks with replacement, each resample pools the RAW block values and
 * takes their median, so the interval brackets the median rather than the
 * mean. Requires {@link MAX_ACTIVE_BLOCK_COUNT} nonempty blocks; fewer
 * return null CI (`INSUFFICIENT_DATA`).
 *
 * Each block is sorted once; every resample k-way-merges the chosen sorted
 * blocks only up to the middle position — the same pooled order statistics
 * a full pooled sort would produce, without the per-resample sort cost.
 */
export function bootstrapBlockMedian(blocks: readonly (readonly number[])[], samples = MAX_ACTIVE_BOOTSTRAP_SAMPLES): { lower: number | null; upper: number | null } {
    if (blocks.length < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    const sortedBlocks = blocks.map((block) => [...block].sort((left, right) => left - right));
    const next = createLcg(MAX_ACTIVE_BOOTSTRAP_SEED);
    const b = sortedBlocks.length;
    const chosen: number[][] = new Array(b);
    const heads: number[] = new Array<number>(b).fill(0);
    const medians: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        let total = 0;
        for (let block = 0; block < b; block += 1) {
            const blk = sortedBlocks[Math.floor(next() * b)]!;
            chosen[block] = blk;
            total += blk.length;
        }
        const midLo = (total - 1) >> 1;
        const midHi = total >> 1;
        for (let block = 0; block < b; block += 1) heads[block] = 0;
        let prev = 0;
        let last = 0;
        for (let emitted = 0; emitted <= midHi; emitted += 1) {
            let minBlock = -1;
            let minValue = 0;
            for (let block = 0; block < b; block += 1) {
                const blk = chosen[block]!;
                const pos = heads[block]!;
                if (pos < blk.length) {
                    const value = blk[pos]!;
                    if (minBlock === -1 || value < minValue) { minBlock = block; minValue = value; }
                }
            }
            heads[minBlock] = heads[minBlock]! + 1;
            prev = last;
            last = minValue;
        }
        medians.push(midLo === midHi ? last : (prev + last) / 2);
    }
    medians.sort((left, right) => left - right);
    return { lower: quantile(medians, PAIRLIST_POOL_RULE_CI_LOW_QUANTILE), upper: quantile(medians, PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE) };
}
