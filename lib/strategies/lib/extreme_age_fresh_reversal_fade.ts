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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const extreme_age_fresh_reversal_fade: Strategy = {
    name: "Extreme Age Fresh Reversal Fade",
    description: "Fades immediate intra-bar failure of freshly minted trailing window extremes.",
    defaultParams: {
        lookback: 20,
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

            // Buy: fresh trailing low printed on current bar (age 0), but close reclaims top 30% of bar
            if (sl === 0 && cl >= 0.70) {
                return createBuySignal(cleanData, i, `Bullish fresh low fade: sinceLow 0, closeLocation ${cl.toFixed(2)} >= 0.70`);
            }

            // Sell: fresh trailing high printed on current bar (age 0), but close rejects to bottom 30% of bar
            if (sh === 0 && cl <= 0.30) {
                return createSellSignal(cleanData, i, `Bearish fresh high fade: sinceHigh 0, closeLocation ${cl.toFixed(2)} <= 0.30`);
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
