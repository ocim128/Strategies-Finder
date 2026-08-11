import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingAverage } from "./price-action-frequency-core";

const ACCEPTANCE_BAND = 0.25;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 10))),
    };
}

export const acceptance_bias_drift: Strategy = {
    name: "Acceptance Bias Drift",
    description: "Rides windows where the smoothed signed close-acceptance mean becomes decisively one-sided, on band-cross edges.",
    defaultParams: {
        lookback: 10,
    },
    paramLabels: {
        lookback: "Smoothing Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const acceptanceMean = buildRollingAverage(acceptance, lookback);

        return createSignalLoop(cleanData, [acceptanceMean], (i) => {
            const prev = acceptanceMean[i - 1];
            const curr = acceptanceMean[i];
            if (prev === null || curr === null) return null;

            // Acceptance mean crosses above the positive band.
            if (prev <= ACCEPTANCE_BAND && curr > ACCEPTANCE_BAND) {
                return createBuySignal(cleanData, i, `Acceptance drift buy: mean ${curr.toFixed(3)} crossed above band`);
            }
            // Acceptance mean crosses below the negative band.
            if (prev >= -ACCEPTANCE_BAND && curr < -ACCEPTANCE_BAND) {
                return createSellSignal(cleanData, i, `Acceptance drift sell: mean ${curr.toFixed(3)} crossed below band`);
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
