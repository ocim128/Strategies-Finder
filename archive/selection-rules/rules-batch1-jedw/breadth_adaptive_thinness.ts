import type { SelectionRule } from "./types";

export const breadth_adaptive_thinness: SelectionRule = {
    key: "breadth_adaptive_thinness",
    name: "Breadth-Adaptive Thinness",
    description:
        "Uses vote delta plus 0.01 times thinness when event breadth reaches breadthSwitch, and thinness plus 0.5 times vote delta otherwise. Null breadth defaults to 0.65 and null vote delta to zero.",
    defaultParams: { breadthSwitch: 0.65 },
    paramLabels: { breadthSwitch: "Breadth switching threshold" },
    score(candidate, _event, params) {
        const eventBreadth = candidate.breadth === null ? 0.65 : candidate.breadth;
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        const baseThinness = 100 - candidate.activePairCount;
        return eventBreadth >= params.breadthSwitch!
            ? delta + 0.01 * baseThinness
            : baseThinness + 0.5 * delta;
    },
};
