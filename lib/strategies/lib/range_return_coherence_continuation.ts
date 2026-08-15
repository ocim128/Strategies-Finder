import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

const COHERENCE_GATE = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const range_return_coherence_continuation: Strategy = {
    name: "Range Return Coherence Continuation",
    description: "Continues the window's net move when bar ranges and absolute returns expand together.",
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
        const ranges = buildRangeSeries(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const absReturns = returns.map((value) => (value === null ? 0 : Math.abs(value)));
        const coherence = buildRollingCorrelation(ranges, absReturns, lookback);

        return createSignalLoop(cleanData, [coherence], (i) => {
            if (i < lookback) return null;
            const correlation = coherence[i];
            if (correlation === null) return null;

            const netChange = closes[i] - closes[i - lookback];
            if (correlation > COHERENCE_GATE && netChange > 0) {
                return createBuySignal(cleanData, i, `Coherent bullish leg: r ${correlation.toFixed(2)}`);
            }
            if (correlation > COHERENCE_GATE && netChange < 0) {
                return createSellSignal(cleanData, i, `Coherent bearish leg: r ${correlation.toFixed(2)}`);
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
