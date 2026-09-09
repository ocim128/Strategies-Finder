import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface HorizonValue {
    tStat: number | null;
    drift: number | null;
}

function chooseHorizon(candidate: Parameters<PairSelectionRule["score"]>[0]): HorizonValue {
    const horizons: HorizonValue[] = [
        {
            tStat: candidate.feat_fp_spread_trend_t_stat_b240_r1,
            drift: candidate.feat_fp_spread_log_return_b240_r1,
        },
        {
            tStat: candidate.feat_fp_spread_trend_t_stat_b48_r1,
            drift: candidate.feat_fp_spread_log_return_b48_r1,
        },
        {
            tStat: candidate.feat_fp_spread_trend_t_stat_b12_r1,
            drift: candidate.feat_fp_spread_log_return_b12_r1,
        },
    ];
    let selected: HorizonValue | null = null;
    for (const horizon of horizons) {
        if (horizon.tStat === null || !Number.isFinite(horizon.tStat)) continue;
        if (selected === null || Math.abs(horizon.tStat) > Math.abs(selected.tStat!)) selected = horizon;
    }
    return selected ?? { tStat: null, drift: null };
}

export const best_evidence_drift: PairSelectionRule = {
    key: "best_evidence_drift",
    name: "Best Evidence Drift",
    description: "Uses each candidate's direction-adjusted drift at the horizon with the strongest absolute trend t-statistic.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_trend_t_stat_b12_r1",
                "feat_fp_spread_trend_t_stat_b48_r1",
                "feat_fp_spread_trend_t_stat_b240_r1",
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/best_evidence_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const selected = chooseHorizon(candidate);
        return selected.drift === null
            ? Number.NEGATIVE_INFINITY
            : directionAdjusted(candidate, selected.drift) ?? Number.NEGATIVE_INFINITY;
    },
};
