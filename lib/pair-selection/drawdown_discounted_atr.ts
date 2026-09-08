import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithDrawdown = PairCandidate & {
    feat_pairDrawdownPctPrior?: number | null;
};

export const drawdown_discounted_atr: PairSelectionRule = {
    key: "drawdown_discounted_atr",
    name: "Drawdown Discounted ATR",
    description: "Discounts pair ATR percentage by prior cumulative pair-equity drawdown.",
    defaultParams: { drawdownPenalty: 0.05 },
    paramLabels: { drawdownPenalty: "Penalty multiplier per percentage point of prior pair equity drawdown" },
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_pairDrawdownPctPrior"] },
        sourceFiles: ["lib/pair-selection/drawdown_discounted_atr.ts"],
    },
    score: (candidate, _event, params) => {
        const atr = candidate.feat_atrPct;
        const dd = (candidate as CandidateWithDrawdown).feat_pairDrawdownPctPrior;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (1 + (dd ?? 0) * params.drawdownPenalty!);
    },
};
