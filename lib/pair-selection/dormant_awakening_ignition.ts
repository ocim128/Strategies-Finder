import type { PairSelectionRule } from "./types";

export const dormant_awakening_ignition: PairSelectionRule = {
    key: "dormant_awakening_ignition",
    name: "Dormant Awakening Ignition",
    description: "Scales signal ATR percentage by logarithmic bars since the prior pair fire.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/dormant_awakening_ignition.ts"],
    },
    score: (candidate) => {
        const bars = candidate.feat_barsSincePairLastFire;
        const atr = candidate.feat_atrPct;
        if (bars === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return Math.log1p(bars) * atr;
    },
};
