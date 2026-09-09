import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface ScaleAmbiguityStats {
    eligible: ReadonlySet<PairCandidate>;
    minimumEligibleReturn: number | null;
    minimumReturn: number | null;
    maximumReturn: number | null;
}

function descendingRank(values: readonly number[], value: number): number {
    let greater = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry > value) greater += 1;
        else if (entry === value) equal += 1;
    }
    return 1 + greater + (equal - 1) / 2;
}

function buildStats(pool: readonly PairCandidate[]): ScaleAmbiguityStats {
    const values12 = pool
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1))
        .filter((value): value is number => value !== null);
    const values240 = pool
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1))
        .filter((value): value is number => value !== null);
    const eligible = new Set<PairCandidate>();
    const returns: number[] = [];
    const eligibleReturns: number[] = [];
    for (const entry of pool) {
        const return12 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1);
        const return240 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1);
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return12 === null || return240 === null) continue;
        const rank12 = descendingRank(values12, return12);
        const rank240 = descendingRank(values240, return240);
        if (return48 !== null) returns.push(return48);
        if (Math.abs(rank240 - rank12) <= pool.length / 2) {
            eligible.add(entry);
            if (return48 !== null) eligibleReturns.push(return48);
        }
    }
    return {
        eligible,
        minimumEligibleReturn: eligibleReturns.length > 0 ? Math.min(...eligibleReturns) : null,
        minimumReturn: returns.length > 0 ? Math.min(...returns) : null,
        maximumReturn: returns.length > 0 ? Math.max(...returns) : null,
    };
}

export const scale_ambiguity_veto: PairSelectionRule = {
    key: "scale_ambiguity_veto",
    name: "Scale Ambiguity Veto",
    description: "Ranks directional momentum among candidates whose 12-bar and 240-bar pool ranks remain within half a pool apart.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b240_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/scale_ambiguity_veto.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, "scale-ambiguity-veto-stats", () => buildStats(pool));
        if (stats.minimumEligibleReturn === null || stats.minimumReturn === null || stats.maximumReturn === null) {
            return Number.NEGATIVE_INFINITY;
        }
        if (stats.eligible.has(candidate)) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligibleReturn - 2 + normalized;
    },
};
