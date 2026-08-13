import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, extractBarMetricSeries } from "./price-action-statistics-core";

const AUTOCORR_GATE = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const body_direction_autocorr_switch: Strategy = {
    name: "Body Direction Autocorrelation Switch",
    description: "Routes follow vs fade by the sign of the rolling lag-1 autocorrelation of body direction.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const bodies = extractBarMetricSeries(cleanData, "bodyDirection");
        const corr = buildRollingAutoCorrelation(bodies, lookback, 1);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null || Number.isNaN(c)) return null;

            const direction = bodies[i];
            if (direction === 0) return null;

            // Positive autocorrelation: directional bars cluster, so follow the current bar.
            if (c >= AUTOCORR_GATE) {
                if (direction > 0) {
                    return createBuySignal(cleanData, i, `Bull bars persist: autocorr ${c.toFixed(2)}`);
                }
                return createSellSignal(cleanData, i, `Bear bars persist: autocorr ${c.toFixed(2)}`);
            }
            // Negative autocorrelation: directional bars alternate, so fade the current bar.
            if (c <= -AUTOCORR_GATE) {
                if (direction < 0) {
                    return createBuySignal(cleanData, i, `Bear bars flip: autocorr ${c.toFixed(2)}`);
                }
                return createSellSignal(cleanData, i, `Bull bars flip: autocorr ${c.toFixed(2)}`);
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
