import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithMae = PairCandidate & {
    feat_pairMedianMaePctPrior?: number | null;
};

export const trade_expectancy_to_mae_efficiency: PairSelectionRule = {
    key: "trade_expectancy_to_mae_efficiency",
    name: "Trade Expectancy to MAE Efficiency",
    description: "Ranks rolling mean net return per historical median maximum adverse excursion.",
    defaultParams: { maeFloor: 0.5 },
    paramLabels: { maeFloor: "Floor in percentage points added to median MAE" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_trade_mean_net_pct_t8_r1",
                "feat_fp_trade_mean_net_pct_t8_r1_n",
                "feat_pairMedianMaePctPrior",
            ],
        },
        sourceFiles: ["lib/pair-selection/trade_expectancy_to_mae_efficiency.ts"],
    },
    score: (candidate, _event, params) => {
        const pnl = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const n = candidate.feat_fp_trade_mean_net_pct_t8_r1_n;
        const mae = (candidate as CandidateWithMae).feat_pairMedianMaePctPrior;
        if (pnl === null || n === null || n < 4 || mae === null || mae === undefined) return Number.NEGATIVE_INFINITY;
        return pnl / (mae + params.maeFloor!);
    },
};
