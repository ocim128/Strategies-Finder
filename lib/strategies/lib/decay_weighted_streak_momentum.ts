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
import { buildCumulativeDecaySum, buildRollingZScore } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.85))),
    };
}

export const decay_weighted_streak_momentum: Strategy = {
    name: "Decay-Weighted Streak Momentum",
    description: "Momentum acceleration using cumulative decay sum of ATR-normalized returns.",
    defaultParams: {
        lookback: 30,
        decay: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        decay: "Decay Multiplier",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decay = p.decay as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const atr = calculateATR(highs, lows, closes, lookback);

        const normReturns = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const atrVal = atr[i];
            if (atrVal !== null && atrVal > 0) {
                normReturns[i] = returns[i] / atrVal;
            }
        }

        const decaySum = buildCumulativeDecaySum(normReturns, decay);
        const decayZ = buildRollingZScore(decaySum, lookback);

        return createSignalLoop(cleanData, [decayZ], (i) => {
            if (i < lookback) return null;
            const currentZ = decayZ[i];
            if (currentZ === null) return null;

            // Buy: z-score > 1.7
            if (currentZ > 1.7) {
                return createBuySignal(cleanData, i, `Decay Sum Mom Buy: Z ${currentZ.toFixed(2)}`);
            }
            // Sell: z-score < -1.7
            if (currentZ < -1.7) {
                return createSellSignal(cleanData, i, `Decay Sum Mom Sell: Z ${currentZ.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay"],
    },
};
