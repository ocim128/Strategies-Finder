import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const HIGH_FLOW_PCT = 0.7;
const LOW_FLOW_PCT = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const price_flow_divergence_fade: Strategy = {
    name: "Price Flow Divergence Fade",
    description: "Fades trailing-range extremes printed without supporting money flow.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Range / Flow Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const trailing = buildTrailingHighLow(cleanData, lookback, false);
        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), getVolumes(cleanData), lookback);
        const maskedCmf = cmf.map((v) => (v === null ? NaN : v));
        const cmfPct = buildPercentileRank(maskedCmf, lookback);

        return createSignalLoop(cleanData, [trailing.highest, trailing.lowest, cmfPct], (i) => {
            const high = trailing.highest[i];
            const low = trailing.lowest[i];
            const pr = cmfPct[i];
            if (high === null || low === null || pr === null) return null;

            const close = cleanData[i].close;

            // Fresh range low on still-positive flow: the down print lacks participation.
            if (close < low && pr >= HIGH_FLOW_PCT) {
                return createBuySignal(cleanData, i, `Range low without flow: cmf rank ${pr.toFixed(2)}`);
            }
            // Fresh range high on still-negative flow: the up print lacks participation.
            if (close > high && pr <= LOW_FLOW_PCT) {
                return createSellSignal(cleanData, i, `Range high without flow: cmf rank ${pr.toFixed(2)}`);
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
