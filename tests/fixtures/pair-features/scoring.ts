import type { PairCandidate } from "../../../lib/pair-selection/types";

export function scoreByFeature(candidate: PairCandidate, featureId: string): number {
    return candidate[featureId as keyof PairCandidate] as number ?? Number.NEGATIVE_INFINITY;
}
