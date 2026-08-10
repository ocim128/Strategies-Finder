import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizePlacementSkewAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const placement_skew_alignment: Strategy = {
    name: "Placement Skew Alignment",
    description: "Aligns with the dominant intra-bar close placement when the rolling skewness of close location is extreme.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizePlacementSkewAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePlacementSkewAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const skewness = buildRollingSkewness(closeLocation, lookback);

        return createSignalLoop(cleanData, [skewness], (i) => {
            if (i < lookback) return null;
            const skew = skewness[i];
            if (skew === null) return null;

            if (skew < -0.8 && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Negative close-location skew ${skew.toFixed(2)} with upper placement ${closeLocation[i].toFixed(2)}`);
            }
            if (skew > 0.8 && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `Positive close-location skew ${skew.toFixed(2)} with lower placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
