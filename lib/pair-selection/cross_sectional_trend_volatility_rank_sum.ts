import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface TrendVolatilityRanks {
    slope: readonly number[];
    atr: readonly number[];
}

function percentileRank(values: readonly number[], value: number): number {
    if (values.length === 0) return Number.NaN;
    if (values.length === 1) return 0.5;
    let less = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry < value) less += 1;
        else if (entry === value) equal += 1;
    }
    return (less + (equal - 1) / 2) / (values.length - 1);
}

export const cross_sectional_trend_volatility_rank_sum: PairSelectionRule = {
    key: "cross_sectional_trend_volatility_rank_sum",
    name: "Cross-Sectional Trend Volatility Rank Sum",
    description: "Ranks the sum of event-level directional drift and ATR percentiles.",
    defaultParams: { volatilityRankWeight: 1.0 },
    paramLabels: { volatilityRankWeight: "Weight on ATR percentile rank relative to directional drift rank" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_ols_slope_b48_r2"],
        },
        sourceFiles: [
            "lib/pair-selection/cross_sectional_trend_volatility_rank_sum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ranks = memoByPool(pool, "cross-sectional-trend-volatility-ranks", (): TrendVolatilityRanks => ({
            slope: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2))
                .filter((value): value is number => value !== null),
            atr: pool
                .map((entry) => entry.feat_atrPct)
                .filter((value): value is number => value !== null && Number.isFinite(value)),
        }));
        const slope = directionAdjusted(candidate, candidate.feat_fp_spread_ols_slope_b48_r2);
        const atr = candidate.feat_atrPct;
        if (slope === null || atr === null) return Number.NEGATIVE_INFINITY;
        return percentileRank(ranks.slope, slope) + params.volatilityRankWeight! * percentileRank(ranks.atr, atr);
    },
};
