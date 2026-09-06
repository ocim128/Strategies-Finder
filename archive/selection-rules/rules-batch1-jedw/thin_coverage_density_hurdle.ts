import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

function medianActivePairCount(pool: readonly { activePairCount: number }[]): number {
    const counts = pool.map((candidate) => candidate.activePairCount).sort((left, right) => left - right);
    const middle = counts.length >> 1;
    return counts.length % 2 === 1
        ? counts[middle]!
        : (counts[middle - 1]! + counts[middle]!) / 2;
}

export const thin_coverage_density_hurdle: SelectionRule = {
    key: "thin_coverage_density_hurdle",
    name: "Thin Coverage Density Hurdle",
    description:
        "Computes the event median activePairCount across positive candidates. Below-median coverage candidates compete on signedVotes only when score clears minThinDensity; otherwise they are demoted by 100x, while candidates at or above the median compete on signedVotes. Non-positive votes are ineligible.",
    defaultParams: { minThinDensity: 0.35 },
    paramLabels: { minThinDensity: "Minimum thin-coverage density" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const medianPairs = medianActivePairCount(pool);
        if (candidate.activePairCount >= medianPairs) return candidate.signedVotes;
        return candidate.score !== null && candidate.score >= params.minThinDensity!
            ? candidate.signedVotes
            : candidate.signedVotes * DEMOTION_FACTOR;
    },
};
