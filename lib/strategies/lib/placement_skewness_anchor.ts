import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

const SKEW_GATE = 0.4;
const HIGH_PLACEMENT = 0.6;
const LOW_PLACEMENT = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const placement_skewness_anchor: Strategy = {
    name: "Placement Skewness Anchor",
    description: "Trades with the tail of the close-location distribution when the current bar confirms it.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Skewness Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const location = buildCloseLocationSeries(cleanData);
        const skew = buildRollingSkewness(location, lookback);

        return createSignalLoop(cleanData, [skew], (i) => {
            const s = skew[i];
            if (s === null) return null;

            if (s >= SKEW_GATE && location[i] >= HIGH_PLACEMENT) {
                return createBuySignal(cleanData, i, `Placement tail up: skew ${s.toFixed(2)}`);
            }
            if (s <= -SKEW_GATE && location[i] <= LOW_PLACEMENT) {
                return createSellSignal(cleanData, i, `Placement tail down: skew ${s.toFixed(2)}`);
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
