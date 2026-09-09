import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface FatTailStats {
    threshold: number | null;
    eligible: ReadonlySet<PairCandidate>;
    minimumEligibleReturn: number | null;
    minimumReturn: number | null;
    maximumReturn: number | null;
}

function quantile(sorted: readonly number[], percentile: number): number | null {
    if (sorted.length === 0) return null;
    const position = percentile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    const weight = position - lower;
    return sorted[lower]! + weight * (sorted[upper]! - sorted[lower]!);
}

function buildStats(pool: readonly PairCandidate[], vetoQuantile: number): FatTailStats {
    const kurtoses = pool
        .map((entry) => entry.feat_fp_spread_increment_kurtosis_b48_r1)
        .filter((value): value is number => value !== null && Number.isFinite(value))
        .sort((left, right) => left - right);
    const threshold = quantile(kurtoses, vetoQuantile);
    const eligible = new Set<PairCandidate>();
    const returns: number[] = [];
    const eligibleReturns: number[] = [];
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        returns.push(return48);
        const kurtosis = entry.feat_fp_spread_increment_kurtosis_b48_r1;
        if (threshold !== null && kurtosis !== null && Number.isFinite(kurtosis) && kurtosis < threshold) {
            eligible.add(entry);
            eligibleReturns.push(return48);
        }
    }
    return {
        threshold,
        eligible,
        minimumEligibleReturn: eligibleReturns.length > 0 ? Math.min(...eligibleReturns) : null,
        minimumReturn: returns.length > 0 ? Math.min(...returns) : null,
        maximumReturn: returns.length > 0 ? Math.max(...returns) : null,
    };
}

export const fat_tail_veto: PairSelectionRule = {
    key: "fat_tail_veto",
    name: "Fat Tail Veto",
    description: "Restricts directional momentum eligibility to candidates below the event kurtosis quantile cutoff.",
    defaultParams: { vetoQuantile: 0.1 },
    paramLabels: { vetoQuantile: "Event kurtosis quantile cutoff" },
    normalizeParams: (params) => ({
        ...params,
        vetoQuantile: Math.min(1, Math.max(0, params.vetoQuantile!)),
    }),
    metadata: {
        paramBounds: { vetoQuantile: { min: 0, max: 1, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_increment_kurtosis_b48_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/fat_tail_veto.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const vetoQuantile = Math.min(1, Math.max(0, params.vetoQuantile!));
        const stats = memoByPool(pool, `fat-tail-veto-stats-${vetoQuantile}`, () => buildStats(pool, vetoQuantile));
        if (stats.minimumEligibleReturn === null || stats.minimumReturn === null || stats.maximumReturn === null) {
            return Number.NEGATIVE_INFINITY;
        }
        if (stats.eligible.has(candidate)) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligibleReturn - 2 + normalized;
    },
};
