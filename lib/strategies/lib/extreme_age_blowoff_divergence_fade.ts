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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 35))),
    };
}

export const extreme_age_blowoff_divergence_fade: Strategy = {
    name: "Extreme Age Blowoff Divergence Fade",
    description: "Fades climax moves exhibiting severe age asymmetry between fresh extreme and stale opposite boundary.",
    defaultParams: {
        lookback: 35,
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
        const clsLoc = buildCloseLocationSeries(cleanData);
        const staleThreshold = Math.round(lookback * 0.80);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, clsLoc], (i) => {
            const sH = sinceHigh[i];
            const sL = sinceLow[i];
            const loc = clsLoc[i];
            if (sH === null || sL === null || loc === null) return null;

            if (sL === 0 && sH >= staleThreshold && loc >= 0.70) {
                return createBuySignal(cleanData, i, `Bullish blowoff divergence fade: fresh low (0) with stale high (${sH} >= ${staleThreshold}) and strong close location ${loc.toFixed(3)} >= 0.70`);
            }
            if (sH === 0 && sL >= staleThreshold && loc <= 0.30) {
                return createSellSignal(cleanData, i, `Bearish blowoff divergence fade: fresh high (0) with stale low (${sL} >= ${staleThreshold}) and weak close location ${loc.toFixed(3)} <= 0.30`);
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
