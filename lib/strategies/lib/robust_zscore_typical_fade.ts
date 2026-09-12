import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const ROBUST_Z_BAND = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const robust_zscore_typical_fade: Strategy = {
    name: "Robust Z-Score Typical Fade",
    description: "Fades typical-price extremes standardized by their own rolling median and MAD instead of mean and standard deviation.",
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

        const z = buildRollingRobustZScore(getTypicalPrices(cleanData), lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            const zNow = z[i];
            if (zNow === null) return null;

            if (zNow <= -ROBUST_Z_BAND) {
                return createBuySignal(cleanData, i, `Robust typical fade buy: typical z ${zNow.toFixed(2)} below robust center`);
            }
            if (zNow >= ROBUST_Z_BAND) {
                return createSellSignal(cleanData, i, `Robust typical fade sell: typical z ${zNow.toFixed(2)} above robust center`);
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
