import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

const DOJI_BODY_PCT = 0.2;
const DOJI_SHARE_GATE = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const indecision_share_fade: Strategy = {
    name: "Indecision Share Fade",
    description: "Fades directional closes when most bars in the window are doji.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Indecision Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const doji = bodyPct.map((v) => (v <= DOJI_BODY_PCT ? 1 : 0));
        const share = buildRollingAverage(doji, lookback);
        const direction = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [share], (i) => {
            const s = share[i];
            if (s === null || s < DOJI_SHARE_GATE) return null;

            // In an indecisive market, fade the current directional close.
            if (direction[i] < 0) {
                return createBuySignal(cleanData, i, `Indecision fades down bar up: share ${s.toFixed(2)}`);
            }
            if (direction[i] > 0) {
                return createSellSignal(cleanData, i, `Indecision fades up bar down: share ${s.toFixed(2)}`);
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
