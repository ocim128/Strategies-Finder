import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";

function normalizeDonchianMidpointCenterlineParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    };
}

export const donchian_midpoint_centerline: Strategy = {
    name: "Donchian Midpoint Centerline",
    description: "The Donchian midpoint is a structural centerline derived from recent extremes instead of averages. Closes above it place price in the upper structural half of the recent range; closes below it place price in the lower half.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeDonchianMidpointCenterlineParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDonchianMidpointCenterlineParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const donchian = calculateDonchianChannels(getHighs(cleanData), getLows(cleanData), lookback);

        return createSignalLoop(cleanData, [donchian.middle], (i) => {
            const midpoint = donchian.middle[i];
            if (midpoint === null) return null;

            if (closes[i] > midpoint) {
                return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} above Donchian midpoint ${midpoint.toFixed(2)}`);
            }
            if (closes[i] < midpoint) {
                return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} below Donchian midpoint ${midpoint.toFixed(2)}`);
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
