import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    normalizeLookbackParams as normalizeParams,
} from "../strategy-helpers";
import { calculateDonchianMidpoint } from "../trend-confirmation-indicators";

export const donchian_midpoint_confirmation: Strategy = {
    name: "Donchian Midpoint Confirmation",
    description: "Confirms direction relative to the midpoint of the trailing high-low price channel.",
    defaultParams: {
        lookback: 200,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        const closes = getCloses(cleanData);
        const midpoint = calculateDonchianMidpoint(getHighs(cleanData), getLows(cleanData), lookback);

        return createCurrentBarSignalLoop(cleanData, [midpoint], (i) => {
            if (closes[i] > midpoint[i]!) return createBuySignal(cleanData, i, "Close above Donchian midpoint");
            if (closes[i] < midpoint[i]!) return createSellSignal(cleanData, i, "Close below Donchian midpoint");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
