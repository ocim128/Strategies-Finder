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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 22))),
    };
}

export const extreme_age_body_surge_breakout: Strategy = {
    name: "Extreme Age Body Surge Breakout",
    description: "Enters breakout continuation when a fresh extreme is accompanied by a 3x candle body expansion.",
    defaultParams: {
        lookback: 22,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const sh = sinceHigh[i];
            const sl = sinceLow[i];

            const prevBody = Math.abs(cleanData[i - 1].close - cleanData[i - 1].open);

            if (
                sh !== null &&
                sh === 0 &&
                cleanData[i].close > cleanData[i].open &&
                (cleanData[i].close - cleanData[i].open) >= 3.0 * prevBody
            ) {
                return createBuySignal(cleanData, i, `Bullish fresh extreme body surge: sinceHigh=0, body >= 3x prior body`);
            }

            if (
                sl !== null &&
                sl === 0 &&
                cleanData[i].close < cleanData[i].open &&
                (cleanData[i].open - cleanData[i].close) >= 3.0 * prevBody
            ) {
                return createSellSignal(cleanData, i, `Bearish fresh extreme body surge: sinceLow=0, body >= 3x prior body`);
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
