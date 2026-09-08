import type { PairSelectionRule } from "./types";

export const extreme_tail_jump_ratio: PairSelectionRule = {
    key: "extreme_tail_jump_ratio",
    name: "Extreme Tail Jump Ratio",
    description: "Ranks signal ATR relative to preceding 48-bar return volatility.",
    defaultParams: { volFloor: 0.005 },
    paramLabels: { volFloor: "Floor added to 48-bar return volatility to prevent division by near-zero" },
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_volatility_return_std_b48_r1"] },
        sourceFiles: ["lib/pair-selection/extreme_tail_jump_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const atr = candidate.feat_atrPct;
        const vol = candidate.feat_fp_volatility_return_std_b48_r1;
        if (atr === null || vol === null || vol <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (vol + params.volFloor!);
    },
};
