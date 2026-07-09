import type { BatchMinerEngine, BatchSyntheticAssetVerdict, BatchSyntheticMinerProfile } from "./batch-synthetic-state-miner";

export interface BatchStabilityAccumulator {
    reruns: number;
    subsetSize: number;
    seed: number;
    totalPairs: number;
    targetAssets: number;
    hitEvents: number;
    rows: Map<string, BatchStabilityRowAccumulator>;
}

interface BatchStabilityRowAccumulator {
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
    /**
     * One agreeing-pair set per hit. Used to detect the "stable but repeating
     * the same pair" failure mode: with 400 pairs / 200-per-rerun × N reruns,
     * `hits` cannot tell whether N independent agreeing-pair sets converged or
     * the same one or two dominant pairs got resampled every time. Jaccard
     * diversity across these sets distinguishes them.
     */
    agreeingSets: string[][];
}

/**
 * Re-exported so the Phase 3 parallel orchestrator (`batch-stability-parallel.ts`)
 * can type its merge of per-worker row accumulators. Exported as a type alias
 * (the interface is intentionally not part of the public result contract; the
 * finalized `BatchStabilityRow` is what crosses out of this module).
 */
export type { BatchStabilityRowAccumulator };

export interface BatchStabilityMineResult {
    reruns: number;
    subsetSize: number;
    seed: number;
    totalPairs: number;
    targetAssets: number;
    hitEvents: number;
    minerProfile?: BatchSyntheticMinerProfile | null;
    /**
     * Which miner engine actually ran (Phase 6 reporting). Omitted on the
     * sequential TypeScript path for backward-compatible default JSON; the
     * benchmark builder normalizes missing -> "typescript".
     */
    engine?: BatchMinerEngine;
    rows: BatchStabilityRow[];
}

export interface BatchStabilityRow {
    asset: string;
    direction: "LONG" | "SHORT";
    hits: number;
    high: number;
    medium: number;
    low: number;
    medianRetPct: number | null;
    medianLiftPct: number | null;
    medianRr: number | null;
    medianDist: number | null;
    medianHmaxLiftPct: number | null;
    pairWarnings: number;
    /**
     * Multiplicative timing-edge score in [0, 100]. Replaces the prior
     * `hits → high → medianLift` ranking, which ranked "20 weak hits from one
     * dominant pair" above "6 strong hits from diverse pairs". Score blends
     * edge quality with cross-rerun independence so a row must earn its rank.
     */
    timingEdgeScore: number;
    /**
     * Average pairwise Jaccard distance between the agreeing-pair sets across
     * rerun hits, in [0, 1]. 0 means every hit came from the identical pair
     * set (pure repetition); 1 means no overlap between any two hits (fully
     * diverse). The dominant signal of whether "stable" is real or repeat.
     */
    medianDiversity: number;
    /**
     * The single pair that appeared in the most hits, plus its share
     * `appearances/hits` in [0, 1]. Secondary readable signal — Jaccard
     * diversity is the headline, but this answers "which pair is dragging
     * this asset over the line" in plain terms.
     */
    dominantPair: string | null;
    dominantPairShare: number;
}

export function createStabilityAggregate(
    reruns: number,
    subsetSize: number,
    seed: number,
    totalPairs: number,
    targetAssets = 0,
): BatchStabilityAccumulator {
    return {
        reruns,
        subsetSize,
        seed,
        totalPairs,
        targetAssets,
        hitEvents: 0,
        rows: new Map(),
    };
}

export function addStabilityVerdicts(
    acc: BatchStabilityAccumulator,
    verdicts: readonly BatchSyntheticAssetVerdict[]
): void {
    for (const verdict of verdicts) {
        if (verdict.verdict !== "LONG" && verdict.verdict !== "SHORT") {
            continue;
        }
        const direction = verdict.verdict;
        const key = `${verdict.asset}|${direction}`;
        let row = acc.rows.get(key);
        if (!row) {
            row = {
                asset: verdict.asset,
                direction,
                hits: 0,
                high: 0,
                medium: 0,
                low: 0,
                retPct: [],
                liftPct: [],
                rr: [],
                dist: [],
                hmaxLiftPct: [],
                pairWarnings: 0,
                agreeingSets: [],
            };
            acc.rows.set(key, row);
        }
        row.hits += 1;
        acc.hitEvents += 1;
        if (verdict.confidence === "high") row.high += 1;
        else if (verdict.confidence === "medium") row.medium += 1;
        else row.low += 1;
        pushFinite(row.retPct, verdict.evidence.expectedForwardReturnPct);
        pushFinite(row.liftPct, verdict.evidence.oosLiftPct);
        pushFinite(row.rr, computeMfeMaeRatio(verdict.evidence.expectedMfePct, verdict.evidence.expectedMaePct));
        pushFinite(row.dist, verdict.evidence.avgDistance);
        pushFinite(row.hmaxLiftPct, verdict.evidence.longestOosLiftPct);
        // Capture the agreeing-pair set per hit so finalize can compute Jaccard
        // diversity. Empty / missing agreeing lists still count as a hit but
        // contribute an empty set; pairwise Jaccard against an empty set is 1
        // by convention (handled in computeJaccardDiversity), so they don't
        // inflate diversity on rows that genuinely had no peer confirmation.
        const agreeingList = verdict.currentSnapshot?.agreeingSymbols ?? [];
        row.agreeingSets.push(agreeingList);
        row.pairWarnings += verdict.pairContributions
            .filter((entry) => entry.label === "dominating" || entry.label === "harmful" || entry.label === "opposing")
            .length;
    }
}

