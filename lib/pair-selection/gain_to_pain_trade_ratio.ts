import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithDrawdown = PairCandidate & {
    feat_pairDrawdownPctPrior?: number | null;
};

export const gain_to_pain_trade_ratio: PairSelectionRule = {
    key: "gain_to_pain_trade_ratio",
    name: "Gain to Pain Trade Ratio",
    description: "Divides rolling 8-trade mean net return by prior cumulative pair drawdown.",
    defaultParams: { drawdownPenalty: 0.1 },
    paramLabels: { drawdownPenalty: "Penalty weight applied per percentage point of historical equity drawdown" },
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_trade_mean_net_pct_t8_r1", "feat_fp_trade_mean_net_pct_t8_r1_n", "feat_pairDrawdownPctPrior"] },
        sourceFiles: ["lib/pair-selection/gain_to_pain_trade_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const pnl = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const n = candidate.feat_fp_trade_mean_net_pct_t8_r1_n;
        const dd = (candidate as CandidateWithDrawdown).feat_pairDrawdownPctPrior;
        if (pnl === null || n === null || n < 4) return Number.NEGATIVE_INFINITY;
        return pnl / (1 + (dd ?? 0) * params.drawdownPenalty!);
    },
};
