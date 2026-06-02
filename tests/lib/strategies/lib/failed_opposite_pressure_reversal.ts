import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming counter-trend pulls that fail to displace median lead to high-probability continuation.
// #SUGGEST_VERIFY: Verify pressureReversalLookback (2 to 10) correctly captures micro-pullbacks.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        pressureReversalLookback: Math.max(1, Math.round(Number(params.pressureReversalLookback ?? 5))),
    };
}

export const failed_opposite_pressure_reversal: Strategy = {
    name: "Failed Opposite Pressure Reversal",
    description: "Captures trend continuation when pullbacks towards the median fail to break it and initiative pressure reverses.",
    defaultParams: {
        lookback: 50,
        pressureReversalLookback: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        pressureReversalLookback: "Reversal Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const pressureReversalLookback = p.pressureReversalLookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);

        return createSignalLoop(cleanData, [median, pressure], (i) => {
            const currentClose = closes[i];
            const m = median[i];
            const pres = pressure[i];

            if (m === null || pres === null) return null;

            // Buy: Close is above median, current initiative pressure is positive, but there was a negative pressure bar recently
            if (currentClose > m && pres > 0) {
                let foundRecentNegative = false;
                const start = Math.max(0, i - pressureReversalLookback);
                for (let j = start; j < i; j++) {
                    const pBar = pressure[j];
                    if (pBar !== null && pBar < 0) {
                        foundRecentNegative = true;
                        break;
                    }
                }
                if (foundRecentNegative) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish continuation: failed pullback above median ${m.toFixed(2)} with initiative pressure reversal to ${pres.toFixed(3)}`
                    );
                }
            }

            // Sell: Close is below median, current initiative pressure is negative, but there was a positive pressure bar recently
            if (currentClose < m && pres < 0) {
                let foundRecentPositive = false;
                const start = Math.max(0, i - pressureReversalLookback);
                for (let j = start; j < i; j++) {
                    const pBar = pressure[j];
                    if (pBar !== null && pBar > 0) {
                        foundRecentPositive = true;
                        break;
                    }
                }
                if (foundRecentPositive) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish continuation: failed pullback below median ${m.toFixed(2)} with initiative pressure reversal to ${pres.toFixed(3)}`
                    );
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureReversalLookback"],
    },
};
