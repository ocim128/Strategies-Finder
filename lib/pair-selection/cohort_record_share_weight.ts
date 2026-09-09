import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function buildRecordShares(pool: readonly PairCandidate[]): ReadonlyMap<string, number> {
    const counts = new Map<string, { total: number; records: number }>();
    for (const entry of pool) {
        const stats = counts.get(entry.baseSymbol) ?? { total: 0, records: 0 };
        stats.total += 1;
        if (entry.feat_fp_spread_recent_record_flag_b48_r1 === 1) stats.records += 1;
        counts.set(entry.baseSymbol, stats);
    }
    return new Map([...counts].map(([base, stats]) => [base, stats.records / stats.total] as const));
}

export const cohort_record_share_weight: PairSelectionRule = {
    key: "cohort_record_share_weight",
    name: "Cohort Record Share Weight",
    description: "Weights directional momentum by the share of the candidate's base cohort recently printing path records.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cohort_record_share_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const flag = candidate.feat_fp_spread_recent_record_flag_b48_r1;
        if (return48 === null || flag === null || !Number.isFinite(flag)) return Number.NEGATIVE_INFINITY;
        const shares = memoByPool(pool, "cohort-record-share-weight-shares", () => buildRecordShares(pool));
        const share = shares.get(candidate.baseSymbol);
        return share === undefined ? Number.NEGATIVE_INFINITY : return48 * share;
    },
};
