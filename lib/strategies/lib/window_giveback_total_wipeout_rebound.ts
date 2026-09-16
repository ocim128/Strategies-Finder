import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 24))),
    };
}

export const window_giveback_total_wipeout_rebound: Strategy = {
    name: "Window Giveback Total Wipeout Rebound",
    description: "Enters origin defense rebound when a full 100% excursion wipeout holds at the structural start of the window.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [gb, clsLoc], (i) => {
            if (i < lookback) return null;
            const g = gb[i];
            const loc = clsLoc[i];
            if (g === null || loc === null) return null;

            if (g >= 0.98) {
                if (closes[i] >= closes[i - lookback] && loc >= 0.70) {
                    return createBuySignal(cleanData, i, `Bullish total wipeout rebound: giveback=${g.toFixed(2)}>=0.98, closeLoc=${loc.toFixed(2)}>=0.70, origin held`);
                }
                if (closes[i] < closes[i - lookback] && loc <= 0.30) {
                    return createSellSignal(cleanData, i, `Bearish total wipeout rebound: giveback=${g.toFixed(2)}>=0.98, closeLoc=${loc.toFixed(2)}<=0.30, origin held`);
                }
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
