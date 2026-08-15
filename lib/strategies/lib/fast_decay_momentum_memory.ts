import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCumulativeDecaySum, buildRateOfChange } from "./price-action-statistics-core";

const MEMORY_SCORE_THRESHOLD = 0.02;
const MIN_SERIES_LENGTH = 5;

function normalizeFastDecayMomentumMemoryParams(params: StrategyParams): StrategyParams {
    const decay = Number(params.decay ?? 0.6);
    return {
        ...params,
        decay: Math.max(0.01, Math.min(1, Number.isFinite(decay) ? decay : 0.6)),
    };
}

export const fast_decay_momentum_memory: Strategy = {
    name: "Fast Decay Momentum Memory",
    description: "Trades fast-decayed signed one-bar returns crossing a fixed magnitude, weighting only the last few bars.",
    defaultParams: {
        decay: 0.6,
    },
    paramLabels: {
        decay: "Decay Factor",
    },
    normalizeParams: normalizeFastDecayMomentumMemoryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const decay = normalizeFastDecayMomentumMemoryParams(params).decay as number;
        if (cleanData.length < MIN_SERIES_LENGTH) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const score = buildCumulativeDecaySum(returns, decay);

        return createCurrentBarSignalLoop(cleanData, [], (i) => {
            if (score[i] >= MEMORY_SCORE_THRESHOLD && returns[i] > 0) {
                return createBuySignal(cleanData, i, `Fast decay momentum buy: memory score ${score[i].toFixed(4)} with positive return`);
            }
            if (score[i] <= -MEMORY_SCORE_THRESHOLD && returns[i] < 0) {
                return createSellSignal(cleanData, i, `Fast decay momentum sell: memory score ${score[i].toFixed(4)} with negative return`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay"],
    },
};
