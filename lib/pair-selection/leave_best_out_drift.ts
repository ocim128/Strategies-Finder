import type { PairSelectionRule } from "./types";

export const leave_best_out_drift: PairSelectionRule = {
    key: "leave_best_out_drift",
    name: "Leave Best Out Drift",
    description: "Ranks the 48-bar drift remaining after removing its single best direction-adjusted increment.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/leave_best_out_drift.ts"],
    },
    score: (candidate) => {
        const drift = candidate.feat_fp_spread_leave_best_out_drift_b48_r1;
        return drift === null || !Number.isFinite(drift) ? Number.NEGATIVE_INFINITY : drift;
    },
};
