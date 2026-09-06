import type { SelectionRule } from "./types";

export const thinness_vote_delta_product: SelectionRule = {
    key: "thinness_vote_delta_product",
    name: "Thinness Vote Delta Product",
    description:
        "Ranks candidates by base thinness (100 - activePairCount) multiplied by a vote-delta tilt, with the multiplier floored at 0.1. Null priorSignedVoteDelta3 receives a zero delta and neutral multiplier.",
    defaultParams: { deltaScale: 0.3 },
    paramLabels: { deltaScale: "Vote-delta thinness scale" },
    score(candidate, _event, params) {
        const baseThinness = 100 - candidate.activePairCount;
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        return baseThinness * Math.max(0.1, 1 + params.deltaScale! * delta);
    },
};
