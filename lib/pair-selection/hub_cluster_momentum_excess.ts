import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface ClusterMomentumStats {
    sum: number;
    count: number;
}

export const hub_cluster_momentum_excess: PairSelectionRule = {
    key: "hub_cluster_momentum_excess",
    name: "Hub-Cluster Momentum Excess",
    description: "Ranks direction-aligned 48-bar return after subtracting shared-base cluster momentum.",
    defaultParams: { clusterDeductionWeight: 0.5 },
    paramLabels: { clusterDeductionWeight: "Weight of shared-base cluster mean momentum subtracted from individual return" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/hub_cluster_momentum_excess.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const dirRet48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (dirRet48 === null) return Number.NEGATIVE_INFINITY;
        const clusterStats = memoByPool(pool, "hub-cluster-momentum-stats", () => {
            const stats = new Map<string, ClusterMomentumStats>();
            for (const entry of pool) {
                const entryRet48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
                if (entryRet48 === null) continue;
                const current = stats.get(entry.baseSymbol);
                if (current) {
                    current.sum += entryRet48;
                    current.count += 1;
                } else {
                    stats.set(entry.baseSymbol, { sum: entryRet48, count: 1 });
                }
            }
            return stats;
        });
        const stats = clusterStats.get(candidate.baseSymbol);
        if (!stats || stats.count === 0) return Number.NEGATIVE_INFINITY;
        return dirRet48 - params.clusterDeductionWeight! * (stats.sum / stats.count);
    },
};
