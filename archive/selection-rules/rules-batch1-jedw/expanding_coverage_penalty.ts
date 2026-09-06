import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const expanding_coverage_penalty: SelectionRule = {
    key: "expanding_coverage_penalty",
    name: "Expanding Coverage Penalty",
    description:
        "Ranks positive candidates by signedVotes / activePairCount and demotes candidates with priorCoverageSlope5 at or above maxExpansionSlope by 100x. Null priorCoverageSlope5 is not demoted; non-positive votes or active pairs are ineligible.",
    defaultParams: { maxExpansionSlope: 0.3 },
    paramLabels: { maxExpansionSlope: "Maximum coverage expansion slope" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.priorCoverageSlope5 !== null
            && candidate.priorCoverageSlope5 >= params.maxExpansionSlope!
            ? baseScore * DEMOTION_FACTOR
            : baseScore;
    },
};
