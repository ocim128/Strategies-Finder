import type { PairSelectionRule } from "./types";

export const historical_trade_sortino: PairSelectionRule = {
    key: "historical_trade_sortino",
    name: "Historical Trade Sortino",
    description: "Ranks the rolling 8-trade mean net return by rolling downside RMS.",
    defaultParams: { riskFloor: 0.5 },
    paramLabels: { riskFloor: "Floor in percentage points added to downside RMS to stabilize near-zero denominator" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_trade_mean_net_pct_t8_r1",
                "feat_fp_trade_mean_net_pct_t8_r1_n",
                "feat_fp_trade_downside_rms_t8_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/historical_trade_sortino.ts"],
    },
    score: (candidate, _event, params) => {
        const mean = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const n = candidate.feat_fp_trade_mean_net_pct_t8_r1_n;
        const downRms = candidate.feat_fp_trade_downside_rms_t8_r1;
        if (mean === null || n === null || n < 4 || downRms === null) return Number.NEGATIVE_INFINITY;
        return mean / (downRms + params.riskFloor!);
    },
};
