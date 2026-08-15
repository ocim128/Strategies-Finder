import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";

const MOMENTUM_THRESHOLD = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volatility_scaled_momentum_continuation: Strategy = {
    name: "Volatility Scaled Momentum Continuation",
    description: "Continues when the lookback net move exceeds a fixed multiple of the same-window ATR.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < lookback) return null;
            const atrValue = atr[i];
            if (atrValue === null || atrValue <= 0) return null;

            const scaledMomentum = (closes[i] - closes[i - lookback]) / atrValue;
            if (scaledMomentum > MOMENTUM_THRESHOLD) {
                return createBuySignal(cleanData, i, `ATR-scaled momentum ${scaledMomentum.toFixed(2)}`);
            }
            if (scaledMomentum < -MOMENTUM_THRESHOLD) {
                return createSellSignal(cleanData, i, `ATR-scaled momentum ${scaledMomentum.toFixed(2)}`);
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
