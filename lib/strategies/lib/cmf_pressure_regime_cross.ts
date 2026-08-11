import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";

const NEUTRAL_BAND = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(5, Math.round(Number(params.period ?? 20))),
    };
}

export const cmf_pressure_regime_cross: Strategy = {
    name: "CMF Pressure Regime Cross",
    description: "Enters when Chaikin Money Flow pressure crosses out of its neutral band, treating the cross as a regime change.",
    defaultParams: {
        period: 20,
    },
    paramLabels: {
        period: "CMF Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.period as number;
        if (cleanData.length < period) return [];

        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), getVolumes(cleanData), period);

        return createSignalLoop(cleanData, [cmf], (i) => {
            const prev = cmf[i - 1];
            const curr = cmf[i];
            if (prev === null || curr === null) return null;

            // Pressure exits neutral upward.
            if (prev <= NEUTRAL_BAND && curr > NEUTRAL_BAND) {
                return createBuySignal(cleanData, i, `CMF pressure cross buy: ${curr.toFixed(3)} exited neutral upward`);
            }
            // Pressure exits neutral downward.
            if (prev >= -NEUTRAL_BAND && curr < -NEUTRAL_BAND) {
                return createSellSignal(cleanData, i, `CMF pressure cross sell: ${curr.toFixed(3)} exited neutral downward`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
