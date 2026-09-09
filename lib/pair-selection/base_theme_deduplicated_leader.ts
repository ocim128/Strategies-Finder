import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface BaseLeaderStats {
    maximumByBase: ReadonlyMap<string, number>;
    minimumEligible: number;
    minimumReturn: number;
    maximumReturn: number;
}

function buildStats(pool: readonly PairCandidate[]): BaseLeaderStats | null {
    const maximumByBase = new Map<string, number>();
    const returns: number[] = [];
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        returns.push(return48);
        const current = maximumByBase.get(entry.baseSymbol);
        if (current === undefined || return48 > current) maximumByBase.set(entry.baseSymbol, return48);
    }
    if (returns.length === 0 || maximumByBase.size === 0) return null;
    return {
        maximumByBase,
        minimumEligible: Math.min(...maximumByBase.values()),
        minimumReturn: Math.min(...returns),
        maximumReturn: Math.max(...returns),
    };
}

export const base_theme_deduplicated_leader: PairSelectionRule = {
    key: "base_theme_deduplicated_leader",
    name: "Base Theme Deduplicated Leader",
    description: "Selects only base-symbol cohort leaders, while retaining ineligible candidates below the leaders.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/base_theme_deduplicated_leader.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, "base-theme-deduplicated-leader-stats", () => buildStats(pool));
        if (stats === null) return Number.NEGATIVE_INFINITY;
        if (stats.maximumByBase.get(candidate.baseSymbol) === return48) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligible - 2 + normalized;
    },
};
