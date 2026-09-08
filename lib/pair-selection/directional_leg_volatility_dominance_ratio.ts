import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithLegAtr = PairCandidate & {
    feat_base_atrPct?: number | null;
    feat_quote_atrPct?: number | null;
};

export const directional_leg_volatility_dominance_ratio: PairSelectionRule = {
    key: "directional_leg_volatility_dominance_ratio",
    name: "Directional Leg Volatility Dominance Ratio",
    description: "Ranks the volatility ratio of the bought leg to the sold leg.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/directional_leg_volatility_dominance_ratio.ts"],
    },
    score: (candidate) => {
        const withLegAtr = candidate as CandidateWithLegAtr;
        const baseAtr = withLegAtr.feat_base_atrPct ?? null;
        const quoteAtr = withLegAtr.feat_quote_atrPct ?? null;
        if (baseAtr === null || quoteAtr === null || quoteAtr <= 0 || baseAtr <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? baseAtr / quoteAtr : quoteAtr / baseAtr;
    },
};
