import type { SelectionCandidate, SelectionRule } from "./types";

/** 100x demotion pushes any demoted candidate (max ~39 votes -> 0.39) below every qualifying one (votes >= 1). */
const DEMOTION_FACTOR = 0.01;

export const coverage_floor_votes: SelectionRule = {
    key: "coverage_floor_votes",
    name: "Coverage-Floor Votes",
    description:
        "signedVotes, demoted 100x for candidates whose activePairCount is below coverageFloor x the event's median activePairCount. Keeps crowd strength, sinks thin-coverage names.",
    defaultParams: { coverageFloor: 0.8 },
    paramLabels: { coverageFloor: "Coverage floor (x event median pairs)" },
    normalizeParams(params) {
        const raw = typeof params.coverageFloor === "number" && Number.isFinite(params.coverageFloor)
            ? params.coverageFloor
            : 0.8;
        return { coverageFloor: Math.max(0.3, Math.min(1.5, raw)) };
    },
    score(candidate, _event, params, pool) {
        if (candidate.signedVotes <= 0) return Number.NEGATIVE_INFINITY;
        const counts = pool
            .map((entry: SelectionCandidate) => entry.activePairCount)
            .filter((count) => count > 0)
            .sort((left, right) => left - right);
        if (counts.length === 0) return candidate.signedVotes;
        const middle = counts.length >> 1;
        const median = counts.length % 2 === 1 ? counts[middle]! : (counts[middle - 1]! + counts[middle]!) / 2;
        return candidate.activePairCount < params.coverageFloor! * median
            ? candidate.signedVotes * DEMOTION_FACTOR
            : candidate.signedVotes;
    },
};
