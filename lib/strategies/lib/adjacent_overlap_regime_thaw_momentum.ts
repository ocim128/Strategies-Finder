import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildAdjacentRangeOverlapSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 16))),
    };
}

export const adjacent_overlap_regime_thaw_momentum: Strategy = {
    name: "Adjacent Overlap Regime Thaw Momentum",
    description: "Enters directional momentum when the rolling average adjacent range overlap drops by >= 0.20, indicating market thaw from equilibrium.",
    defaultParams: {
        lookback: 16,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback * 2 + 1) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const avgOverlap = buildRollingAverage(overlap, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [avgOverlap], (i) => {
            if (i < lookback) return null;
            const currAvg = avgOverlap[i];
            const prevAvg = avgOverlap[i - lookback];
            if (currAvg === null || prevAvg === null) return null;

            const thaw = prevAvg - currAvg;
            if (thaw >= 0.20) {
                if (closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish regime thaw: rolling overlap dropped by ${thaw.toFixed(3)} >= 0.20, close > close[i-${lookback}]`);
                }
                if (closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish regime thaw: rolling overlap dropped by ${thaw.toFixed(3)} >= 0.20, close < close[i-${lookback}]`);
                }
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
