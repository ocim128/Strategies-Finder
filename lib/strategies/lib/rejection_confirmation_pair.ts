import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const WICK_DEFENDED_HIGH_BAND = 0.8;
const WICK_DEFENDED_LOW_BAND = 0.2;
const ACCEPTANCE_CONFIRM_BAND = 0.15;

function normalizeRejectionConfirmationPairParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const rejection_confirmation_pair: Strategy = {
    name: "Rejection Confirmation Pair",
    description: "Confirms an extreme prior-bar wick rejection with the next bar's close acceptance on the defended side.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRejectionConfirmationPairParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeRejectionConfirmationPairParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const wickPct = buildPercentileRank(extractBarMetricSeries(cleanData, "wickImbalance"), lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [wickPct], (i) => {
            if (i < lookback) return null;
            const priorWickRank = wickPct[i - 1];
            if (priorWickRank === null) return null;

            if (priorWickRank > WICK_DEFENDED_HIGH_BAND && acceptance[i] > ACCEPTANCE_CONFIRM_BAND) {
                return createBuySignal(cleanData, i, `Rejection pair buy: prior wick rank ${priorWickRank.toFixed(2)} (lows defended), acceptance ${acceptance[i].toFixed(2)}`);
            }
            if (priorWickRank < WICK_DEFENDED_LOW_BAND && acceptance[i] < -ACCEPTANCE_CONFIRM_BAND) {
                return createSellSignal(cleanData, i, `Rejection pair sell: prior wick rank ${priorWickRank.toFixed(2)} (highs defended), acceptance ${acceptance[i].toFixed(2)}`);
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
