import type { SelectionRule } from "./types";

export const coverage_rank_discount: SelectionRule = {
    key: "coverage_rank_discount",
    name: "Coverage Rank Discount",
    description:
        "Sorts positive pool candidates by activePairCount ascending, breaking equal-count ranks by asset name, and discounts signedVotes by maxRankDiscount times the candidate's 1-based coverage rank divided by pool length. Non-positive signedVotes are ineligible.",
    defaultParams: { maxRankDiscount: 0.4 },
    paramLabels: { maxRankDiscount: "Maximum coverage-rank discount" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const sortedCandidates = pool
            .filter((entry) => entry.signedVotes > 0)
            .sort((left, right) =>
                left.activePairCount - right.activePairCount
                || left.asset.localeCompare(right.asset));
        const coverageRank = sortedCandidates.findIndex((entry) => entry.asset === candidate.asset) + 1;
        const rankPercentile = coverageRank / pool.length;
        return candidate.signedVotes * (1 - params.maxRankDiscount! * rankPercentile);
    },
};
