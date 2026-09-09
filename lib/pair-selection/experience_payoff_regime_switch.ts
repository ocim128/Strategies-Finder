import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function rankValues(values: readonly number[]): number[] {
    const ordered = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
    const ranks = new Array<number>(values.length);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end += 1;
        const rank = (start + end + 1) / 2;
        for (let index = start; index < end; index += 1) ranks[ordered[index]!.index] = rank;
        start = end;
    }
    return ranks;
}

function experienceReturnSpearman(pool: readonly PairCandidate[]): number {
    const values = pool
        .map((entry) => ({
            experience: entry.feat_pairTradesPrior,
            return48: directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1),
        }))
        .filter((value): value is { experience: number; return48: number } =>
            Number.isFinite(value.experience) && value.return48 !== null);
    if (values.length < 2) return 0;
    const experienceRanks = rankValues(values.map((value) => value.experience));
    const returnRanks = rankValues(values.map((value) => value.return48));
    const experienceMean = experienceRanks.reduce((sum, value) => sum + value, 0) / values.length;
    const returnMean = returnRanks.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let experienceVariance = 0;
    let returnVariance = 0;
    for (let index = 0; index < values.length; index += 1) {
        const experienceDelta = experienceRanks[index]! - experienceMean;
        const returnDelta = returnRanks[index]! - returnMean;
        numerator += experienceDelta * returnDelta;
        experienceVariance += experienceDelta ** 2;
        returnVariance += returnDelta ** 2;
    }
    if (experienceVariance === 0 || returnVariance === 0) return 0;
    return numerator / Math.sqrt(experienceVariance * returnVariance);
}

export const experience_payoff_regime_switch: PairSelectionRule = {
    key: "experience_payoff_regime_switch",
    name: "Experience Payoff Regime Switch",
    description: "Uses momentum when prior trade experience has positive event-level Spearman payoff, and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/experience_payoff_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const useMomentum = memoByPool(pool, "experience-payoff-regime-switch-spearman", () =>
            experienceReturnSpearman(pool)) > 0;
        if (useMomentum) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
