import { directionAdjusted, median, medianAbsoluteDeviation, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface LeaderSeparationStats {
    leader: number;
    median: number;
    mad: number;
}

function leaderSeparationStats(pool: readonly PairCandidate[]): LeaderSeparationStats | null {
    const values = pool
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
        .filter((value): value is number => value !== null);
    const center = median(values);
    if (center === null) return null;
    const mad = medianAbsoluteDeviation(values, center);
    if (mad === null) return null;
    return { leader: Math.max(...values), median: center, mad };
}

export const decisive_leader_gate: PairSelectionRule = {
    key: "decisive_leader_gate",
    name: "Decisive Leader Gate",
    description: "Uses momentum only when the event leader separates from the field by a configured MAD threshold.",
    defaultParams: { minLeaderSeparation: 2.0 },
    paramLabels: { minLeaderSeparation: "Minimum leader-to-field separation in pool MAD units" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/decisive_leader_gate.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const stats = memoByPool(pool, "decisive-leader-gate-stats", () => leaderSeparationStats(pool));
        if (stats === null) return Number.NEGATIVE_INFINITY;
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const leaderIsDecisive = stats.leader - stats.median >= params.minLeaderSeparation! * stats.mad;
        if (leaderIsDecisive) return return48 ?? Number.NEGATIVE_INFINITY;
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
