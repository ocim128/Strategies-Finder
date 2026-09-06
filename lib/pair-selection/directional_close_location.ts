import { type PairSelectionRule } from "./types";

export const directional_close_location: PairSelectionRule = {
    key: "directional_close_location",
    name: "DIRECTIONAL_CLOSE_LOCATION",
    description: "Targets a direction-aligned signal-bar close location.",
    defaultParams: { targetDirectionalClosePct: 75 },
    paramLabels: { targetDirectionalClosePct: "Target directional close (%)" },
    score: (candidate, _event, params) => {
        const position = candidate.feat_entryRangePosition;
        if (position === null || (candidate.direction !== "long" && candidate.direction !== "short")) {
            return Number.NEGATIVE_INFINITY;
        }
        const directionalPosition = candidate.direction === "long" ? position : 100 - position;
        return -Math.abs(directionalPosition - params.targetDirectionalClosePct!);
    },
};
