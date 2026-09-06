import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

function medianActivePairCount(pool: readonly { activePairCount: number }[]): number {
    const counts = pool.map((candidate) => candidate.activePairCount).sort((left, right) => left - right);
    const middle = counts.length >> 1;
    return counts.length % 2 === 1
        ? counts[middle]!
        : (counts[middle - 1]! + counts[middle]!) / 2;
}

export const thin_coverage_exclusive_cap: SelectionRule = {
    key: "thin_coverage_exclusive_cap",
    name: "Thin Coverage Exclusive Cap",
    description:
        "Computes the event median activePairCount across positive candidates. Selects by signedVotes inside the coverageCeilingRatio x median thin-coverage band and demotes candidates above the cap by 100x; non-positive signedVotes are ineligible.",
    defaultParams: { coverageCeilingRatio: 0.9 },
    paramLabels: { coverageCeilingRatio: "Coverage ceiling (x event median pairs)" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const medianPairs = medianActivePairCount(pool);
        return candidate.activePairCount <= params.coverageCeilingRatio! * medianPairs
            ? candidate.signedVotes
            : candidate.signedVotes * DEMOTION_FACTOR;
    },
};
