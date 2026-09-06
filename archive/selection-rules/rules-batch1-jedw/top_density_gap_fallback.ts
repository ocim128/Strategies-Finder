import type { SelectionRule } from "./types";

export const top_density_gap_fallback: SelectionRule = {
    key: "top_density_gap_fallback",
    name: "Top Density Gap Fallback",
    description:
        "Uses signedVotes / activePairCount when the gap between the two highest positive-pool densities reaches minDensityGap; otherwise falls back to signedVotes. A pool with fewer than two valid densities uses a gap of 1.0; non-positive votes or active pairs are ineligible.",
    defaultParams: { minDensityGap: 0.05 },
    paramLabels: { minDensityGap: "Minimum top-density gap" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const sortedByDensity = pool
            .filter((entry) => entry.signedVotes > 0 && entry.activePairCount > 0)
            .map((entry) => entry.signedVotes / entry.activePairCount)
            .sort((left, right) => right - left);
        const densityGap = sortedByDensity.length >= 2
            ? sortedByDensity[0]! - sortedByDensity[1]!
            : 1;
        return densityGap >= params.minDensityGap!
            ? candidate.signedVotes / candidate.activePairCount
            : candidate.signedVotes;
    },
};
