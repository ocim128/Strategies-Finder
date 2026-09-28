/**
 * Statistical leaf helpers for the OPEN_SCORE USD replay. Every public metric
 * is number | null and finite-guarded (NaN/Infinity never cross the wire —
 * they serialize to null). Moved verbatim from the engine entry point;
 * behavior contracts (tie digests, accumulation order, bootstrap draws,
 * signed-zero handling) are documented at each helper and must not change.
 */
import { MAX_ACTIVE_BLOCK_COUNT, MAX_ACTIVE_BOOTSTRAP_SEED } from "../max-active-research-contract";
import type { AssetSelectionSummary, DegreeSummary, ReplayComparison } from "./types";

// ============================================================================
// Small stat helpers (NaN/Infinity never cross the wire — they serialize to
// null, so every public metric is number | null and finite-guarded).
// ============================================================================

export function median(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return Number.NaN;
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function finiteOrNull(x: number): number | null {
    return Number.isFinite(x) ? x : null;
}

/**
 * Causal confidence weight for a PROFIT_NOW pair vote.
 *
 * `realizedNetPnl` and `grossAbsPnl` contain only trades closed before the
 * vote's entry. The net/gross ratio rewards consistency while `n/(n+1)`
 * shrinks a one-trade winner to 0.5 and approaches 1 with more evidence.
 */
export function computeProfitNowConfidenceWeight(
    closedTradeCount: number,
    realizedNetPnl: number,
    grossAbsPnl: number,
): number {
    if (
        !Number.isFinite(closedTradeCount)
        || closedTradeCount <= 0
        || !Number.isFinite(realizedNetPnl)
        || realizedNetPnl <= 0
        || !Number.isFinite(grossAbsPnl)
        || grossAbsPnl <= 0
    ) return 0;
    const evidenceShrinkage = closedTradeCount / (closedTradeCount + 1);
    const consistency = realizedNetPnl / grossAbsPnl;
    return Math.max(0, Math.min(1, evidenceShrinkage * consistency));
}

export function meanOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return finiteOrNull(s / values.length);
}


/**
 * Shape of a per-selector sample map (returns + deltas accumulated per asset
 * across the events the selector chose that asset). Used by both the per-asset
 * breakdown builder and the dominant-asset exclusion helper below.
 */
export type SelectorSamplesByAsset = Map<string, { returns: number[]; deltas: number[] }>;

/**
 * Shape of a per-selector event series consumed by the dominant-asset
 * exclusion helper: parallel arrays of (delta, selectedReturn, timeSec,
 * assetName) per eligible event.
 */
export interface SelectorExclusionSeries {
    readonly deltas: readonly number[];
    readonly returns: readonly number[];
    readonly times: readonly number[];
    readonly assets: readonly string[];
}

/**
 * Build the per-asset selection breakdown that every asset-picking arm
 * (TOP_RAW / TOP_MEAN / MAX_ACTIVE, plus future arms) emits for the
 * `<ARM> selected assets` report block. Returns the sorted summary plus the
 * totals used in the report header.
 *
 * Sort order: events desc, then asset name asc — same rule the six prior
 * copy-pasted blocks used. `maxSelected` is computed by iterating the
 * values directly instead of `Math.max(0, ...map.values())`, which would
 * risk `Maximum call stack size exceeded` on the documented 124k-pair scale.
 */
export function buildAssetSelectionBreakdown(
    selectedByAsset: Map<string, number>,
    samplesByAsset: SelectorSamplesByAsset,
): {
    byAsset: AssetSelectionSummary[];
    totalSelected: number;
    maxSelected: number;
} {
    let totalSelected = 0;
    let maxSelected = 0;
    for (const v of selectedByAsset.values()) {
        totalSelected += v;
        if (v > maxSelected) maxSelected = v;
    }
    const byAsset: AssetSelectionSummary[] = [...selectedByAsset.entries()]
        .map(([asset, events]) => {
            const samples = samplesByAsset.get(asset)!;
            const selectedMean = meanOrNull(samples.returns);
            const delta = meanOrNull(samples.deltas);
            return {
                asset,
                events,
                share: totalSelected > 0 ? events / totalSelected : 0,
                topMean: selectedMean,
                randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                delta,
            };
        })
        .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
    return { byAsset, totalSelected, maxSelected };
}

