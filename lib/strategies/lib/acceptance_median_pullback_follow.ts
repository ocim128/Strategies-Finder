import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const REGIME_LEVEL = 0.3;
const COUNTER_BAR_LEVEL = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const acceptance_median_pullback_follow: Strategy = {
    name: "Acceptance Median Pullback Follow",
    description: "Buys violent counter-bars inside a persistent one-sided acceptance regime: the counter-swing is a pullback, not a reversal.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Acceptance Regime Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const medianAcceptance = buildRollingMedian(acceptance, lookback);

        return createSignalLoop(cleanData, [medianAcceptance], (i) => {
            const med = medianAcceptance[i];
            if (med === null) return null;
            const current = acceptance[i];

            // Persistent upside acceptance regime, then a violent bearish counter-bar.
            if (med > REGIME_LEVEL && current < -COUNTER_BAR_LEVEL) {
                return createBuySignal(cleanData, i, `Acceptance pullback buy: regime median ${med.toFixed(2)} against counter-bar ${current.toFixed(2)}`);
            }
            if (med < -REGIME_LEVEL && current > COUNTER_BAR_LEVEL) {
                return createSellSignal(cleanData, i, `Acceptance pullback sell: regime median ${med.toFixed(2)} against counter-bar ${current.toFixed(2)}`);
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
