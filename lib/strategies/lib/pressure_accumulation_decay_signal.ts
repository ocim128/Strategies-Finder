import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum, buildPercentileRank } from "./price-action-statistics-core";

function normalizePressureAccumulationDecaySignalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.90))),
        accumulationPercentileMin: Math.max(0, Math.min(1, Number(params.accumulationPercentileMin ?? 0.70))),
    };
}

export const pressure_accumulation_decay_signal: Strategy = {
    name: "Pressure Accumulation Decay Signal",
    description: "Cumulative initiative pressure with exponential decay.",
    defaultParams: {
        lookback: 30,
        decay: 0.90,
        accumulationPercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        decay: "Decay",
        accumulationPercentileMin: "Accumulation Percentile Min",
    },
    normalizeParams: normalizePressureAccumulationDecaySignalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePressureAccumulationDecaySignalParams(params);
        const lookback = p.lookback as number;
        const decay = p.decay as number;
        const accumulationPercentileMin = p.accumulationPercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);
        const decaySum = buildCumulativeDecaySum(cleanPressure, decay);
        const decayPercentile = buildPercentileRank(decaySum, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [decayPercentile, volumePercentile], (i) => {
            const decPct = decayPercentile[i];
            const volPct = volumePercentile[i];
            if (decPct === null || volPct === null) return null;

            if (volPct > 0.40) {
                if (decPct > accumulationPercentileMin) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Extreme positive accumulation: decay percentile ${decPct.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
                if (decPct < (1 - accumulationPercentileMin)) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Extreme negative accumulation: decay percentile ${decPct.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "accumulationPercentileMin"],
    },
};
