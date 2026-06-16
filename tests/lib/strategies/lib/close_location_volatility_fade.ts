import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        sdMin: Math.max(0, Number(params.sdMin ?? 0.15)),
    };
}

export const close_location_volatility_fade: Strategy = {
    name: "Close Location Volatility Fade",
    description: "Fades extreme close locations when high volatility of close locations confirms an oscillation regime.",
    defaultParams: {
        lookback: 20,
        sdMin: 0.15,
    },
    paramLabels: {
        lookback: "Lookback Window",
        sdMin: "Min Close Location SD",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const clStdDev = buildRollingStdDev(closeLocation, lookback);

        return createSignalLoop(cleanData, [clStdDev], (i) => {
            const sd = clStdDev[i];
            if (sd === null) return null;

            const cl = closeLocation[i];

            if (sd > p.sdMin) {
                // Buy: oscillation regime and close is at the bottom
                if (cl < 0.25) {
                    return createBuySignal(cleanData, i, `Close location volatility fade buy: CL ${cl.toFixed(2)} with SD ${sd.toFixed(2)}`);
                }
                // Sell: oscillation regime and close is at the top
                if (cl > 0.75) {
                    return createSellSignal(cleanData, i, `Close location volatility fade sell: CL ${cl.toFixed(2)} with SD ${sd.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "sdMin"],
    },
};
