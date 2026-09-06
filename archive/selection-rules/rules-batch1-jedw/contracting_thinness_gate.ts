import type { SelectionRule } from "./types";

export const contracting_thinness_gate: SelectionRule = {
    key: "contracting_thinness_gate",
    name: "Contracting Thinness Gate",
    description:
        "Ranks candidates by base thinness (100 - activePairCount), awarding a 2x bonus when priorCoverageSlope5 is at or below negative minContractionRate. Null priorCoverageSlope5 receives no bonus through a zero slope.",
    defaultParams: { minContractionRate: 0.2 },
    paramLabels: { minContractionRate: "Minimum coverage contraction rate" },
    score(candidate, _event, params) {
        const baseThinness = 100 - candidate.activePairCount;
        const slope = candidate.priorCoverageSlope5 === null ? 0 : candidate.priorCoverageSlope5;
        const contractionBonus = slope <= -params.minContractionRate! ? 2 : 1;
        return baseThinness * contractionBonus;
    },
};
