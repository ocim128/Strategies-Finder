import type { SelectionRule } from "./types";

function maximumActivePairCount(pool: readonly { activePairCount: number }[]): number {
    return Math.max(...pool.map((candidate) => candidate.activePairCount));
}

export const thin_coverage_deficit_product: SelectionRule = {
    key: "thin_coverage_deficit_product",
    name: "Thin Coverage Deficit Product",
    description:
        "Multiplies positive candidates' signedVotes by the coverage deficit from the event maximum, raised to deficitExponent. The deficit is floored at one; non-positive signedVotes are ineligible.",
    defaultParams: { deficitExponent: 1.0 },
    paramLabels: { deficitExponent: "Coverage deficit exponent" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const maxPairs = maximumActivePairCount(pool);
        const coverageDeficit = Math.max(1, maxPairs - candidate.activePairCount + 1);
        return candidate.signedVotes * Math.pow(coverageDeficit, params.deficitExponent!);
    },
};
