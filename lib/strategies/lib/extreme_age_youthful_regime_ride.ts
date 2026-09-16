import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        max_age: Math.max(1, Math.round(Number(params.max_age ?? 4))),
    };
}

export const extreme_age_youthful_regime_ride: Strategy = {
    name: "Extreme Age Youthful Regime Ride",
    description: "Rides strong trends by using youthful extreme age (since extreme <= max_age) to gate trend-following bar entries.",
    defaultParams: {
        max_age: 4,
    },
    paramLabels: {
        max_age: "Max Age",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const max_age = p.max_age as number;
        if (cleanData.length < 24) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            const sH = sinceHigh[i];
            const sL = sinceLow[i];

            if (sH !== null && sH <= max_age && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish youthful ride: since high ${sH} <= ${max_age}, bull close > open`);
            }
            if (sL !== null && sL <= max_age && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish youthful ride: since low ${sL} <= ${max_age}, bear close < open`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_age"],
    },
};
