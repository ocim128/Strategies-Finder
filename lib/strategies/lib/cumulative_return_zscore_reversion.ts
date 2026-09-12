import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.2)),
    };
}

export const cumulative_return_zscore_reversion: Strategy = {
    name: "Cumulative Return Z-Score Reversion",
    description: "Fades cumulative multi-bar returns when they reach extreme z-scores.",
    defaultParams: {
        lookback: 20,
        zThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        // Rate of change over lookback period (multi-bar cumulative return)
        const roc = buildRateOfChange(closes, lookback);
        const rocNumbers = roc.map((v) => (v !== null ? v : 0));
        const rocZ = buildRollingZScore(rocNumbers, lookback);

        return createSignalLoop(cleanData, [rocZ], (i) => {
            const z = rocZ[i];
            if (z === null) return null;

            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Cumulative return reversion buy: Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Cumulative return reversion sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