/**
 * Compute the `<ARM>_EX_<dominant>` comparison: drop events whose selected
 * asset equals `dominantAsset`, then build a `ReplayComparison` over the
 * surviving series. This is the concentration-vs-broad-based diagnostic every
 * asset-picking arm ships alongside its `selected assets` breakdown.
 *
 * Module-level so the breakdown/exclusion logic is unit-testable; previously
 * it was inlined six times inside a 1300-line function. The `buildComparison`
 * callback is injected because it closes over per-horizon `blockCount` and
 * `bootstrapSamples` parameters.
 */
export function buildExDominantComparison(
    series: SelectorExclusionSeries,
    dominantAsset: string | null,
    buildComparison: (deltas: number[], returns: number[], times: number[]) => ReplayComparison,
): ReplayComparison {
    const nonDominantIndexes: number[] = [];
    for (let i = 0; i < series.assets.length; i += 1) {
        if (series.assets[i] !== dominantAsset) nonDominantIndexes.push(i);
    }
    return buildComparison(
        nonDominantIndexes.map((i) => series.deltas[i]!),
        nonDominantIndexes.map((i) => series.returns[i]!),
        nonDominantIndexes.map((i) => series.times[i]!),
    );
}

/**
 * Deterministic block bootstrap for the MEDIAN per-event delta. Same
 * fixed-seed LCG and chronological blocks as a mean CI would use, but each
 * resample pools the RAW deltas of the sampled blocks and takes their median,
 * so the interval brackets the reported median delta rather than the mean.
 *
 * Each block is sorted ONCE. A resample counts how often each block was
 * drawn and locates both middle elements by weighted rank queries over the
 * blocks' sorted contents (see the implementation comment on
 * `pooledValueAtRank`) instead of merging the pooled multiset — same draws,
 * same pooled order statistics, so results are bit-identical without the
 * per-resample heap work (sorting ~3k events x 2000 resamples dominated the
 * replay phase, then the merge did too).
 *
 * Phase 0 freeze: a formal CI requires EXACTLY {@link MAX_ACTIVE_BLOCK_COUNT}
 * nonempty chronological blocks. Fewer blocks (incl. one) return null CI —
 * `INSUFFICIENT_DATA`, never a misleading point CI from a single block.
 */
