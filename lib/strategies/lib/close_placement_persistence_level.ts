import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";

const UPPER_BAND = 0.6;
const LOWER_BAND = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const close_placement_persistence_level: Strategy = {
    name: "Close Placement Persistence Level",
    description: "Continues when the rolling average of close location holds a persistent upper- or lower-half level.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const placementLevel = buildRollingAverage(closeLocation, lookback);

        return createSignalLoop(cleanData, [placementLevel], (i) => {
            const level = placementLevel[i];
            if (level === null) return null;

            if (level > UPPER_BAND) {
                return createBuySignal(cleanData, i, `Persistent upper-half closes: ${level.toFixed(2)}`);
            }
            if (level < LOWER_BAND) {
                return createSellSignal(cleanData, i, `Persistent lower-half closes: ${level.toFixed(2)}`);
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
