import type { PairSelectionRule } from "./types";

export const structured_predictable_volatility: PairSelectionRule = {
    key: "structured_predictable_volatility",
    name: "Structured Predictable Volatility",
    description: "Scales signal ATR percentage by 48-bar AR(1) R-squared.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_dependence_ar1_r_squared_b48_r1"] },
        sourceFiles: ["lib/pair-selection/structured_predictable_volatility.ts"],
    },
    score: (candidate) => {
        const atr = candidate.feat_atrPct;
        const r2 = candidate.feat_fp_dependence_ar1_r_squared_b48_r1;
        if (atr === null || r2 === null || atr <= 0 || r2 < 0) return Number.NEGATIVE_INFINITY;
        return atr * r2;
    },
};
