import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface ParetoValue {
    candidate: PairCandidate;
    return48: number;
    efficiency: number;
}

function buildUndominated(pool: readonly PairCandidate[]): ReadonlySet<PairCandidate> {
    const values: ParetoValue[] = [];
    for (const candidate of pool) {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (return48 !== null && efficiency !== null && Number.isFinite(efficiency)) {
            values.push({ candidate, return48, efficiency });
        }
    }
    const dominated = new Set<PairCandidate>();
    for (const value of values) {
        if (values.some((other) => other !== value
            && other.return48 >= value.return48
            && other.efficiency >= value.efficiency
            && (other.return48 > value.return48 || other.efficiency > value.efficiency))) {
            dominated.add(value.candidate);
        }
    }
    return new Set(values
        .map((value) => value.candidate)
        .filter((candidate) => !dominated.has(candidate)));
}

export const pareto_undominated_pick: PairSelectionRule = {
    key: "pareto_undominated_pick",
    name: "Pareto Undominated Pick",
    description: "Ranks candidates by return after restricting eligibility to the return-efficiency Pareto frontier.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/pareto_undominated_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (return48 === null || efficiency === null || !Number.isFinite(efficiency)) {
            return Number.NEGATIVE_INFINITY;
        }
        const undominated = memoByPool(pool, "pareto-undominated-pick-candidates", () => buildUndominated(pool));
        return undominated.has(candidate) ? return48 : Number.NEGATIVE_INFINITY;
    },
};
