import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const breadth_size_ranking_switch: PairSelectionRule = {
    key: "breadth_size_ranking_switch",
    name: "Breadth Size Ranking Switch",
    description: "Uses directional 48-bar momentum for selective events and ATR for crowded events.",
    defaultParams: { maxSelectiveFires: 761 },
    paramLabels: { maxSelectiveFires: "Maximum same-event fires for the selective momentum arm" },
    metadata: {
        usesRankFeatures: true,
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/breadth_size_ranking_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params) => {
        const breadth = candidate.feat_candidatesAtTime;
        if (breadth === null || !Number.isFinite(breadth)) return Number.NEGATIVE_INFINITY;
        if (breadth <= params.maxSelectiveFires!) {
            const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
            return return48 ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
