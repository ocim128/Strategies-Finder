import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface CohortChampions {
    baseMaximum: ReadonlyMap<string, number>;
    quoteMaximum: ReadonlyMap<string, number>;
    hasDualChampion: boolean;
}

function buildCohortChampions(pool: readonly PairCandidate[]): CohortChampions {
    const baseMaximum = new Map<string, number>();
    const quoteMaximum = new Map<string, number>();
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        if (return48 > (baseMaximum.get(entry.baseSymbol) ?? Number.NEGATIVE_INFINITY)) {
            baseMaximum.set(entry.baseSymbol, return48);
        }
        if (return48 > (quoteMaximum.get(entry.quoteSymbol) ?? Number.NEGATIVE_INFINITY)) {
            quoteMaximum.set(entry.quoteSymbol, return48);
        }
    }
    let hasDualChampion = false;
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 !== null
            && baseMaximum.get(entry.baseSymbol) === return48
            && quoteMaximum.get(entry.quoteSymbol) === return48) {
            hasDualChampion = true;
            break;
        }
    }
    return { baseMaximum, quoteMaximum, hasDualChampion };
}

export const dual_cohort_champion: PairSelectionRule = {
    key: "dual_cohort_champion",
    name: "Dual Cohort Champion",
    description: "Selects candidates that lead both their base-symbol and quote-symbol momentum cohorts, with a full-pool fallback.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/dual_cohort_champion.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const champions = memoByPool(pool, "dual-cohort-champion-maxima", () => buildCohortChampions(pool));
        if (!champions.hasDualChampion) return return48;
        return champions.baseMaximum.get(candidate.baseSymbol) === return48
            && champions.quoteMaximum.get(candidate.quoteSymbol) === return48
            ? return48
            : Number.NEGATIVE_INFINITY;
    },
};
