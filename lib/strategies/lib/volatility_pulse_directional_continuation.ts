import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const CONTRACTION_Z_BAND = -1.0;
const PULSE_Z_BAND = 1.0;
const PLACEMENT_MID = 0.5;

function normalizeVolatilityPulseDirectionalContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volatility_pulse_directional_continuation: Strategy = {
    name: "Volatility Pulse Directional Continuation",
    description: "Enters the direction of a bar that expands out of a prior true-range contraction with an agreeing directional close.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolatilityPulseDirectionalContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeVolatilityPulseDirectionalContinuationParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const z = buildRollingZScore(trueRange, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [z], (i) => {
            if (i < lookback) return null;
            const prevZ = z[i - 1];
            const currZ = z[i];
            if (prevZ === null || currZ === null) return null;
            const bar = cleanData[i];

            if (prevZ < CONTRACTION_Z_BAND && currZ > PULSE_Z_BAND && bar.close > bar.open && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Volatility pulse buy: prior z ${prevZ.toFixed(2)} contracted, pulse z ${currZ.toFixed(2)} bullish`);
            }
            if (prevZ < CONTRACTION_Z_BAND && currZ > PULSE_Z_BAND && bar.close < bar.open && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Volatility pulse sell: prior z ${prevZ.toFixed(2)} contracted, pulse z ${currZ.toFixed(2)} bearish`);
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
