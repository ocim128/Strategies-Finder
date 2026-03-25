import { getRequiredElement } from "../dom-utils";

export const PAIR_COMBINER_BRIDGE_REQUIRED_IDS = [
    "combinerPrimarySelect",
    "combinerSecondarySelect",
    "combinerMode",
] as const;

export function createPairCombinerBridgeDom() {
    return {
        combinerPrimarySelect: getRequiredElement<HTMLSelectElement>("combinerPrimarySelect"),
        combinerSecondarySelect: getRequiredElement<HTMLSelectElement>("combinerSecondarySelect"),
        combinerMode: getRequiredElement<HTMLSelectElement>("combinerMode"),
    };
}

export type PairCombinerBridgeDom = ReturnType<typeof createPairCombinerBridgeDom>;
