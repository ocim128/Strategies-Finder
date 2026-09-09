import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface CohortEntry {
    candidate: PairCandidate;
    value: number;
}

interface CohortSeries {
    entries: readonly CohortEntry[];
    indexByCandidate: ReadonlyMap<PairCandidate, number>;
}

interface CohortAlignment {
    base: number | null;
    quote: number | null;
}

function buildSeries(pool: readonly PairCandidate[], read: (candidate: PairCandidate) => string): ReadonlyMap<string, CohortSeries> {
    const grouped = new Map<string, CohortEntry[]>();
    for (const candidate of pool) {
        const value = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (value === null) continue;
        const key = read(candidate);
        const entries = grouped.get(key) ?? [];
        entries.push({ candidate, value });
        grouped.set(key, entries);
    }
    const series = new Map<string, CohortSeries>();
    for (const [key, entries] of grouped) {
        const sorted = [...entries].sort((left, right) => left.value - right.value);
        series.set(key, {
            entries: sorted,
            indexByCandidate: new Map(sorted.map((entry, index) => [entry.candidate, index] as const)),
        });
    }
    return series;
}

function medianWithout(series: CohortSeries | undefined, candidate: PairCandidate): number | null {
    if (!series) return null;
    const removed = series.indexByCandidate.get(candidate);
    if (removed === undefined) return median(series.entries.map((entry) => entry.value));
    const remaining = series.entries.length - 1;
    if (remaining <= 0) return null;
    const valueAt = (index: number): number => series.entries[index >= removed ? index + 1 : index]!.value;
    const middle = remaining >> 1;
    return remaining % 2 === 1
        ? valueAt(middle)
        : (valueAt(middle - 1) + valueAt(middle)) / 2;
}

function buildAlignments(pool: readonly PairCandidate[]): ReadonlyMap<PairCandidate, CohortAlignment> {
    const base = buildSeries(pool, (candidate) => candidate.baseSymbol);
    const quote = buildSeries(pool, (candidate) => candidate.quoteSymbol);
    return new Map(pool.map((candidate) => [candidate, {
        base: medianWithout(base.get(candidate.baseSymbol), candidate),
        quote: medianWithout(quote.get(candidate.quoteSymbol), candidate),
    }] as const));
}

function sign(value: number | null): -1 | 0 | 1 {
    if (value === null || value === 0) return 0;
    return value < 0 ? -1 : 1;
}

function alignmentFraction(pool: readonly PairCandidate[]): number {
    if (pool.length === 0) return 0;
    const alignments = buildAlignments(pool);
    let agreeing = 0;
    for (const alignment of alignments.values()) {
        const baseSign = sign(alignment.base);
        const quoteSign = sign(alignment.quote);
        if (baseSign !== 0 && baseSign === quoteSign) agreeing += 1;
    }
    return agreeing / pool.length;
}

export const cohort_alignment_regime_switch: PairSelectionRule = {
    key: "cohort_alignment_regime_switch",
    name: "Cohort Alignment Regime Switch",
    description: "Uses momentum in aligned cohort environments and ATR in cross-currents events.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cohort_alignment_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const aligned = memoByPool(pool, "cohort-alignment-regime-switch-fraction", () => alignmentFraction(pool)) >= 0.5;
        if (aligned) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
