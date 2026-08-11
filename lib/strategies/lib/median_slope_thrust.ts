import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingMedian,
    buildRollingZScore,
} from "./price-action-statistics-core";

const SLOPE_BARS = 3;
const SLOPE_Z_BAND = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const median_slope_thrust: Strategy = {
    name: "Median Slope Thrust",
    description: "Trades statistically extreme z-scores of the 3-bar rate of change of the rolling median of closes.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median & Slope Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + SLOPE_BARS) return [];

        const median = buildRollingMedian(getCloses(cleanData), lookback);
        // Leading median nulls are filled with the first valid median so the
        // 3-bar slope series stays dense; the filled prefix is flat, so it only
        // produces zero slopes that suppress, never inflate, early z readings.
        const firstMedian = median.find((v): v is number => v !== null) ?? 0;
        const medianCoerced = median.map((v) => (v === null ? firstMedian : v));
        const slope = buildRateOfChange(medianCoerced, SLOPE_BARS).map((v) => (v === null ? 0 : v));
        const slopeZ = buildRollingZScore(slope, lookback);

        return createSignalLoop(cleanData, [slopeZ], (i) => {
            const prev = slopeZ[i - 1];
            const curr = slopeZ[i];
            if (prev === null || curr === null) return null;

            // Median slope z-score crosses to extreme positive (center thrusting up).
            if (prev < SLOPE_Z_BAND && curr >= SLOPE_Z_BAND) {
                return createBuySignal(cleanData, i, `Median slope thrust buy: slope z ${curr.toFixed(2)} crossed above band`);
            }
            // Median slope z-score crosses to extreme negative.
            if (prev > -SLOPE_Z_BAND && curr <= -SLOPE_Z_BAND) {
                return createSellSignal(cleanData, i, `Median slope thrust sell: slope z ${curr.toFixed(2)} crossed below band`);
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
