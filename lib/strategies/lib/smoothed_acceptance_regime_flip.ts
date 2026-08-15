import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeSmoothedAcceptanceRegimeFlipParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 6))),
    };
}

export const smoothed_acceptance_regime_flip: Strategy = {
    name: "Smoothed Acceptance Regime Flip",
    description: "Enters when a short rolling average of close acceptance flips sign, with raw acceptance agreeing on the new side.",
    defaultParams: {
        lookback: 6,
    },
    paramLabels: {
        lookback: "Smoothing Window",
    },
    normalizeParams: normalizeSmoothedAcceptanceRegimeFlipParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeSmoothedAcceptanceRegimeFlipParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const smoothed = buildRollingAverage(acceptance, lookback);

        return createSignalLoop(cleanData, [smoothed], (i) => {
            if (i < lookback) return null;
            const smoothPrev = smoothed[i - 1];
            const smoothNow = smoothed[i];
            if (smoothPrev === null || smoothNow === null) return null;

            if (smoothPrev <= 0 && smoothNow > 0 && acceptance[i] > 0) {
                return createBuySignal(cleanData, i, `Acceptance regime flip buy: smoothed ${smoothPrev.toFixed(3)} to ${smoothNow.toFixed(3)}`);
            }
            if (smoothPrev >= 0 && smoothNow < 0 && acceptance[i] < 0) {
                return createSellSignal(cleanData, i, `Acceptance regime flip sell: smoothed ${smoothPrev.toFixed(3)} to ${smoothNow.toFixed(3)}`);
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
