import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 20))),
    };
}

export const placement_band_breakout: Strategy = {
    name: "Placement Band Breakout",
    description: "Breaks the prior-only trailing envelope of close acceptance, a new extreme in how bars close.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Envelope Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        // Prior-only envelope: the reference excludes the current bar.
        const { min, max } = buildRollingMinMax(acceptance, lookback, false);

        return createSignalLoop(cleanData, [min, max], (i) => {
            const low = min[i];
            const high = max[i];
            if (low === null || high === null) return null;

            if (acceptance[i] > high) {
                return createBuySignal(cleanData, i, `Acceptance breakout above band: ${acceptance[i].toFixed(2)}`);
            }
            if (acceptance[i] < low) {
                return createSellSignal(cleanData, i, `Acceptance breakout below band: ${acceptance[i].toFixed(2)}`);
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
