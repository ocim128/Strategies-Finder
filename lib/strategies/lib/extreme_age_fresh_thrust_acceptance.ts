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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 28))),
    };
}

export const extreme_age_fresh_thrust_acceptance: Strategy = {
    name: "Extreme Age Fresh Thrust Acceptance",
    description: "Confirms breakout continuation when a freshly minted extreme (age <= 1) is immediately verified by strong close location.",
    defaultParams: {
        lookback: 28,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [closeLocation], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const cl = closeLocation[i];
            if (sh === null || sl === null || cl === null) return null;

            // Buy: Fresh high (age <= 1), strong closeLocation >= 0.70, bull bar
            if (sh <= 1 && cl >= 0.70 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish fresh thrust acceptance: sinceHigh ${sh} <= 1, closeLocation ${cl.toFixed(2)} >= 0.70, bull close`);
            }

            // Sell: Fresh low (age <= 1), weak closeLocation <= 0.20, bear bar
            if (sl <= 1 && cl <= 0.20 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish fresh thrust acceptance: sinceLow ${sl} <= 1, closeLocation ${cl.toFixed(2)} <= 0.20, bear close`);
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
