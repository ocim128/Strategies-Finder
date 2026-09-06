import type { SelectionRule } from "./types";

export const zero_variance_plateau_discount: SelectionRule = {
    key: "zero_variance_plateau_discount",
    name: "Zero Variance Plateau Discount",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, discounting candidates whose priorScoreStdDev5 is exactly zero by zeroVarianceDiscount. Null priorScoreStdDev5 receives no discount; non-positive votes or active pairs are ineligible.",
    defaultParams: { zeroVarianceDiscount: 0.3 },
    paramLabels: { zeroVarianceDiscount: "Zero-variance discount" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.priorScoreStdDev5 !== null && candidate.priorScoreStdDev5 === 0
            ? baseScore * (1 - params.zeroVarianceDiscount!)
            : baseScore;
    },
};
