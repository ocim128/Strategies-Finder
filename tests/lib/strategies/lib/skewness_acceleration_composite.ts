import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessAccelerationCompositeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 63))),
    };
}

export const skewness_acceleration_composite: Strategy = {
    name: "Skewness Acceleration Composite",
    description:
        "Signals either a zero-line skewness shift or skewness acceleration when price agrees with its rolling median.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSkewnessAccelerationCompositeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessAccelerationCompositeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const skewness = buildRollingSkewness(returns, lookback);
        const skewRoc = buildRateOfChange(skewness.map((value) => value ?? 0), 1);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [skewness, skewRoc, median], (i) => {
            const skew = skewness[i];
            const priorSkew = skewness[i - 1];
            const acceleration = skewRoc[i];
            const med = median[i];
            if (skew === null || priorSkew === null || acceleration === null || med === null) return null;

            const longSignal = ((priorSkew <= 0 && skew > 0) || acceleration > 0) && closes[i] > med;
            const shortSignal = ((priorSkew >= 0 && skew < 0) || acceleration < 0) && closes[i] < med;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Skewness composite long skew=${skew.toFixed(2)}`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Skewness composite short skew=${skew.toFixed(2)}`);
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
