import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface HorizonPair {
    fast: number;
    slow: number;
}

function rankValues(values: readonly number[]): number[] {
    const ranked = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
    const ranks = new Array<number>(values.length);
    let start = 0;
    while (start < ranked.length) {
        let end = start + 1;
        while (end < ranked.length && ranked[end]!.value === ranked[start]!.value) end += 1;
        const rank = (start + end + 1) / 2;
        for (let index = start; index < end; index += 1) ranks[ranked[index]!.index] = rank;
        start = end;
    }
    return ranks;
}

function spearmanAbsoluteCorrelation(pool: readonly PairCandidate[]): number {
    const values = pool
        .map((entry): HorizonPair | null => {
            const fast = directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1);
            const slow = directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1);
            return fast === null || slow === null ? null : { fast, slow };
        })
        .filter((value): value is HorizonPair => value !== null);
    if (values.length < 2) return 0;
    const fastRanks = rankValues(values.map((value) => value.fast));
    const slowRanks = rankValues(values.map((value) => value.slow));
    const fastMean = fastRanks.reduce((sum, value) => sum + value, 0) / fastRanks.length;
    const slowMean = slowRanks.reduce((sum, value) => sum + value, 0) / slowRanks.length;
    let numerator = 0;
    let fastVariance = 0;
    let slowVariance = 0;
    for (let index = 0; index < fastRanks.length; index += 1) {
        const fastDelta = fastRanks[index]! - fastMean;
        const slowDelta = slowRanks[index]! - slowMean;
        numerator += fastDelta * slowDelta;
        fastVariance += fastDelta ** 2;
        slowVariance += slowDelta ** 2;
    }
    if (fastVariance === 0 || slowVariance === 0) return 0;
    return Math.abs(numerator / Math.sqrt(fastVariance * slowVariance));
}

export const market_coherence_regime_switch: PairSelectionRule = {
    key: "market_coherence_regime_switch",
    name: "Market Coherence Regime Switch",
    description: "Uses momentum when event fast/slow returns have sufficient absolute Spearman coherence and ATR otherwise.",
    defaultParams: { minCoherence: 0.3 },
    paramLabels: { minCoherence: "Minimum absolute fast/slow event rank correlation" },
    normalizeParams: (params) => ({
        ...params,
        minCoherence: Math.min(1, Math.max(0, params.minCoherence!)),
    }),
    metadata: {
        paramBounds: { minCoherence: { min: 0, max: 1, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b240_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/market_coherence_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const coherence = memoByPool(pool, "market-coherence-regime-switch-correlation", () =>
            spearmanAbsoluteCorrelation(pool));
        if (coherence >= params.minCoherence!) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
