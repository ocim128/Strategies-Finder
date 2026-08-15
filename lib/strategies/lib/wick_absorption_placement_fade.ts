import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const PLACEMENT_LOW_BAND = 0.2;
const PLACEMENT_HIGH_BAND = 0.8;
const WICK_EXTREME_BAND = 0.9;

function normalizeWickAbsorptionPlacementFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const wick_absorption_placement_fade: Strategy = {
    name: "Wick Absorption Placement Fade",
    description: "Fades closes pinned at an extreme placement when the same-side wick sits at an extreme percentile, reading an absorbed push.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWickAbsorptionPlacementFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeWickAbsorptionPlacementFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const upperWick = cleanData.map((bar) => computePriceActionBarMetrics(bar).upperWick);
        const lowerWick = cleanData.map((bar) => computePriceActionBarMetrics(bar).lowerWick);
        const upperPct = buildPercentileRank(upperWick, lookback);
        const lowerPct = buildPercentileRank(lowerWick, lookback);

        return createSignalLoop(cleanData, [upperPct, lowerPct], (i) => {
            if (i < lookback) return null;
            const upperRank = upperPct[i];
            const lowerRank = lowerPct[i];
            if (upperRank === null || lowerRank === null) return null;

            if (closeLocation[i] < PLACEMENT_LOW_BAND && lowerRank > WICK_EXTREME_BAND) {
                return createBuySignal(cleanData, i, `Wick absorption buy: close location ${closeLocation[i].toFixed(2)}, lower wick rank ${lowerRank.toFixed(2)}`);
            }
            if (closeLocation[i] > PLACEMENT_HIGH_BAND && upperRank > WICK_EXTREME_BAND) {
                return createSellSignal(cleanData, i, `Wick absorption sell: close location ${closeLocation[i].toFixed(2)}, upper wick rank ${upperRank.toFixed(2)}`);
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
