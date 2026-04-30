import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange, buildRollingEntropy } from "./price-action-statistics-core";

const ORDERED_BREAKOUT_ENTROPY_HISTORY = 100;
const ORDERED_BREAKOUT_MAX_RANK = 0.2;

function normalizeLowEntropyOrderedBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entropy_lookback: Math.max(3, Math.round(Number(params.entropy_lookback ?? 30))),
        breakout_lookback: Math.max(2, Math.round(Number(params.breakout_lookback ?? 20))),
    };
}

export const low_entropy_ordered_breakout: Strategy = {
    name: "Low-Entropy Ordered Breakout",
    description:
        "Measures how ordered the recent return stream has become and only accepts range breaks when entropy is sitting near the bottom of its own longer history.",
    defaultParams: {
        entropy_lookback: 30,
        breakout_lookback: 20,
    },
    paramLabels: {
        entropy_lookback: "Entropy Lookback",
        breakout_lookback: "Breakout Lookback",
    },
    normalizeParams: normalizeLowEntropyOrderedBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLowEntropyOrderedBreakoutParams(params);
        const minBars = Math.max((p.entropy_lookback as number) + ORDERED_BREAKOUT_ENTROPY_HISTORY, p.breakout_lookback as number);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, p.entropy_lookback as number);
        const entropyRank = buildPercentileRank(entropy.map((value) => value ?? 0), ORDERED_BREAKOUT_ENTROPY_HISTORY);
        const { highest, lowest } = buildTrailingHighLow(cleanData, p.breakout_lookback as number);

        return createSignalLoop(cleanData, [entropyRank, highest, lowest], (i) => {
            const rank = entropyRank[i];
            const priorHigh = highest[i];
            const priorLow = lowest[i];
            if (rank === null || priorHigh === null || priorLow === null || rank > ORDERED_BREAKOUT_MAX_RANK) return null;

            if (closes[i] > priorHigh) {
                return createBuySignal(cleanData, i, `Low entropy rank ${(rank * 100).toFixed(0)}% with breakout close`);
            }
            if (closes[i] < priorLow) {
                return createSellSignal(cleanData, i, `Low entropy rank ${(rank * 100).toFixed(0)}% with breakdown close`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entropy_lookback", "breakout_lookback"],
    },
};
