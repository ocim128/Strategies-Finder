import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const HIGH_PRESSURE_PCT = 0.9;
const LOW_PRESSURE_PCT = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const initiative_pressure_extreme_follow: Strategy = {
    name: "Initiative Pressure Extreme Follow",
    description: "Follows bars whose initiative pressure sits at a percentile extreme of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Pressure Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        // Mask warm-up nulls as NaN so the percentile helper excludes them from the window.
        const masked = pressure.map((v) => (v === null ? NaN : v));
        const pct = buildPercentileRank(masked, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null) return null;

            if (pr >= HIGH_PRESSURE_PCT) {
                return createBuySignal(cleanData, i, `Extreme initiative pressure: rank ${pr.toFixed(2)}`);
            }
            if (pr <= LOW_PRESSURE_PCT) {
                return createSellSignal(cleanData, i, `Extreme initiative pressure: rank ${pr.toFixed(2)}`);
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
