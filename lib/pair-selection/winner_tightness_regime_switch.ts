import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function quantile(sorted: readonly number[], percentile: number): number | null {
    if (sorted.length === 0) return null;
    const position = percentile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    const weight = position - lower;
    return sorted[lower]! + weight * (sorted[upper]! - sorted[lower]!);
}

function interquartileRange(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const lower = quantile(sorted, 0.25);
    const upper = quantile(sorted, 0.75);
    return lower === null || upper === null ? 0 : upper - lower;
}

interface WinnerTightnessStats {
    winnerIqr: number;
    fullIqr: number;
}

function buildStats(pool: readonly PairCandidate[]): WinnerTightnessStats {
    const returns = pool
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
        .filter((value): value is number => value !== null);
    return {
        winnerIqr: interquartileRange(returns.filter((value) => value > 0)),
        fullIqr: interquartileRange(returns),
    };
}

export const winner_tightness_regime_switch: PairSelectionRule = {
    key: "winner_tightness_regime_switch",
    name: "Winner Tightness Regime Switch",
    description: "Uses momentum when positive-return winners are no more dispersed than the full field, and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/winner_tightness_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const stats = memoByPool(pool, "winner-tightness-regime-switch-stats", () => buildStats(pool));
        if (stats.winnerIqr <= stats.fullIqr) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
