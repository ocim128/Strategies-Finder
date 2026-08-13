import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildRateOfChange } from "./price-action-statistics-core";

const GROWTH_GATE = 0.5;
const LEVEL_GATE = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 12))),
    };
}

export const body_size_acceleration: Strategy = {
    name: "Body Size Acceleration",
    description: "Continues direction when body conviction has grown sharply over the window and the bar is still large.",
    defaultParams: {
        lookback: 12,
    },
    paramLabels: {
        lookback: "Growth Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const growth = buildRateOfChange(bodyPct, lookback);

        return createSignalLoop(cleanData, [growth], (i) => {
            const g = growth[i];
            if (g === null || g < GROWTH_GATE) return null;

            const level = bodyPct[i];
            if (level < LEVEL_GATE) return null;

            if (cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Body conviction growing: roc ${g.toFixed(2)}, body ${level.toFixed(2)}`);
            }
            if (cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Body conviction growing: roc ${g.toFixed(2)}, body ${level.toFixed(2)}`);
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