export function finalizeStabilityAggregate(acc: BatchStabilityAccumulator): BatchStabilityMineResult {
    const rows = Array.from(acc.rows.values())
        .map((row): BatchStabilityRow => {
            const medianDiversity = computeJaccardDiversity(row.agreeingSets);
            const dominant = computeDominantPair(row.agreeingSets);
            const base: Omit<BatchStabilityRow, "timingEdgeScore"> = {
                asset: row.asset,
                direction: row.direction,
                hits: row.hits,
                high: row.high,
                medium: row.medium,
                low: row.low,
                medianRetPct: medianOrNull(row.retPct),
                medianLiftPct: medianOrNull(row.liftPct),
                medianRr: medianOrNull(row.rr),
                medianDist: medianOrNull(row.dist),
                medianHmaxLiftPct: medianOrNull(row.hmaxLiftPct),
                pairWarnings: row.pairWarnings,
                medianDiversity,
                dominantPair: dominant.pair,
                dominantPairShare: dominant.share,
            };
            return { ...base, timingEdgeScore: computeTimingEdgeScore(base) };
        })
        // Rank by timing-edge quality first. The prior `hits → high → lift`
        // order let "20 weak hits from one dominant pair" outrank "6 strong
        // diverse hits"; score now carries that independence penalty. Ties
        // fall back to longest-horizon persistence (truly transferable edge),
        // then diversity, then raw hits as a confidence floor.
        .sort((a, b) =>
            compareNullableDesc(a.timingEdgeScore, b.timingEdgeScore)
            || compareNullableDesc(a.medianHmaxLiftPct, b.medianHmaxLiftPct)
            || compareNullableDesc(a.medianDiversity, b.medianDiversity)
            || b.hits - a.hits
            || a.asset.localeCompare(b.asset)
            || a.direction.localeCompare(b.direction)
        );
    return {
        reruns: acc.reruns,
        subsetSize: acc.subsetSize,
        seed: acc.seed,
        totalPairs: acc.totalPairs,
        targetAssets: acc.targetAssets,
        hitEvents: acc.hitEvents,
        rows,
    };
}

export function sampleItems<T>(items: readonly T[], subsetSize: number, seed: number): T[] {
    if (subsetSize >= items.length) {
        return items.slice();
    }
    const indexes = items.map((_, index) => index);
    const random = createSeededRandom(seed);
    for (let i = indexes.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j]!, indexes[i]!];
    }
    return indexes.slice(0, subsetSize).map((index) => items[index]!);
}

