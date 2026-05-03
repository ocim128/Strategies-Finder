import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getMidpoints,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeBodyProportionRegimeRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        body_lookback: Math.max(2, Math.round(Number(params.body_lookback ?? 55))),
        strong_threshold: Math.max(0, Math.min(1, Number(params.strong_threshold ?? 0.6))),
    };
}

export const body_proportion_regime_router: Strategy = {
    name: "Body Proportion Regime Router",
    description:
        "Routes strong body-proportion bars to median-following entries and weak body bars to midpoint gravity fades.",
    defaultParams: {
        body_lookback: 55,
        strong_threshold: 0.6,
    },
    paramLabels: {
        body_lookback: "Body Lookback",
        strong_threshold: "Strong Threshold",
    },
    normalizeParams: normalizeBodyProportionRegimeRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyProportionRegimeRouterParams(params);
        const lookback = p.body_lookback as number;
        const threshold = p.strong_threshold as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const bodyPct = buildBodyPctSeries(cleanData);
        const averageBodyPct = buildRollingAverage(bodyPct, lookback);
        const closeMedian = buildRollingMedian(closes, lookback);
        const midpointMedian = buildRollingMedian(getMidpoints(cleanData), lookback);

        return createSignalLoop(cleanData, [averageBodyPct, closeMedian, midpointMedian], (i) => {
            const avgBody = averageBodyPct[i];
            const median = closeMedian[i];
            const midpoint = midpointMedian[i];
            if (avgBody === null || median === null || midpoint === null) return null;

            if (bodyPct[i] >= threshold) {
                if (closes[i] > median) {
                    return createBuySignal(cleanData, i, `Strong body regime ${bodyPct[i].toFixed(2)} above median`);
                }
                if (closes[i] < median) {
                    return createSellSignal(cleanData, i, `Strong body regime ${bodyPct[i].toFixed(2)} below median`);
                }
                return null;
            }

            if (closes[i] < midpoint) {
                return createBuySignal(cleanData, i, `Weak body regime midpoint fade avg=${avgBody.toFixed(2)}`);
            }
            if (closes[i] > midpoint) {
                return createSellSignal(cleanData, i, `Weak body regime midpoint fade avg=${avgBody.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["body_lookback", "strong_threshold"],
    },
};
