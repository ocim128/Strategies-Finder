import type { PairSelectionRule } from "./types";

export const consecutive_fire_reinforcement: PairSelectionRule = {
    key: "consecutive_fire_reinforcement",
    name: "Consecutive Fire Reinforcement",
    description: "Doubles signal ATR scoring for immediate back-to-back fires.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/consecutive_fire_reinforcement.ts"],
    },
    score: (candidate) => {
        const bars = candidate.feat_barsSincePairLastFire;
        const atr = candidate.feat_atrPct;
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return (bars === 1 ? 2.0 : 1.0) * atr;
    },
};
