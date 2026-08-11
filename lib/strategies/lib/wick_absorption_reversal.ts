import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const WICK_RANK_EXTREME = 0.95;
const CLOSE_CONFIRM = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const wick_absorption_reversal: Strategy = {
    name: "Wick Absorption Reversal",
    description: "Fades extreme wick-imbalance bars when the close confirms the rejection by settling opposite the probed side.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const wickRank = buildPercentileRank(wickImbalance, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [wickRank], (i) => {
            const rank = wickRank[i];
            if (rank === null) return null;

            // Dominant lower wick (rejection of the low side) with the close held
            // in the upper half: the probe was absorbed.
            if (rank >= WICK_RANK_EXTREME && closeLocation[i] >= CLOSE_CONFIRM) {
                return createBuySignal(cleanData, i, `Wick absorption buy: wick rank ${rank.toFixed(2)}, close location ${closeLocation[i].toFixed(2)}`);
            }
            // Dominant upper wick (rejection of the high side) with the close held
            // in the lower half.
            if (rank <= 1 - WICK_RANK_EXTREME && closeLocation[i] <= 1 - CLOSE_CONFIRM) {
                return createSellSignal(cleanData, i, `Wick absorption sell: wick rank ${rank.toFixed(2)}, close location ${closeLocation[i].toFixed(2)}`);
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
