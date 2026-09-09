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

export const broad_theme_confirmed_drift: PairSelectionRule = {
    key: "broad_theme_confirmed_drift",
    name: "Broad Theme Confirmed Drift",
    description: "Weights directional spread drift by same-sign leave-one-out base and quote cohort environments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/broad_theme_confirmed_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const alignments = memoByPool(pool, "broad-theme-confirmed-drift-alignments", () => buildAlignments(pool));
        const alignment = alignments.get(candidate);
        if (!alignment) return Number.NEGATIVE_INFINITY;
        const weight = sign(alignment.base) * sign(alignment.quote);
        return weight === 0 ? Number.NEGATIVE_INFINITY : return48 * weight;
    },
};
