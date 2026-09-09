import { directionAdjusted, median, medianAbsoluteDeviation, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface ThemeDecisivenessStats {
    medianChampionMargin: number | null;
    returnMad: number | null;
}

function buildStats(pool: readonly PairCandidate[]): ThemeDecisivenessStats {
    const returns: number[] = [];
    const byBase = new Map<string, number[]>();
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        returns.push(return48);
        const values = byBase.get(entry.baseSymbol) ?? [];
        values.push(return48);
        byBase.set(entry.baseSymbol, values);
    }
    const margins: number[] = [];
    for (const values of byBase.values()) {
        const center = median(values);
        if (center !== null) margins.push(Math.max(...values) - center);
    }
    const returnMedian = median(returns);
    return {
        medianChampionMargin: median(margins),
        returnMad: returnMedian === null ? null : medianAbsoluteDeviation(returns, returnMedian),
    };
}

export const theme_decisiveness_regime_switch: PairSelectionRule = {
    key: "theme_decisiveness_regime_switch",
    name: "Theme Decisiveness Regime Switch",
    description: "Uses momentum when the typical base-symbol cohort has a champion margin at least as large as pool return MAD, and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/theme_decisiveness_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const stats = memoByPool(pool, "theme-decisiveness-regime-switch-stats", () => buildStats(pool));
        const useMomentum = stats.medianChampionMargin !== null
            && stats.returnMad !== null
            && stats.medianChampionMargin >= stats.returnMad;
        if (useMomentum) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
