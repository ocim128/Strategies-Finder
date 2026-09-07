import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithDrawdown = PairCandidate & {
    feat_pairDrawdownPctPrior?: number | null;
};

export const pair_drawdown_recovery_target: PairSelectionRule = {
    key: "pair_drawdown_recovery_target",
    name: "PAIR_DRAWDOWN_RECOVERY_TARGET",
    description: "Targets a chosen prior cumulative pair-equity drawdown percentage.",
    defaultParams: { targetDrawdownPct: 10 },
    paramLabels: { targetDrawdownPct: "Target drawdown (%)" },
    score: (candidate, _event, params) => {
        const drawdown = (candidate as CandidateWithDrawdown).feat_pairDrawdownPctPrior ?? null;
        if (drawdown === null || !Number.isFinite(drawdown)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(drawdown - params.targetDrawdownPct!);
    },
};
