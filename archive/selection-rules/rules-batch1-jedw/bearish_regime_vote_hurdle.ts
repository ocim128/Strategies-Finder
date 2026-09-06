import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const bearish_regime_vote_hurdle: SelectionRule = {
    key: "bearish_regime_vote_hurdle",
    name: "Bearish Regime Vote Hurdle",
    description:
        "Ranks positive candidates by signedVotes / activePairCount, but demotes candidates with signedVotes below minBearishVotes by 100x during bearish regimes. Bullish and unavailable regimes are unchanged; non-positive votes or active pairs are ineligible.",
    defaultParams: { minBearishVotes: 20.0 },
    paramLabels: { minBearishVotes: "Minimum bearish-regime votes" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.regime === "bearish" && candidate.signedVotes < params.minBearishVotes!
            ? baseScore * DEMOTION_FACTOR
            : baseScore;
    },
};
