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
        min_age: Math.max(2, Math.floor(Number(params.min_age ?? 10))),
    };
}

export const extreme_age_perimeter_knock_breakout: Strategy = {
    name: "Extreme Age Perimeter Knock Breakout",
    description: "Enters pre-breakout compression when price knocks against an ancient unrefreshed extreme with pinned perimeter close location.",
    defaultParams: {
        min_age: 10,
    },
    paramLabels: {
        min_age: "Minimum Boundary Age",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minAge = Number(params.min_age);

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, clsLoc], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const loc = clsLoc[i];
            if (loc === null) return null;

            if (sh !== null && sh >= minAge && loc >= 0.90 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish perimeter knock breakout: sinceHigh=${sh}>=${minAge}, closeLoc=${loc.toFixed(2)}>=0.90`);
            }
            if (sl !== null && sl >= minAge && loc <= 0.10 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish perimeter knock breakout: sinceLow=${sl}>=${minAge}, closeLoc=${loc.toFixed(2)}<=0.10`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_age"],
    },
};
