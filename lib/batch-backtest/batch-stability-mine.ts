import type { BatchSyntheticAssetVerdict } from "./batch-synthetic-state-miner";

export interface BatchStabilityAccumulator {
    reruns: number;
    subsetSize: number;
    seed: number;
    totalPairs: number;
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
}

export interface BatchStabilityMineResult {
    reruns: number;
    subsetSize: number;
    seed: number;
    totalPairs: number;
    hitEvents: number;
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
}

export function createStabilityAggregate(
    reruns: number,
    subsetSize: number,
    seed: number,
    totalPairs: number
): BatchStabilityAccumulator {
    return {
        reruns,
        subsetSize,
        seed,
        totalPairs,
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
        row.pairWarnings += verdict.pairContributions
            .filter((entry) => entry.label === "dominating" || entry.label === "harmful" || entry.label === "opposing")
            .length;
    }
}

export function finalizeStabilityAggregate(acc: BatchStabilityAccumulator): BatchStabilityMineResult {
    const rows = Array.from(acc.rows.values())
        .map((row): BatchStabilityRow => ({
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
        }))
        .sort((a, b) =>
            b.hits - a.hits
            || b.high - a.high
            || compareNullableDesc(a.medianLiftPct, b.medianLiftPct)
            || a.asset.localeCompare(b.asset)
            || a.direction.localeCompare(b.direction)
        );
    return {
        reruns: acc.reruns,
        subsetSize: acc.subsetSize,
        seed: acc.seed,
        totalPairs: acc.totalPairs,
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
