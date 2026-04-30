import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";

function normalizeDonchianExtremeRejectionFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))),
    };
}

export const donchian_extreme_rejection_fade: Strategy = {
    name: "Donchian Extreme Rejection Fade",
    description:
        "Fades failed breaks of the prior Donchian boundary when price tags a multi-bar extreme but settles back inside the previous channel.",
    defaultParams: {
        lookback: 55,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeDonchianExtremeRejectionFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDonchianExtremeRejectionFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const channels = calculateDonchianChannels(highs, lows, lookback);

        return createSignalLoop(cleanData, [channels.upper, channels.lower], (i) => {
            const prevUpper = channels.upper[i - 1];
            const prevLower = channels.lower[i - 1];
            if (prevUpper === null || prevLower === null) return null;

            const bar = cleanData[i];
            if (bar.low <= prevLower && bar.close > prevLower && bar.close < prevUpper) {
                return createBuySignal(cleanData, i, "Lower Donchian boundary rejection");
            }
            if (bar.high >= prevUpper && bar.close < prevUpper && bar.close > prevLower) {
                return createSellSignal(cleanData, i, "Upper Donchian boundary rejection");
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