export function blockBootstrapMedianCi(
    blocks: readonly (readonly number[])[],
    resamples: number,
    /**
     * Redundant-work plan phase 3: optional pre-sorted view of the WHOLE
     * sample (exactly the multiset of values in `blocks`, ascending). When
     * supplied, the distinct-value union below scans it instead of
     * concatenating every sorted block and re-sorting the sample. The union
     * feeds only <=-rank counts (and a never-reached fallback), so which
     * stored duplicate represents an equal run — including the -0/+0
     * variant — cannot change the returned interval; medians are always read
     * from the sorted blocks. Not mutated, not re-sorted, not cached.
     */
    sortedSample?: readonly number[],
): { lower: number | null; upper: number | null } {
    const b = blocks.length;
    if (b < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    const sortedBlocks = blocks.map((blk) => [...blk].sort((x, y) => x - y));
    let seed = (Math.floor(MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
    const next = (): number => {
        // LCG (Numerical Recipes constants), returns [0,1).
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const medians: number[] = [];
    // Weighted-rank median selection. Instead of k-way-merging the sampled
    // blocks up to their middle element on every resample, precompute ONCE the
    // sorted distinct value union U of all blocks and, per block, how many of
    // its elements are <= each U entry (upper bounds). A resample then only
    // counts how often each block was drawn; the number of pooled elements <=
    // U[i] is sum(counts[k] * upper[k][i]) — O(b) per rank query, so both
    // middle elements come from two O(b log|U|) binary searches. The drawn
    // values and their order are identical to the former heap merge (same LCG
    // draws, same pooled multiset), so medians are bit-identical; duplicate
    // values collapse to one U entry whose multiplicity covers every copy.
    let unionValues: number[];
    if (sortedSample !== undefined) {
        unionValues = [];
        for (let i = 0; i < sortedSample.length; i += 1) {
            if (i === 0 || sortedSample[i] !== sortedSample[i - 1]) unionValues.push(sortedSample[i]!);
        }
    } else {
        const distinctValues: number[] = [];
        for (const blk of sortedBlocks) {
            for (const value of blk) distinctValues.push(value);
        }
        distinctValues.sort((x, y) => x - y);
        unionValues = [];
        for (let i = 0; i < distinctValues.length; i += 1) {
            if (i === 0 || distinctValues[i] !== distinctValues[i - 1]) unionValues.push(distinctValues[i]!);
        }
    }
    // upperByBlock[k][i] = count of elements in sortedBlocks[k] <= unionValues[i].
    // lowerByBlock[k][i] (count strictly < unionValues[i]) is NOT stored: the
    // union is sorted and distinct, so lower[k][i] === (i === 0 ? 0 :
    // upper[k][i - 1]) exactly — for any totally ordered values under < (NaN
    // inputs already break the union sort, so this adds no new failure mode).
    // Selection-aggregation plan phase 2: one rank-count matrix instead of two.
    const upperByBlock: Int32Array[] = sortedBlocks.map((blk) => {
        const upper = new Int32Array(unionValues.length);
        let cursor = 0;
        for (let i = 0; i < unionValues.length; i += 1) {
            while (cursor < blk.length && blk[cursor]! <= unionValues[i]!) cursor += 1;
            upper[i] = cursor;
        }
        return upper;
    });
    const lowerAt = (blockIndex: number, unionIndex: number): number =>
        unionIndex === 0 ? 0 : upperByBlock[blockIndex]![unionIndex - 1]!;
    // Per-resample draw assignment: position p drew block drawnAtPosition[p].
    // The former heap kept one entry per POSITION (ties broken by ascending
    // position), each walking its block's sorted array — so within a run of
    // equal-comparing values the emitted order is position order, repeats
    // included, not block order. Reproducing that order matters for the sign
    // of zero: the merge emitted stored -0/+0 verbatim, so a rank landing
    // inside a zero run must return the same stored variant.
    const drawnAtPosition = new Int32Array(b);
    const drawCounts = new Int32Array(b);
    const elementCountUpTo = (unionIndex: number): number => {
        let totalUpto = 0;
        for (let k = 0; k < b; k += 1) {
            const drawn = drawCounts[k]!;
            if (drawn > 0) totalUpto += drawn * upperByBlock[k]![unionIndex]!;
        }
        return totalUpto;
    };
    const elementCountBelow = (unionIndex: number): number => {
        let totalBelow = 0;
        for (let k = 0; k < b; k += 1) {
            const drawn = drawCounts[k]!;
            if (drawn > 0) totalBelow += drawn * lowerAt(k, unionIndex);
        }
        return totalBelow;
    };
    // Element at 0-indexed rank m of the pooled multiset: its distinct-value
    // run is the smallest whose <=-count exceeds m; the offset inside the run
    // then walks positions in ascending order (each position's block run in
    // block-sorted order), exactly the former merge's emission order.
    const pooledValueAtRank = (rank: number): number => {
        let lo = 0;
        let hi = unionValues.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (elementCountUpTo(mid) > rank) hi = mid;
            else lo = mid + 1;
        }
        let offset = rank - elementCountBelow(lo);
        for (let p = 0; p < b; p += 1) {
            const blockIndex = drawnAtPosition[p]!;
            const lower = lowerAt(blockIndex, lo);
            const runLength = upperByBlock[blockIndex]![lo]! - lower;
            if (offset < runLength) {
                return sortedBlocks[blockIndex]![lower + offset]!;
            }
            offset -= runLength;
        }
        return unionValues[lo]!;
    };
    for (let r = 0; r < resamples; r += 1) {
        let total = 0;
        drawCounts.fill(0);
        for (let k = 0; k < b; k += 1) {
            const blockIndex = Math.floor(next() * b);
            drawnAtPosition[k] = blockIndex;
            drawCounts[blockIndex] += 1;
            total += sortedBlocks[blockIndex]!.length;
        }
        if (total === 0) {
            // Degenerate all-empty sample: mirrors the former loop, which
            // pushed its initial prev/last zeros for an empty merge.
            medians.push(0);
            continue;
        }
        const midLo = (total - 1) >> 1;
        const midHi = total >> 1;
        const loValue = pooledValueAtRank(midLo);
        const hiValue = midLo === midHi ? loValue : pooledValueAtRank(midHi);
        medians.push(midLo === midHi ? loValue : (loValue + hiValue) / 2);
    }
    medians.sort((x, y) => x - y);
    const lo = medians[Math.max(0, Math.floor(0.025 * resamples))]!;
    const hi = medians[Math.min(resamples - 1, Math.floor(0.975 * resamples))]!;
    return { lower: finiteOrNull(lo), upper: finiteOrNull(hi) };
}

export function degreeSummary(degrees: readonly number[], topAssetShare: number | null): DegreeSummary {
    if (degrees.length === 0) return { min: 0, median: 0, max: 0, topAssetShare: null };
    const sorted = [...degrees].sort((a, b) => a - b);
    return {
        min: sorted[0]!,
        median: median(sorted),
        max: sorted[sorted.length - 1]!,
        topAssetShare,
    };
}

/**
 * Split values into chronological blocks by their event times. Phase 0 freeze:
 * boundaries are `floor(block*n/k)..floor((block+1)*n/k)` for `k=blockCount`
 * (NOT `ceil(n/k)`), so each block is count-balanced and the partition covers
 * every index exactly once. Empty blocks are omitted; if any are omitted, the
 * block-bootstrap CI returns null (formal `INSUFFICIENT_DATA`).
 */
export function splitIntoBlocks(values: readonly number[], times: readonly number[], blockCount: number): number[][] {
    const n = values.length;
    if (n === 0) return [];
    // Checked chronological fast path (allocation reduction plan phase 2):
    // ordinary selector series append in view order, so their times are
    // usually already nondecreasing and neither the index array nor the sort
    // is needed. The O(n) scan is finite-guarded; profit-only appends can
    // break chronology, and any out-of-order, missing, or non-finite
    // timestamp selects the original stable index-sort path unchanged.
    let ordered = true;
    for (let i = 1; i < n; i += 1) {
        const prev = times[i - 1]!;
        const curr = times[i]!;
        if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr < prev) {
            ordered = false;
            break;
        }
    }
    const order = ordered ? null : times.map((_, i) => i).sort((a, b) => times[a]! - times[b]!);
    const k = Math.max(1, Math.min(blockCount, n));
    const blocks: number[][] = [];
    for (let b = 0; b < k; b += 1) {
        const start = Math.floor((b * n) / k);
        const end = Math.floor(((b + 1) * n) / k);
        if (end <= start) continue;
        const slice: number[] = [];
        if (order === null) {
            for (let i = start; i < end; i += 1) slice.push(values[i]!);
        } else {
            for (let i = start; i < end; i += 1) slice.push(values[order[i]!]!);
        }
        if (slice.length > 0) blocks.push(slice);
    }
    return blocks;
}
