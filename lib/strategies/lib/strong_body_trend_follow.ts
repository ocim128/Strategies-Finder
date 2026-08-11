import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const BODY_CONVICTION = 0.7;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 20))),
    };
}

export const strong_body_trend_follow: Strategy = {
    name: "Strong Body Trend Follow",
    description: "Follows full-bodied conviction bars that agree with the rolling-median trend side.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Trend Median Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const bodyPct = buildBodyPctSeries(cleanData);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median, bodyPct], (i) => {
            const med = median[i];
            const body = bodyPct[i];
            if (med === null || body === null) return null;

            // Conviction bar in the trend's direction.
            if (body >= BODY_CONVICTION && closes[i] > cleanData[i].open && closes[i] > med) {
                return createBuySignal(cleanData, i, `Strong body buy: body ${body.toFixed(2)} up bar above median`);
            }
            if (body >= BODY_CONVICTION && closes[i] < cleanData[i].open && closes[i] < med) {
                return createSellSignal(cleanData, i, `Strong body sell: body ${body.toFixed(2)} down bar below median`);
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
