import type { SelectionRule } from "./types";

const DEMOTION_FACTOR = 0.01;

export const durable_score_stability_gate: SelectionRule = {
    key: "durable_score_stability_gate",
    name: "Durable Score Stability Gate",
    description:
        "Ranks positive candidates by signedVotes / activePairCount only when priorScoreStdDev5 is at or below maxScoreStdDev; candidates above the ceiling, including null warm-up values, are demoted by 100x. Non-positive votes or active pairs are ineligible.",
    defaultParams: { maxScoreStdDev: 0.015 },
    paramLabels: { maxScoreStdDev: "Maximum five-event score standard deviation" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0 || candidate.activePairCount <= 0) return Number.NEGATIVE_INFINITY;
        const baseScore = candidate.signedVotes / candidate.activePairCount;
        return candidate.priorScoreStdDev5 !== null
            && candidate.priorScoreStdDev5 <= params.maxScoreStdDev!
            ? baseScore
            : baseScore * DEMOTION_FACTOR;
    },
};
