import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithFireCount = PairCandidate & {
    feat_pairFiresInLast20Bars?: number | null;
};

export const virgin_signal_regime_ignition: PairSelectionRule = {
    key: "virgin_signal_regime_ignition",
    name: "Virgin Signal Regime Ignition",
    description: "Ranks ATR after penalizing recent pair signal churn.",
    defaultParams: { churnPenalty: 0.5 },
    paramLabels: { churnPenalty: "Penalty weight applied per preceding pair signal in the last 20 bars" },
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_pairFiresInLast20Bars"] },
        sourceFiles: ["lib/pair-selection/virgin_signal_regime_ignition.ts"],
    },
    score: (candidate, _event, params) => {
        const atr = candidate.feat_atrPct;
        const churn = (candidate as CandidateWithFireCount).feat_pairFiresInLast20Bars;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr / (1 + (churn ?? 0) * params.churnPenalty!);
    },
};
