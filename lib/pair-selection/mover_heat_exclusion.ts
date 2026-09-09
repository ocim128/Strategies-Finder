import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface HeatStats {
    medianByBase: ReadonlyMap<string, number>;
    minimumEligibleReturn: number | null;
    minimumReturn: number | null;
    maximumReturn: number | null;
}

function buildHeatStats(pool: readonly PairCandidate[], heatCapPct: number): HeatStats {
    const medianByBase = new Map<string, number>();
    const heatValues = new Map<string, number[]>();
    const returns: number[] = [];
    for (const entry of pool) {
        const heat = entry.feat_return20;
        if (heat !== null && Number.isFinite(heat)) {
            const values = heatValues.get(entry.baseSymbol) ?? [];
            values.push(heat);
            heatValues.set(entry.baseSymbol, values);
        }
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 !== null) returns.push(return48);
    }
    for (const [base, values] of heatValues) {
        const value = median(values);
        if (value !== null) medianByBase.set(base, value);
    }
    const eligibleReturns = pool
        .filter((entry) => {
            const heat = medianByBase.get(entry.baseSymbol);
            return heat !== undefined && heat < heatCapPct;
        })
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
        .filter((value): value is number => value !== null);
    return {
        medianByBase,
        minimumEligibleReturn: eligibleReturns.length > 0 ? Math.min(...eligibleReturns) : null,
        minimumReturn: returns.length > 0 ? Math.min(...returns) : null,
        maximumReturn: returns.length > 0 ? Math.max(...returns) : null,
    };
}

export const mover_heat_exclusion: PairSelectionRule = {
    key: "mover_heat_exclusion",
    name: "Mover Heat Exclusion",
    description: "Ranks directional momentum among base cohorts whose median 20-bar return remains below the heat cap.",
    defaultParams: { heatCapPct: 12 },
    paramLabels: { heatCapPct: "Maximum base-cohort median 20-bar return before demotion" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/mover_heat_exclusion.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, `mover-heat-exclusion-stats-${params.heatCapPct!}`, () =>
            buildHeatStats(pool, params.heatCapPct!));
        if (stats.minimumEligibleReturn === null || stats.minimumReturn === null || stats.maximumReturn === null) {
            return Number.NEGATIVE_INFINITY;
        }
        const heat = stats.medianByBase.get(candidate.baseSymbol);
        if (heat !== undefined && heat < params.heatCapPct!) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligibleReturn - 2 + normalized;
    },
};
