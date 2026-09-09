import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface PodiumStats {
    demoted: ReadonlySet<PairCandidate>;
    minimumEligibleReturn: number | null;
    minimumReturn: number | null;
    maximumReturn: number | null;
}

function normalizePodiumRank(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function buildStats(pool: readonly PairCandidate[], podiumRank: number): PodiumStats {
    const values = pool
        .map((candidate) => ({
            candidate,
            value: directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1),
        }))
        .filter((entry): entry is { candidate: PairCandidate; value: number } => entry.value !== null);
    values.sort((left, right) => right.value - left.value);
    const demotionCount = Math.min(Math.max(0, podiumRank - 1), Math.max(0, values.length - 1));
    const demoted = new Set(values.slice(0, demotionCount).map((entry) => entry.candidate));
    const eligibleReturns = values.slice(demotionCount).map((entry) => entry.value);
    return {
        demoted,
        minimumEligibleReturn: eligibleReturns.length > 0 ? Math.min(...eligibleReturns) : null,
        minimumReturn: values.length > 0 ? Math.min(...values.map((entry) => entry.value)) : null,
        maximumReturn: values.length > 0 ? Math.max(...values.map((entry) => entry.value)) : null,
    };
}

export const global_podium_rank_pick: PairSelectionRule = {
    key: "global_podium_rank_pick",
    name: "Global Podium Rank Pick",
    description: "Demotes the top momentum ranks and selects from the requested event-global podium ordinal.",
    defaultParams: { podiumRank: 3 },
    paramLabels: { podiumRank: "Event-global momentum ordinal to retain (3 = bronze)" },
    normalizeParams: (params) => ({
        ...params,
        podiumRank: normalizePodiumRank(params.podiumRank!),
    }),
    metadata: {
        paramBounds: { podiumRank: { min: 1, max: 100, step: 1 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/global_podium_rank_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const podiumRank = normalizePodiumRank(params.podiumRank!);
        const stats = memoByPool(pool, `global-podium-rank-pick-${podiumRank}`, () => buildStats(pool, podiumRank));
        if (!stats.demoted.has(candidate)) return return48;
        if (stats.minimumEligibleReturn === null || stats.minimumReturn === null || stats.maximumReturn === null) {
            return Number.NEGATIVE_INFINITY;
        }
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligibleReturn - 2 + normalized;
    },
};
