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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const extreme_age_high_shelf_consolidation_thrust: Strategy = {
    name: "Extreme Age High Shelf Consolidation Thrust",
    description: "Enters momentum breakouts after a fresh extreme forms an inside consolidation shelf pressed against the boundary.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Window Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [clsLoc], (i) => {
            if (i < 1) return null;

            const cl = clsLoc[i];
            if (cl === null) return null;

            const prior = cleanData[i - 1];
            const current = cleanData[i];
            const priorRange = prior.high - prior.low;
            if (priorRange <= 0) return null;

            // Buy: fresh trailing high at i-1, current bar holds inside high shelf (low in upper 60%), strong closeLocation
            if (
                sinceHigh[i - 1] === 0 &&
                current.high <= prior.high &&
                current.low >= prior.low + priorRange * 0.40 &&
                cl >= 0.70
            ) {
                return createBuySignal(cleanData, i, `Bullish high shelf consolidation: fresh high at i-1, inside shelf low >= 40% range, closeLocation ${cl.toFixed(2)} >= 0.70`);
            }

            // Sell: fresh trailing low at i-1, current bar holds inside low shelf (high in lower 60%), weak closeLocation
            if (
                sinceLow[i - 1] === 0 &&
                current.low >= prior.low &&
                current.high <= prior.high - priorRange * 0.40 &&
                cl <= 0.30
            ) {
                return createSellSignal(cleanData, i, `Bearish low shelf consolidation: fresh low at i-1, inside shelf high <= 60% range, closeLocation ${cl.toFixed(2)} <= 0.30`);
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
