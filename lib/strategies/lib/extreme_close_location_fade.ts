import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeExtremeCloseLocationFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        closeLocationMin: Math.max(0, Math.min(1, Number(params.closeLocationMin ?? 0.85))),
        closeLocationMax: Math.max(0, Math.min(1, Number(params.closeLocationMax ?? 0.15))),
    };
}

export const extreme_close_location_fade: Strategy = {
    name: "Extreme Close Location Fade",
    description: "Close location mean reversion at bar extremes.",
    defaultParams: {
        closeLocationMin: 0.85,
        closeLocationMax: 0.15,
    },
    paramLabels: {
        closeLocationMin: "Close Location Min",
        closeLocationMax: "Close Location Max",
    },
    normalizeParams: normalizeExtremeCloseLocationFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeExtremeCloseLocationFadeParams(params);
        const closeLocationMin = p.closeLocationMin as number;
        const closeLocationMax = p.closeLocationMax as number;
        if (cleanData.length < 2) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [closeLocation], (i) => {
            const cl = closeLocation[i];
            if (cl === null || cl === undefined) return null;

            if (cl < closeLocationMax) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Close location ${cl.toFixed(2)} below threshold ${closeLocationMax.toFixed(2)} (fade buy)`
                );
            }
            if (cl > closeLocationMin) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Close location ${cl.toFixed(2)} above threshold ${closeLocationMin.toFixed(2)} (fade sell)`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["closeLocationMin", "closeLocationMax"],
    },
};
