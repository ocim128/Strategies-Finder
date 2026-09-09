import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface UnionRanks {
    returns: readonly number[];
    atr: readonly number[];
}

function percentileRank(values: readonly number[], value: number): number | null {
    if (values.length === 0) return null;
    if (values.length === 1) return 0.5;
    let less = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry < value) less += 1;
        else if (entry === value) equal += 1;
    }
    return (less + (equal - 1) / 2) / (values.length - 1);
}

function buildRanks(pool: readonly PairCandidate[]): UnionRanks {
    return {
        returns: pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
            .filter((value): value is number => value !== null),
        atr: pool
            .map((entry) => entry.feat_atrPct)
            .filter((value): value is number => value !== null && Number.isFinite(value)),
    };
}

export const escape_hatch_union_pick: PairSelectionRule = {
    key: "escape_hatch_union_pick",
    name: "Escape Hatch Union Pick",
    description: "Ranks by the better of event percentiles for directional momentum and signal ATR.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/escape_hatch_union_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const atr = candidate.feat_atrPct;
        const ranks = memoByPool(pool, "escape-hatch-union-pick-ranks", () => buildRanks(pool));
        const returnRank = return48 === null ? null : percentileRank(ranks.returns, return48);
        const atrRank = atr === null || !Number.isFinite(atr) ? null : percentileRank(ranks.atr, atr);
        if (returnRank === null && atrRank === null) return Number.NEGATIVE_INFINITY;
        return Math.max(returnRank ?? Number.NEGATIVE_INFINITY, atrRank ?? Number.NEGATIVE_INFINITY);
    },
};
