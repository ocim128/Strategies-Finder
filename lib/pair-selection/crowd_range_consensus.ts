import { medianValid, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function directionalPositionOf(entry: PairCandidate): number | null {
    const value = entry.feat_entryRangePosition;
    if (value === null || (entry.direction !== "long" && entry.direction !== "short")) return null;
    return entry.direction === "long" ? value : 100 - value;
}

export const crowd_range_consensus: PairSelectionRule = {
    key: "crowd_range_consensus",
    name: "CROWD_RANGE_CONSENSUS",
    description: "Targets a directional close-location offset from the event median.",
    defaultParams: { targetConsensusOffsetPct: 0 },
    paramLabels: { targetConsensusOffsetPct: "Target consensus offset (%)" },
    score: (candidate, _event, params, pool) => {
        const directionalPosition = directionalPositionOf(candidate);
        if (directionalPosition === null) return Number.NEGATIVE_INFINITY;
        const eventMedian = memoByPool(pool, "consensus-median", () => medianValid(pool, directionalPositionOf));
        if (eventMedian === null) return Number.NEGATIVE_INFINITY;
        return -Math.abs(directionalPosition - eventMedian - params.targetConsensusOffsetPct!);
    },
};
