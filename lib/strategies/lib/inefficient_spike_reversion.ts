import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingRobustZScore } from "./price-action-statistics-core";

const DEPTH_BAND = 2;
const EFFICIENCY_MAX = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 25))),
    };
}

export const inefficient_spike_reversion: Strategy = {
    name: "Inefficient Spike Reversion",
    description: "Fades large robust z-score dislocations only when the path behind them was disorderly.",
    defaultParams: {
        lookback: 25,
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

        const z = buildRollingRobustZScore(getCloses(cleanData), lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [z, efficiency], (i) => {
            const zNow = z[i];
            const eff = efficiency[i];
            if (zNow === null || eff === null) return null;

            // Large but disorderly drop: the move kept retracing itself.
            if (zNow <= -DEPTH_BAND && eff <= EFFICIENCY_MAX) {
                return createBuySignal(cleanData, i, `Inefficient spike buy: z ${zNow.toFixed(2)}, efficiency ${eff.toFixed(2)}`);
            }
            // Large but disorderly rally.
            if (zNow >= DEPTH_BAND && eff <= EFFICIENCY_MAX) {
                return createSellSignal(cleanData, i, `Inefficient spike sell: z ${zNow.toFixed(2)}, efficiency ${eff.toFixed(2)}`);
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
