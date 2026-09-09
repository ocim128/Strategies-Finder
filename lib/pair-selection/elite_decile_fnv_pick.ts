import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

function normalizeEliteFraction(value: number): number {
    return Math.min(1, Math.max(0, value));
}

export const elite_decile_fnv_pick: PairSelectionRule = {
    key: "elite_decile_fnv_pick",
    name: "Elite Decile FNV Pick",
    description: "Keeps the top directional-momentum fraction as an elite tier and lets the shared FNV tie-break pick within it.",
    defaultParams: { eliteFraction: 0.1 },
    paramLabels: { eliteFraction: "Fraction of the event pool in the directional-momentum elite tier" },
    normalizeParams: (params) => ({
        ...params,
        eliteFraction: normalizeEliteFraction(params.eliteFraction!),
    }),
    metadata: {
        paramBounds: { eliteFraction: { min: 0, max: 1, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/elite_decile_fnv_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const values = memoByPool(pool, "elite-decile-fnv-pick-values", () => pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
            .filter((value): value is number => value !== null)
            .sort((left, right) => right - left));
        const eliteCount = Math.max(1, Math.ceil(values.length * normalizeEliteFraction(params.eliteFraction!)));
        const threshold = values.length === 0 ? null : values[Math.min(eliteCount, values.length) - 1]!;
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        return return48 !== null && threshold !== null && return48 >= threshold ? 1 : 0;
    },
};