export function clampInt(raw: number, fallback: number, min: number, max: number): number {
    const value = Number.isFinite(raw) ? raw : fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function createSeededRandom(seed: number): () => number {
    let stateValue = seed >>> 0;
    return () => {
        stateValue += 0x6D2B79F5;
        let t = stateValue;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function computeMfeMaeRatio(mfePct: number | null, maePct: number | null): number | null {
    if (mfePct === null || maePct === null || !Number.isFinite(mfePct) || !Number.isFinite(maePct)) {
        return null;
    }
    const adverse = Math.abs(maePct);
    if (adverse <= 1e-9) return mfePct > 0 ? Number.POSITIVE_INFINITY : null;
    return mfePct / adverse;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

/**
 * Average pairwise Jaccard *distance* (1 − intersection/union) between the
 * recorded agreeing-pair sets. Returns 0 when every set is identical (pure
 * repetition — the failure mode this score exists to catch) and 1 when no
 * two sets share any pair (fully diverse confirmation across reruns).
 *
 * Convention for empty sets: the Jaccard *similarity* of (∅, ∅) is 1, so
 * their distance is 0; the similarity of (∅, non-empty) is 0, so distance
 * is 1. This means a row whose every hit genuinely had no agreeing pairs
 * scores diversity 0 (it isn't "diverse", it's empty), while a row mixing
 * empty and non-empty sets is treated as not-repeating.
 *
 * Exported for direct unit testing of the diversity math.
 */
export function computeJaccardDiversity(sets: readonly (readonly string[])[]): number {
    const valid = sets.filter((set) => Array.isArray(set) && set.length > 0);
    if (valid.length < 2) return 0;
    const normalized = valid.map((set) => new Set(set));
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        for (let j = i + 1; j < normalized.length; j += 1) {
            const a = normalized[i]!;
            const b = normalized[j]!;
            let intersection = 0;
            for (const item of a) {
                if (b.has(item)) intersection += 1;
            }
            const union = a.size + b.size - intersection;
            total += union === 0 ? 0 : 1 - intersection / union;
            pairs += 1;
        }
    }
    return pairs === 0 ? 0 : total / pairs;
}

/**
 * The single pair that appeared in the most recorded agreeing-pair sets,
 * with its share `appearances / totalHits`. TotalHits uses the original
 * set count (not the non-empty count) so the share reflects "of all hits",
 * not "of hits that had any agreeing pairs" — a row that rarely surfaces
 * agreeing pairs should not get an artificially high dominant share.
 *
 * Exported for direct unit testing.
 */
export function computeDominantPair(sets: readonly (readonly string[])[]): { pair: string | null; share: number } {
    const totalHits = sets.length;
    if (totalHits === 0) return { pair: null, share: 0 };
    const counts = new Map<string, number>();
    for (const set of sets) {
        if (!Array.isArray(set)) continue;
        for (const item of set) {
            counts.set(item, (counts.get(item) ?? 0) + 1);
        }
    }
    let bestPair: string | null = null;
    let bestCount = 0;
    for (const [pair, count] of counts) {
        if (count > bestCount) {
            bestPair = pair;
            bestCount = count;
        }
    }
    if (bestPair === null) return { pair: null, share: 0 };
    return { pair: bestPair, share: bestCount / totalHits };
}

/**
 * Multiplicative timing-edge score in [0, 100]. Mirrors the multiplicative
 * style of `computeRobustUniverseScore` (`lib/finder/finder-universe-metrics.ts`):
 * each factor ∈ [0,1] and any zero factor zeroes the score. The factors:
 *
 * - edgeQuality: OOS lift scales to a 5% reference (typical strong lift band)
 * - rrQuality: reward-only / adverse (the accumulator's rr can be +Inf when
 *   MAE is ~0; that maps to the max factor of 1, not to Infinity in the score)
 * - horizonPersist: longest-horizon OOS lift must stay positive, otherwise
 *   the short-horizon edge doesn't survive to exit scale
 * - independence: Jaccard diversity of agreeing-pair sets across reruns —
 *   the new term that punishes "the same pair repeated N times"
 * - confidenceFloor: high > medium > low verdict confidence
 * - warningPenalty: dominating/harmful/opposing pair contributions cut the
 *   score by half their hit-ratio (`1 − 0.5·(w/h)`, clamped). The independence
 *   factor is the headline guard against "same pair repeating"; PairWarn is a
 *   softer secondary caution so borderline rows (one bad pair per hit, but
 *   otherwise diverse confirmation) still surface. Ratios ≥ 2 still zero.
 *
 * Inputs `null` lift / hmax / rr (insufficient analogs) neutralize the
 * corresponding factor to 0 — those rows cannot earn a score until the
 * underlying miner produced enough evidence to populate the field.
 */
export function computeTimingEdgeScore(row: {
    hits: number;
    high: number;
    medium: number;
    low: number;
    medianLiftPct: number | null;
    medianRr: number | null;
    medianHmaxLiftPct: number | null;
    pairWarnings: number;
    medianDiversity: number;
}): number {
    if (row.hits <= 0) return 0;
    const lift = row.medianLiftPct;
    const hmax = row.medianHmaxLiftPct;
    const rr = row.medianRr;
    if (lift === null || hmax === null || rr === null) return 0;

    const edgeQuality = clamp01(lift / 5);
    const rrQuality = Number.isFinite(rr) ? clamp01((rr - 1) / 2) : 1;
    const horizonPersist = hmax > 0 ? 1 : 0;
    const independence = clamp01(row.medianDiversity);
    const confidenceFloor = clamp01((row.high + row.medium * 0.6 + row.low * 0.3) / row.hits);
    // Softened from `1 − w/h` (which zeroed any row where warnings ≥ hits,
    // regardless of whether the agreeing pairs were otherwise diverse). The
    // Jaccard `independence` factor already punishes "same pair repeating";
    // PairWarn shouldn't have absolute veto on top of it. `1 − 0.5·(w/h)` keeps
    // 50% of the score at ratio 1.0 (borderline rows like UNI surface with a
    // quality caution), while genuine offenders (BCH ratio 3.0, TAO 3.67)
    // still clamp to 0 because 0.5·3 = 1.5 saturates the clamp.
    const warningPenalty = 1 - clamp01(0.5 * row.pairWarnings / row.hits);

    return Math.round(100 * edgeQuality * rrQuality * horizonPersist * independence * confidenceFloor * warningPenalty);
}

function pushFinite(values: number[], value: number | null | undefined): void {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
        values.push(value);
    }
}

function medianOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function compareNullableDesc(left: number | null, right: number | null): number {
    const l = left ?? Number.NEGATIVE_INFINITY;
    const r = right ?? Number.NEGATIVE_INFINITY;
    return r - l;
}
