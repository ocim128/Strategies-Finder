import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface AgreementStats {
    eligible: ReadonlySet<PairCandidate>;
    minimumEligibleReturn: number | null;
    minimumReturn: number | null;
    maximumReturn: number | null;
}

function buildStats(pool: readonly PairCandidate[]): AgreementStats {
    const eligible = new Set<PairCandidate>();
    const returns: number[] = [];
    const eligibleReturns: number[] = [];
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        returns.push(return48);
        const medianSign = entry.feat_fp_spread_median_increment_sign_b48_r1;
        const slope48 = directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2);
        if (medianSign !== null && Number.isFinite(medianSign)
            && slope48 !== null && Math.sign(medianSign) === Math.sign(slope48)) {
            eligible.add(entry);
            eligibleReturns.push(return48);
        }
    }
    return {
        eligible,
        minimumEligibleReturn: eligibleReturns.length > 0 ? Math.min(...eligibleReturns) : null,
        minimumReturn: returns.length > 0 ? Math.min(...returns) : null,
        maximumReturn: returns.length > 0 ? Math.max(...returns) : null,
    };
}

export const dual_engine_agreement_veto: PairSelectionRule = {
    key: "dual_engine_agreement_veto",
    name: "Dual Engine Agreement Veto",
    description: "Ranks directional momentum among candidates whose robust median-increment and OLS trend signs agree.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_median_increment_sign_b48_r1",
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/dual_engine_agreement_veto.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, "dual-engine-agreement-veto-stats", () => buildStats(pool));
        if (stats.minimumEligibleReturn === null || stats.minimumReturn === null || stats.maximumReturn === null) {
            return Number.NEGATIVE_INFINITY;
        }
        if (stats.eligible.has(candidate)) return return48;
        const range = stats.maximumReturn - stats.minimumReturn;
        const normalized = range > 0 ? (return48 - stats.minimumReturn) / range : 0;
        return stats.minimumEligibleReturn - 2 + normalized;
    },
};
