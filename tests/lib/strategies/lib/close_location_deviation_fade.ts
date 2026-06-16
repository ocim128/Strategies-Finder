import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const close_location_deviation_fade: Strategy = {
    name: "Close Location Deviation Fade",
    description: "Fades ratio moves when the current close location z-score reaches extremes, signaling localized pricing exhaustion.",
    defaultParams: {
        lookback: 25,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const cl = buildCloseLocationSeries(cleanData);
        const clZ = buildRollingZScore(cl, lookback);

        return createSignalLoop(cleanData, [clZ], (i) => {
            const z = clZ[i];
            if (z === null) return null;

            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Close location dev fade buy: close location Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Close location dev fade sell: close location Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
