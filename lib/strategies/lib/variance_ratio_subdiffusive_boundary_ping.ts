import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 32))),
    };
}

export const variance_ratio_subdiffusive_boundary_ping: Strategy = {
    name: "Variance Ratio Subdiffusive Boundary Ping",
    description: "Fades bar perimeter touches when the Variance Ratio confirms a statistically subdiffusive mean-reverting regime.",
    defaultParams: {
        lookback: 32,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, lookback, 4);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vr, clsLoc], (i) => {
            const v = vr[i];
            const loc = clsLoc[i];
            if (v === null || loc === null) return null;

            if (v <= 0.75) {
                if (loc <= 0.15) {
                    return createBuySignal(cleanData, i, `Bullish subdiffusive boundary ping: VR ${v.toFixed(3)} <= 0.75, close location ${loc.toFixed(3)} <= 0.15`);
                }
                if (loc >= 0.85) {
                    return createSellSignal(cleanData, i, `Bearish subdiffusive boundary ping: VR ${v.toFixed(3)} <= 0.75, close location ${loc.toFixed(3)} >= 0.85`);
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
