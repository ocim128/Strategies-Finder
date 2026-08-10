import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingBandEdgeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        bandLookback: Math.max(10, Math.round(Number(params.bandLookback ?? 40))),
    };
}

export const trailing_band_edge_fade: Strategy = {
    name: "Trailing Band Edge Fade",
    description: "Fades closes that touch the prior-only trailing band edge while the bar also closes at its own edge.",
    defaultParams: {
        bandLookback: 40,
    },
    paramLabels: {
        bandLookback: "Band Lookback",
    },
    normalizeParams: normalizeTrailingBandEdgeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingBandEdgeFadeParams(params);
        const bandLookback = p.bandLookback as number;
        if (cleanData.length < bandLookback + 1) return [];

        const closes = getCloses(cleanData);
        const channel = buildTrailingHighLow(cleanData, bandLookback, false);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < bandLookback) return null;
            const lowest = channel.lowest[i];
            const highest = channel.highest[i];
            if (lowest === null || highest === null || highest <= lowest) return null;

            const bandPosition = (closes[i] - lowest) / (highest - lowest);
            if (bandPosition <= 0.2 && closeLocation[i] <= 0.35) {
                return createBuySignal(cleanData, i, `Close at ${bandPosition.toFixed(2)} of the trailing band with lower placement ${closeLocation[i].toFixed(2)}`);
            }
            if (bandPosition >= 0.8 && closeLocation[i] >= 0.65) {
                return createSellSignal(cleanData, i, `Close at ${bandPosition.toFixed(2)} of the trailing band with upper placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bandLookback"],
    },
};
