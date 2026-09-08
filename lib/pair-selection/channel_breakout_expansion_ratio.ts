import type { PairSelectionRule } from "./types";

export const channel_breakout_expansion_ratio: PairSelectionRule = {
    key: "channel_breakout_expansion_ratio",
    name: "Channel Breakout Expansion Ratio",
    description: "Ranks signal ATR relative to the preceding 48-bar channel width.",
    defaultParams: { floor: 0.005 },
    paramLabels: { floor: "Floor added to 48-bar total channel range to stabilize division against near-zero values" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_distance_below_max_b48_r1",
                "feat_fp_spread_distance_above_min_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/channel_breakout_expansion_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const belowMax = candidate.feat_fp_spread_distance_below_max_b48_r1;
        const aboveMin = candidate.feat_fp_spread_distance_above_min_b48_r1;
        const atr = candidate.feat_atrPct;
        if (belowMax === null || aboveMin === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (belowMax + aboveMin + params.floor!);
    },
};
