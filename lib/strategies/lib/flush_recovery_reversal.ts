import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const FLUSH_Z_BAND = 2.0;

function normalizeFlushRecoveryReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const flush_recovery_reversal: Strategy = {
    name: "Flush Recovery Reversal",
    description: "Reverses a robustly stretched flush bar the moment the next close recovers through its midpoint.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeFlushRecoveryReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeFlushRecoveryReversalParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const robustZ = buildRollingRobustZScore(closes, lookback);

        return createSignalLoop(cleanData, [robustZ], (i) => {
            if (i < lookback) return null;
            const prevZ = robustZ[i - 1];
            if (prevZ === null) return null;
            const priorMidpoint = computePriceActionBarMetrics(cleanData[i - 1]).midpoint;

            if (prevZ < -FLUSH_Z_BAND && closes[i] > priorMidpoint) {
                return createBuySignal(cleanData, i, `Flush recovery buy: prior flush z ${prevZ.toFixed(2)} recovered through midpoint`);
            }
            if (prevZ > FLUSH_Z_BAND && closes[i] < priorMidpoint) {
                return createSellSignal(cleanData, i, `Flush recovery sell: prior flush z ${prevZ.toFixed(2)} fell through midpoint`);
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
