import type { PairSelectionRule } from "./types";

export const volatility_impulse_scaled_momentum: PairSelectionRule = {
    key: "volatility_impulse_scaled_momentum",
    name: "Volatility Impulse Scaled Momentum",
    description: "Scales direction-aligned 48-bar return by short-to-secular volatility expansion.",
    defaultParams: { volatilityImpulseExponent: 1.0 },
    paramLabels: { volatilityImpulseExponent: "Exponent applied to the 12-over-240 bar volatility ratio" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_volatility_std_ratio_b12_over_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/volatility_impulse_scaled_momentum.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const volatilityRatio = candidate.feat_fp_volatility_std_ratio_b12_over_b240_r1;
        if (ret48 === null || volatilityRatio === null || volatilityRatio <= 0) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 * Math.pow(volatilityRatio, params.volatilityImpulseExponent!);
    },
};
