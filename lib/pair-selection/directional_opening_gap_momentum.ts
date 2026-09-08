import type { PairSelectionRule } from "./types";

export const directional_opening_gap_momentum: PairSelectionRule = {
    key: "directional_opening_gap_momentum",
    name: "Directional Opening Gap Momentum",
    description: "Ranks direction-aligned opening gap percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/directional_opening_gap_momentum.ts"],
    },
    score: (candidate) => {
        const gap = candidate.feat_gapPct;
        if (gap === null || !Number.isFinite(gap)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? gap : -gap;
    },
};
