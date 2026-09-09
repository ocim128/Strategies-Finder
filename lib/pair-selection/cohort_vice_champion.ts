import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface ViceChampionStats {
    secondByBase: ReadonlyMap<string, number>;
    minimumEligible: number;
    minimumReturn: number;
    maximumReturn: number;
}

function buildStats(pool: readonly PairCandidate[]): ViceChampionStats | null {
    const valuesByBase = new Map<string, number[]>();
    const returns: number[] = [];
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        returns.push(return48);
        const values = valuesByBase.get(entry.baseSymbol) ?? [];
        values.push(return48);
        valuesByBase.set(entry.baseSymbol, values);
    }
    const secondByBase = new Map<string, number>();
    for (const [base, values] of valuesByBase) {
        if (values.length < 2) continue;
        values.sort((left, right) => right - left);
        secondByBase.set(base, values[1]!);
    }
    if (returns.length === 0 || secondByBase.size === 0) return null;
    return {
        secondByBase,
        minimumEligible: Math.min(...secondByBase.values()),
        minimumReturn: Math.min(...returns),
        maximumReturn: Math.max(...returns),
    };
}

export const cohort_vice_champion: PairSelectionRule = {
    key: "cohort_vice_champion",
    name: "Cohort Vice Champion",
    description: "Selects second-ranked directional momentum candidates within base-symbol cohorts.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cohort_vice_champion.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, "cohort-vice-champion-stats", () => buildStats(pool));
        if (stats === null) return Number.NEGATIVE_INFINITY;
        if (stats.secondByBase.get(candidate.baseSymbol) === return48) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligible - 2 + normalized;
    },
};
