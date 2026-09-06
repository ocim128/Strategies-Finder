import type { SelectionRule } from "./types";

export const vote_velocity_additive_blend: SelectionRule = {
    key: "vote_velocity_additive_blend",
    name: "Vote Velocity Additive Blend",
    description:
        "Ranks positive candidates by effective votes: signedVotes plus velocityWeight times priorSignedVoteDelta3. Null priorSignedVoteDelta3 receives a zero velocity adjustment; non-positive signedVotes are ineligible.",
    defaultParams: { velocityWeight: 4.0 },
    paramLabels: { velocityWeight: "Vote velocity weight" },
    score(candidate, _event, params) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const velocity = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        return candidate.signedVotes + params.velocityWeight! * velocity;
    },
};
