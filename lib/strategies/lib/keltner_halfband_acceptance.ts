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
import { calculateKeltnerChannels } from "../indicators";

function normalizeKeltnerHalfbandAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 30))),
        multiplier: Math.max(0.01, Number(params.multiplier ?? 1.5)),
        halfband_frac: Math.max(0, Math.min(1, Number(params.halfband_frac ?? 0.5))),
    };
}

export const keltner_halfband_acceptance: Strategy = {
    name: "Keltner Halfband Acceptance",
    description:
        "Uses a Keltner envelope as a volatility-adjusted value band and enters when settlement is accepted in the outer bullish or bearish half of that same-bar channel.",
    defaultParams: {
        period: 30,
        multiplier: 1.5,
        halfband_frac: 0.5,
    },
    paramLabels: {
        period: "Period",
        multiplier: "Multiplier",
        halfband_frac: "Halfband Fraction",
    },
    normalizeParams: normalizeKeltnerHalfbandAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKeltnerHalfbandAcceptanceParams(params);
        const period = p.period as number;
        if (cleanData.length < period) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const channels = calculateKeltnerChannels(highs, lows, closes, period, period, p.multiplier as number);

        return createSignalLoop(cleanData, [channels.upper, channels.middle, channels.lower], (i) => {
            if (i < period - 1) return null;

            const upper = channels.upper[i];
            const middle = channels.middle[i];
            const lower = channels.lower[i];
            if (upper === null || middle === null || lower === null) return null;

            const upperThreshold = middle + (p.halfband_frac as number) * (upper - middle);
            const lowerThreshold = middle - (p.halfband_frac as number) * (middle - lower);

            if (closes[i] > upperThreshold) {
                return createBuySignal(cleanData, i, "Close accepted in bullish Keltner halfband");
            }
            if (closes[i] < lowerThreshold) {
                return createSellSignal(cleanData, i, "Close accepted in bearish Keltner halfband");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period", "multiplier", "halfband_frac"],
    },
};





