import type { PairSelectionRule } from "./types";

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic floor: pair first, then direction. */
export const reference_alphabetical: PairSelectionRule = {
    key: "reference_alphabetical",
    name: "REFERENCE_ALPHABETICAL",
    description: "Selects the first candidate by pair, then direction.",
    defaultParams: {},
    paramLabels: {},
    score: () => 0,
    tieBreak(left, right) {
        return compareText(left.pair, right.pair) || compareText(left.direction, right.direction);
    },
};

/** Fixed reference: the candidate with the highest signal-bar ATR percentage. */
export const reference_loudest_atr: PairSelectionRule = {
    key: "reference_loudest_atr",
    name: "REFERENCE_LOUDEST_ATR",
    description: "Selects the candidate with the highest feat_atrPct.",
    defaultParams: {},
    paramLabels: {},
    score: (candidate) => candidate.feat_atrPct ?? Number.NEGATIVE_INFINITY,
};
