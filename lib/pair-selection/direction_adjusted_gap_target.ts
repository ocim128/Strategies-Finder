import type { PairSelectionRule } from "./types";

export const direction_adjusted_gap_target: PairSelectionRule = {
    key: "direction_adjusted_gap_target",
    name: "DIRECTION_ADJUSTED_GAP_TARGET",
    description: "Targets a direction-adjusted signal-bar opening gap.",
    defaultParams: { targetDirectionalGapPct: 0 },
    paramLabels: { targetDirectionalGapPct: "Target directional gap (%)" },
    score: (candidate, _event, params) => {
        const gap = candidate.feat_gapPct;
        if (gap === null || (candidate.direction !== "long" && candidate.direction !== "short")) {
            return Number.NEGATIVE_INFINITY;
        }
        const directionalGap = candidate.direction === "long" ? gap : -gap;
        return -Math.abs(directionalGap - params.targetDirectionalGapPct!);
    },
};
