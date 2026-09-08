import type { PairSelectionRule } from "./types";

export const recent_downside_loss_suppression: PairSelectionRule = {
    key: "recent_downside_loss_suppression",
    name: "Recent Downside Loss Suppression",
    description: "Minimizes the valid rolling 8-trade downside RMS.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: ["feat_fp_trade_downside_rms_t8_r1", "feat_fp_trade_downside_rms_t8_r1_n"],
        },
        sourceFiles: ["lib/pair-selection/recent_downside_loss_suppression.ts"],
    },
    score: (candidate) => {
        const downRms = candidate.feat_fp_trade_downside_rms_t8_r1;
        const n = candidate.feat_fp_trade_downside_rms_t8_r1_n;
        if (downRms === null || n === null || n < 4) return Number.NEGATIVE_INFINITY;
        return -downRms;
    },
};
