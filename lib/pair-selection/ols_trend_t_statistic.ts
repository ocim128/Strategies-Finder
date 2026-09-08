import type { PairSelectionRule } from "./types";

export const ols_trend_t_statistic: PairSelectionRule = {
    key: "ols_trend_t_statistic",
    name: "OLS Trend T-Statistic",
    description: "Ranks direction-aligned 48-bar OLS slope by return-volatility noise.",
    defaultParams: { noiseFloor: 0.005 },
    paramLabels: { noiseFloor: "Floor added to return standard deviation to stabilize division" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_volatility_return_std_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/ols_trend_t_statistic.ts"],
    },
    score: (candidate, _event, params) => {
        const slope = candidate.feat_fp_spread_ols_slope_b48_r2;
        const vol = candidate.feat_fp_volatility_return_std_b48_r1;
        if (slope === null || vol === null || vol <= 0) return Number.NEGATIVE_INFINITY;
        const dirSlope = candidate.direction === "long" ? slope : -slope;
        return dirSlope / (vol + params.noiseFloor!);
    },
};
