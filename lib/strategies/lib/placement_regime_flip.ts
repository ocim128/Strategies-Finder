import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 24))),
    };
}

export const placement_regime_flip: Strategy = {
    name: "Placement Regime Flip",
    description: "Trades the zero-cross of the smoothed close-acceptance series, a flip in how bars close.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Smoothing Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const averageAcceptance = buildRollingAverage(acceptance, lookback);
        const zeroLine = new Array<number>(cleanData.length).fill(0);

        return createSignalLoop(cleanData, [averageAcceptance], (i) => {
            const cross = checkCrossover(averageAcceptance, zeroLine, i);

            if (cross === "bullish") {
                return createBuySignal(cleanData, i, "Placement regime flipped up");
            }
            if (cross === "bearish") {
                return createSellSignal(cleanData, i, "Placement regime flipped down");
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
