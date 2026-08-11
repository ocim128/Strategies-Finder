import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingRobustZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

const DEPTH_BAND = 2;
const REJECTION_IMBALANCE = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const rejection_confirmed_depth_fade: Strategy = {
    name: "Rejection Confirmed Depth Fade",
    description: "Fades robust z-score extremes only when the extreme bar's wick imbalance shows the push was rejected intrabar.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const z = buildRollingRobustZScore(getCloses(cleanData), lookback);
        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");

        return createSignalLoop(cleanData, [z], (i) => {
            const zNow = z[i];
            if (zNow === null) return null;

            // Deep discount with dominant lower-wick rejection.
            if (zNow <= -DEPTH_BAND && wickImbalance[i] >= REJECTION_IMBALANCE) {
                return createBuySignal(cleanData, i, `Rejection buy: z ${zNow.toFixed(2)}, wick imbalance ${wickImbalance[i].toFixed(2)}`);
            }
            // Deep premium with dominant upper-wick rejection.
            if (zNow >= DEPTH_BAND && wickImbalance[i] <= -REJECTION_IMBALANCE) {
                return createSellSignal(cleanData, i, `Rejection sell: z ${zNow.toFixed(2)}, wick imbalance ${wickImbalance[i].toFixed(2)}`);
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
