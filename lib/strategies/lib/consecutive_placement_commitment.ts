import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeConsecutivePlacementCommitmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        placementBand: Math.max(0.55, Math.min(0.95, Number(params.placementBand ?? 0.75))),
    };
}

export const consecutive_placement_commitment: Strategy = {
    name: "Consecutive Placement Commitment",
    description: "Follows two consecutive bars closing in the same extreme band of their own ranges as a committed placement regime.",
    defaultParams: {
        placementBand: 0.75,
    },
    paramLabels: {
        placementBand: "Placement Band",
    },
    normalizeParams: normalizeConsecutivePlacementCommitmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeConsecutivePlacementCommitmentParams(params);
        const placementBand = p.placementBand as number;
        if (cleanData.length < 2) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (closeLocation[i] > placementBand && closeLocation[i - 1] > placementBand) {
                return createBuySignal(cleanData, i, `Consecutive upper-band closes ${closeLocation[i - 1].toFixed(2)}, ${closeLocation[i].toFixed(2)} above ${placementBand}`);
            }
            if (closeLocation[i] < 1 - placementBand && closeLocation[i - 1] < 1 - placementBand) {
                return createSellSignal(cleanData, i, `Consecutive lower-band closes ${closeLocation[i - 1].toFixed(2)}, ${closeLocation[i].toFixed(2)} below ${(1 - placementBand).toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["placementBand"],
    },
};
