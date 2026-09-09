import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function diffusionBeta(pool: readonly PairCandidate[]): number | null {
    const values = pool
        .map((entry) => ({
            fast: directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1),
            slow: directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1),
        }))
        .filter((value): value is { fast: number; slow: number } => value.fast !== null && value.slow !== null);
    if (values.length < 2) return null;
    const meanFast = values.reduce((sum, value) => sum + value.fast, 0) / values.length;
    const meanSlow = values.reduce((sum, value) => sum + value.slow, 0) / values.length;
    const denominator = values.reduce((sum, value) => sum + (value.slow - meanSlow) ** 2, 0);
    if (denominator === 0) return null;
    const numerator = values.reduce((sum, value) => sum + (value.slow - meanSlow) * (value.fast - meanFast), 0);
    return numerator / denominator;
}

export const scale_diffusion_residual: PairSelectionRule = {
    key: "scale_diffusion_residual",
    name: "Scale Diffusion Residual",
    description: "Ranks fast directional return after subtracting the event regression on slow directional return.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/scale_diffusion_residual.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const fast = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const slow = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b240_r1);
        if (fast === null || slow === null) return Number.NEGATIVE_INFINITY;
        const beta = memoByPool(pool, "scale-diffusion-residual-beta", () => diffusionBeta(pool));
        return beta === null ? Number.NEGATIVE_INFINITY : fast - beta * slow;
    },
};
