import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { calculateSMA } from "../indicators";

function normalizeTypicalPriceAccelerationAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        avg_lookback: Math.max(2, Math.round(Number(params.avg_lookback ?? 55))),
        accel_lookback: Math.max(1, Math.round(Number(params.accel_lookback ?? 5))),
    };
}

export const typical_price_acceleration_anchor: Strategy = {
    name: "Typical Price Acceleration Anchor",
    description:
        "Tracks the slope of a smoothed typical-price anchor and enters only when that slope is itself accelerating in the same direction.",
    defaultParams: {
        avg_lookback: 55,
        accel_lookback: 5,
    },
    paramLabels: {
        avg_lookback: "Average Lookback",
        accel_lookback: "Acceleration Lookback",
    },
    normalizeParams: normalizeTypicalPriceAccelerationAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceAccelerationAnchorParams(params);
        const avgLookback = p.avg_lookback as number;
        const accelLookback = p.accel_lookback as number;
        if (cleanData.length < avgLookback + accelLookback + 1) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const average = calculateSMA(typicalPrices, avgLookback);

        return createSignalLoop(cleanData, [average], (i) => {
            if (i <= accelLookback) return null;

            const current = average[i];
            const previous = average[i - 1];
            const past = average[i - accelLookback];
            const pastPrevious = average[i - accelLookback - 1];
            if (current === null || previous === null || past === null || pastPrevious === null) return null;

            const currentSlope = current - previous;
            const pastSlope = past - pastPrevious;

            if (current > previous && currentSlope > pastSlope) {
                return createBuySignal(cleanData, i, "Typical-price SMA slope is accelerating upward");
            }
            if (current < previous && currentSlope < pastSlope) {
                return createSellSignal(cleanData, i, "Typical-price SMA slope is accelerating downward");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["avg_lookback", "accel_lookback"],
    },
};
