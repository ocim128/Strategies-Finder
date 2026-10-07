import { directionAdjusted, getDirectional48BarCohortAlignments, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function sign(value: number | null): -1 | 0 | 1 {
    if (value === null || value === 0) return 0;
    return value < 0 ? -1 : 1;
}

function alignmentFraction(pool: readonly PairCandidate[]): number {
    if (pool.length === 0) return 0;
    const alignments = getDirectional48BarCohortAlignments(pool);
    let agreeing = 0;
    for (const alignment of alignments.values()) {
        const baseSign = sign(alignment.base);
        const quoteSign = sign(alignment.quote);
        if (baseSign !== 0 && baseSign === quoteSign) agreeing += 1;
    }
    return agreeing / pool.length;
}

export const cohort_alignment_regime_switch: PairSelectionRule = {
    key: "cohort_alignment_regime_switch",
    name: "Cohort Alignment Regime Switch",
    description: "Uses momentum in aligned cohort environments and ATR in cross-currents events.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cohort_alignment_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const aligned = memoByPool(pool, "cohort-alignment-regime-switch-fraction", () => alignmentFraction(pool)) >= 0.5;
        if (aligned) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
