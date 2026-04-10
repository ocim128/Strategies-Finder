import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeRocWhipsawTrapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        roc_lookback: Math.max(2, Math.round(params.roc_lookback ?? 14)),
        roc_z_extreme: Math.max(0, Number(params.roc_z_extreme ?? 2.5))
    };
}

export const roc_whipsaw_trap: Strategy = {
    name: "ROC Whipsaw Trap",
    description: "A rapid one-bar flip from extreme positive momentum to extreme negative momentum captures the 'deer in headlights' shock that forces human capitulation.",
    defaultParams: {
        roc_lookback: 14,
        roc_z_extreme: 2.5
    },
    paramLabels: {
        roc_lookback: "ROC Lookback",
        roc_z_extreme: "ROC Z-Score Extreme Threshold"
    },
    normalizeParams: normalizeRocWhipsawTrapParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRocWhipsawTrapParams(params);
        const lookback = p.roc_lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, 1);
        const rocValues = roc.map(x => x ?? 0);
        const rocZScore = buildRollingZScore(rocValues, lookback);

        return createSignalLoop(cleanData, [rocZScore], (i) => {
            if (i < lookback + 1) return null;
            const prevZ = rocZScore[i - 1];
            const currZ = rocZScore[i];
            if (prevZ === null || currZ === null) return null;

            const extreme = p.roc_z_extreme as number;

            if (prevZ < -extreme && currZ > extreme) {
                return createBuySignal(cleanData, i, `ROC Z-Score flipped from < ${-extreme} to > ${extreme}`);
            }
            if (prevZ > extreme && currZ < -extreme) {
                return createSellSignal(cleanData, i, `ROC Z-Score flipped from > ${extreme} to < ${-extreme}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["roc_lookback", "roc_z_extreme"]
    }
};
