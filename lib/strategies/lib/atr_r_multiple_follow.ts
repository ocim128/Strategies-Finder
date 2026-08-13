import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";

const IMPULSE_R_MULTIPLE = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const atr_r_multiple_follow: Strategy = {
    name: "ATR R-Multiple Follow",
    description: "Follows single-bar moves of 2+ prior-ATR, trading impulse magnitude in volatility units.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "ATR Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            // Scale the single-bar move by the PRIOR bar's ATR, which is known at bar i.
            const priorAtr = atr[i - 1];
            if (priorAtr === null || priorAtr === 0) return null;

            const r = (closes[i] - closes[i - 1]) / priorAtr;
            if (r >= IMPULSE_R_MULTIPLE) {
                return createBuySignal(cleanData, i, `Impulse ${r.toFixed(2)} ATR up`);
            }
            if (r <= -IMPULSE_R_MULTIPLE) {
                return createSellSignal(cleanData, i, `Impulse ${(-r).toFixed(2)} ATR down`);
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
