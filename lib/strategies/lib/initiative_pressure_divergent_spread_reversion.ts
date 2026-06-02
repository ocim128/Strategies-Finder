import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming divergence of price return and cumulative initiative pressure indicates absorption.
// #SUGGEST_VERIFY: Verify pressureThreshold (>= 0.1) is calibrated for decayed initiative pressure sum.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        decay: Math.max(0.1, Math.min(0.999, Number(params.decay ?? 0.95))),
        pressureThreshold: Math.max(0.1, Number(params.pressureThreshold ?? 1.0)),
    };
}

export const initiative_pressure_divergent_spread_reversion: Strategy = {
    name: "Initiative Pressure Divergent Spread Reversion",
    description: "Fades negative/positive close returns when volume-weighted initiative pressure is strongly divergent, indicating passive absorption.",
    defaultParams: {
        lookback: 30,
        decay: 0.95,
        pressureThreshold: 1.0,
    },
    paramLabels: {
        lookback: "Lookback",
        decay: "Decay Factor",
        pressureThreshold: "Pressure Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decay = p.decay as number;
        const pressureThreshold = p.pressureThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const pressure = buildInitiativePressureSeries(cleanData, lookback);

        // Initiative pressure contains nulls due to rolling volume average warmup, so sanitize to 0
        const sanitizedPressure = pressure.map(v => v ?? 0);
        const decayedPressure = buildCumulativeDecaySum(sanitizedPressure, decay);

        return createSignalLoop(cleanData, [pressure], (i) => {
            const ret = returns[i];
            const dp = decayedPressure[i];

            // Buy: Close return is negative, but cumulative decayed initiative pressure is strongly positive
            if (ret < 0 && dp > pressureThreshold) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish reversion: return ${ret.toFixed(4)} < 0 with positive absorption pressure ${dp.toFixed(2)}`
                );
            }

            // Sell: Close return is positive, but cumulative decayed initiative pressure is strongly negative
            if (ret > 0 && dp < -pressureThreshold) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish reversion: return ${ret.toFixed(4)} > 0 with negative absorption pressure ${dp.toFixed(2)}`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "pressureThreshold"],
    },
};
