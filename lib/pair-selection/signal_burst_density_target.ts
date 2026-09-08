import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithFireCount = PairCandidate & {
    feat_pairFiresInLast20Bars?: number | null;
};

export const signal_burst_density_target: PairSelectionRule = {
    key: "signal_burst_density_target",
    name: "SIGNAL_BURST_DENSITY_TARGET",
    description: "Targets a chosen count of prior pair signals in the last twenty bars.",
    defaultParams: { targetFireCount: 3 },
    paramLabels: { targetFireCount: "Target prior fire count" },
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_pairFiresInLast20Bars"] },
        sourceFiles: ["lib/pair-selection/signal_burst_density_target.ts"],
    },
    score: (candidate, _event, params) => {
        const fireCount = (candidate as CandidateWithFireCount).feat_pairFiresInLast20Bars ?? null;
        if (fireCount === null || !Number.isFinite(fireCount)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(fireCount - params.targetFireCount!);
    },
};
