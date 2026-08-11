import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const CLIMAX_LOW = 0.05;
const CLIMAX_HIGH = 0.95;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const initiative_pressure_climax_fade: Strategy = {
    name: "Initiative Pressure Climax Fade",
    description: "Fades percentile-extreme initiative pressure as a spent climax rather than a signal to follow.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Pressure & Climax Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // Pressure is null during its warm-up; the coerced prefix reads as
        // neutral pressure, which cannot reach the climax percentiles.
        const pressure = buildInitiativePressureSeries(cleanData, lookback).map((v) => (v === null ? 0 : v));
        const rank = buildPercentileRank(pressure, lookback);

        return createSignalLoop(cleanData, [rank], (i) => {
            const r = rank[i];
            if (r === null) return null;

            if (r <= CLIMAX_LOW) {
                return createBuySignal(cleanData, i, `Pressure climax buy: pressure rank ${r.toFixed(3)} in the bottom ${CLIMAX_LOW * 100}%`);
            }
            if (r >= CLIMAX_HIGH) {
                return createSellSignal(cleanData, i, `Pressure climax sell: pressure rank ${r.toFixed(3)} in the top ${(1 - CLIMAX_HIGH) * 100}%`);
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
