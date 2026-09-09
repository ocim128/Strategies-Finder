import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function topDecileMedianReturn12(pool: readonly PairCandidate[]): number | null {
    const momentum = pool
        .map((entry) => ({
            entry,
            return48: directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1),
        }))
        .filter((value): value is { entry: PairCandidate; return48: number } => value.return48 !== null)
        .sort((left, right) => right.return48 - left.return48);
    if (momentum.length === 0) return null;
    const topCount = Math.max(1, Math.ceil(momentum.length * 0.1));
    const threshold = momentum[Math.min(topCount, momentum.length) - 1]!.return48;
    const topReturns12 = momentum
        .filter((value) => value.return48 >= threshold)
        .map((value) => directionAdjusted(value.entry, value.entry.feat_fp_spread_log_return_b12_r1))
        .filter((value): value is number => value !== null);
    return median(topReturns12);
}

export const canary_leader_gate: PairSelectionRule = {
    key: "canary_leader_gate",
    name: "Canary Leader Gate",
    description: "Uses momentum when the top 48-bar momentum decile still has positive median 12-bar health, and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_log_return_b12_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/canary_leader_gate.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const leaderHealth = memoByPool(pool, "canary-leader-gate-health", () => topDecileMedianReturn12(pool));
        if (leaderHealth !== null && leaderHealth > 0) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
