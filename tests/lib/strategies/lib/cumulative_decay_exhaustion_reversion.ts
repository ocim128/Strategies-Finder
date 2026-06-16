import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCumulativeDecaySum,
    buildRateOfChange,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        zscoreThreshold: Math.max(0, Number(params.zscoreThreshold ?? 2.0)),
    };
}

export const cumulative_decay_exhaustion_reversion: Strategy = {
    name: "Cumulative Decay Exhaustion Reversion",
    description: "Fades directional pressure extremes measured via an exponentially decaying return sum z-score.",
    defaultParams: {
        lookback: 50,
        zscoreThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zscoreThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const retNumbers = returns.map((v) => (v !== null ? v : 0));

        const decaySum = buildCumulativeDecaySum(retNumbers, 0.15);
        const decayZ = buildRollingZScore(decaySum, lookback);

        return createSignalLoop(cleanData, [decayZ], (i) => {
            const z = decayZ[i];
            if (z === null) return null;

            if (z < -p.zscoreThreshold) {
                return createBuySignal(cleanData, i, `Decay exhaustion buy: Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zscoreThreshold) {
                return createSellSignal(cleanData, i, `Decay exhaustion sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zscoreThreshold"],
    },
};
