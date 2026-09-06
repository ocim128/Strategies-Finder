import type { SelectionRule } from "./types";

export const coverage_contraction_tilt: SelectionRule = {
    key: "coverage_contraction_tilt",
    name: "Coverage Contraction Tilt",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, tilted by priorCoverageSlope5: negative coverage slope is rewarded and positive slope penalized. A null priorCoverageSlope5 receives a neutral multiplier; non-positive votes or active pairs are ineligible.",
    defaultParams: { contractionTilt: 0.4 },
    paramLabels: { contractionTilt: "Coverage contraction tilt" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        const slope = candidate.priorCoverageSlope5;
        if (slope === null) return baseScore;
        return baseScore * Math.max(0.1, 1 - params.contractionTilt! * slope);
    },
};
