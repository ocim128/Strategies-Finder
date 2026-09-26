import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildExtremeAgeSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_age: Math.max(1, Math.round(Number(params.min_age ?? 13))),
    };
}

export const extreme_age_consolidation_decay_fade: Strategy = {
    name: "Extreme Age Consolidation Decay Fade",
    description: "Fades boundary perimeter touches when simultaneous staleness of both extremes indicates deep equilibrium.",
    defaultParams: {
        min_age: 13,
    },
    paramLabels: {
        min_age: "Min Age",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minAge = p.min_age as number;
        if (cleanData.length < 24) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [closeLocation], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const cl = closeLocation[i];
            if (sh === null || sl === null || cl === null) return null;

            // Deep equilibrium: both extremes are stale (>= minAge)
            if (sh >= minAge && sl >= minAge) {
                if (cl <= 0.20) {
                    return createBuySignal(cleanData, i, `Bullish equilibrium fade: sinceHigh ${sh}, sinceLow ${sl} >= ${minAge}, closeLocation ${cl.toFixed(2)} <= 0.20`);
                }
                if (cl >= 0.80) {
                    return createSellSignal(cleanData, i, `Bearish equilibrium fade: sinceHigh ${sh}, sinceLow ${sl} >= ${minAge}, closeLocation ${cl.toFixed(2)} >= 0.80`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_age"],
    },
};
