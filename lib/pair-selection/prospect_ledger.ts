import type { PairSelectionRule } from "./types";

export const prospect_ledger: PairSelectionRule = {
    key: "prospect_ledger",
    name: "Prospect Ledger",
    description: "Ranks the fixed two-to-one loss-aversion ledger of direction-adjusted spread increments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_prospect_ledger_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/prospect_ledger.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_prospect_ledger_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
