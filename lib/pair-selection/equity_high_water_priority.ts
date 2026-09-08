import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithDrawdown = PairCandidate & {
    feat_pairDrawdownPctPrior?: number | null;
};

export const equity_high_water_priority: PairSelectionRule = {
    key: "equity_high_water_priority",
    name: "Equity High Water Priority",
    description: "Weights signal ATR by whether prior pair drawdown is exactly zero.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_pairDrawdownPctPrior"] },
        sourceFiles: ["lib/pair-selection/equity_high_water_priority.ts"],
    },
    score: (candidate) => {
        const dd = (candidate as CandidateWithDrawdown).feat_pairDrawdownPctPrior;
        const atr = candidate.feat_atrPct;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return (dd === 0 ? 1 : 0.1) * atr;
    },
};
