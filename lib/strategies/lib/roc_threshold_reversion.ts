import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

const ROC_BAND = 0.05;

function normalizeRocThresholdReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const roc_threshold_reversion: Strategy = {
    name: "ROC Threshold Reversion",
    description: "Fades lookback close rates of change beyond a fixed fractional band, the simplest portable multi-bar overextension read.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRocThresholdReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeRocThresholdReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [roc], (i) => {
            if (i < lookback) return null;
            const rate = roc[i];
            if (rate === null) return null;

            if (rate < -ROC_BAND) {
                return createBuySignal(cleanData, i, `ROC reversion buy: ${lookback}-bar return ${(rate * 100).toFixed(2)}% below ${-ROC_BAND * 100}%`);
            }
            if (rate > ROC_BAND) {
                return createSellSignal(cleanData, i, `ROC reversion sell: ${lookback}-bar return ${(rate * 100).toFixed(2)}% above ${ROC_BAND * 100}%`);
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
