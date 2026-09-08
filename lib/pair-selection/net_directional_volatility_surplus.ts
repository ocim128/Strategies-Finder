import type { PairSelectionRule } from "./types";

export const net_directional_volatility_surplus: PairSelectionRule = {
    key: "net_directional_volatility_surplus",
    name: "Net Directional Volatility Surplus",
    description: "Ranks favorable minus adverse 48-bar directional volatility.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_volatility_upside_rms_b48_r1",
                "feat_fp_volatility_downside_rms_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/net_directional_volatility_surplus.ts"],
    },
    score: (candidate) => {
        const up = candidate.feat_fp_volatility_upside_rms_b48_r1;
        const down = candidate.feat_fp_volatility_downside_rms_b48_r1;
        if (up === null || down === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? up - down : down - up;
    },
};
