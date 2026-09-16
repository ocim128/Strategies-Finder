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
    buildOpenLocationSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 20))),
    };
}

export const extreme_age_marubozu_fresh_thrust: Strategy = {
    name: "Extreme Age Marubozu Fresh Thrust",
    description: "Enters fresh extreme momentum when a brand new high or low is printed by a full unidirectional marubozu expansion bar.",
    defaultParams: {
        lookback: 20,
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
        const openLoc = buildOpenLocationSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, openLoc, clsLoc], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            const oLoc = openLoc[i];
            const cLoc = clsLoc[i];
            if (oLoc === null || cLoc === null) return null;

            if (sh !== null && sh === 0 && oLoc <= 0.20 && cLoc >= 0.80) {
                return createBuySignal(cleanData, i, `Bullish marubozu fresh high: sinceHigh=0, openLoc=${oLoc.toFixed(2)}<=0.20, closeLoc=${cLoc.toFixed(2)}>=0.80`);
            }
            if (sl !== null && sl === 0 && oLoc >= 0.80 && cLoc <= 0.20) {
                return createSellSignal(cleanData, i, `Bearish marubozu fresh low: sinceLow=0, openLoc=${oLoc.toFixed(2)}>=0.80, closeLoc=${cLoc.toFixed(2)}<=0.20`);
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
