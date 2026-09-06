import type { SelectionRule } from "./types";

export const coverage_contraction_vote_velocity: SelectionRule = {
    key: "coverage_contraction_vote_velocity",
    name: "Coverage Contraction Vote Velocity",
    description:
        "Ranks candidates by priorSignedVoteDelta3 minus slopeWeight times priorCoverageSlope5, combining vote acceleration with coverage contraction. Null vote delta and coverage slope are both treated as zero.",
    defaultParams: { slopeWeight: 2.0 },
    paramLabels: { slopeWeight: "Coverage-slope weight" },
    score(candidate, _event, params) {
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        const slope = candidate.priorCoverageSlope5 === null ? 0 : candidate.priorCoverageSlope5;
        return delta - params.slopeWeight! * slope;
    },
};
