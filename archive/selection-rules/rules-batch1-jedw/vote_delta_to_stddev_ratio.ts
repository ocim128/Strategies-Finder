import type { SelectionRule } from "./types";

export const vote_delta_to_stddev_ratio: SelectionRule = {
    key: "vote_delta_to_stddev_ratio",
    name: "Vote Delta to StdDev Ratio",
    description:
        "Ranks candidates by prior vote delta plus 0.01 times base thinness, divided by noiseFloor plus priorScoreStdDev5. Null vote delta is zero and null score standard deviation equals noiseFloor.",
    defaultParams: { noiseFloor: 0.01 },
    paramLabels: { noiseFloor: "Score-noise floor" },
    normalizeParams(params) {
        const raw = typeof params.noiseFloor === "number" && Number.isFinite(params.noiseFloor)
            ? params.noiseFloor
            : 0.01;
        return { noiseFloor: Math.max(Number.EPSILON, raw) };
    },
    score(candidate, _event, params) {
        const delta = candidate.priorSignedVoteDelta3 === null ? 0 : candidate.priorSignedVoteDelta3;
        const stdDev = candidate.priorScoreStdDev5 === null ? params.noiseFloor! : candidate.priorScoreStdDev5;
        return (delta + 0.01 * (100 - candidate.activePairCount)) / (params.noiseFloor! + stdDev);
    },
};
