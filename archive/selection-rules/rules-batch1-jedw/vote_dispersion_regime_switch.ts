import type { SelectionRule } from "./types";

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export const vote_dispersion_regime_switch: SelectionRule = {
    key: "vote_dispersion_regime_switch",
    name: "Vote Dispersion Regime Switch",
    description:
        "Computes the pool maximum-to-median signed vote dispersion ratio. High-dispersion events use raw signedVotes; lower-dispersion events use signedVotes / activePairCount. The median denominator is floored at one; non-positive votes or active pairs are ineligible.",
    defaultParams: { dispersionThreshold: 2.0 },
    paramLabels: { dispersionThreshold: "Vote dispersion threshold" },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const votes = pool.map((entry) => entry.signedVotes);
        const medianVotes = median(votes);
        const maxVotes = Math.max(...votes);
        const dispersionRatio = maxVotes / Math.max(1, medianVotes);
        return dispersionRatio >= params.dispersionThreshold!
            ? candidate.signedVotes
            : candidate.signedVotes / candidate.activePairCount;
    },
};
