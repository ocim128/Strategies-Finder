import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithLegReturns = PairCandidate & {
    feat_base_return20?: number | null;
    feat_quote_return20?: number | null;
};

export const divergent_leg_momentum_concordance: PairSelectionRule = {
    key: "divergent_leg_momentum_concordance",
    name: "Divergent Leg Momentum Concordance",
    description: "Combines direction-aligned leg divergence with an opposite-momentum cross-product bonus.",
    defaultParams: { crossProductBonusWeight: 1.0 },
    paramLabels: { crossProductBonusWeight: "Weight on the opposite-leg momentum cross-product bonus" },
    metadata: {
        sourceFiles: ["lib/pair-selection/divergent_leg_momentum_concordance.ts"],
    },
    score: (candidate, _event, params) => {
        const withLegReturns = candidate as CandidateWithLegReturns;
        const baseRet20 = withLegReturns.feat_base_return20 ?? null;
        const quoteRet20 = withLegReturns.feat_quote_return20 ?? null;
        if (baseRet20 === null || quoteRet20 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (baseRet20 - quoteRet20)
            + params.crossProductBonusWeight! * (baseRet20 * -quoteRet20);
    },
};
