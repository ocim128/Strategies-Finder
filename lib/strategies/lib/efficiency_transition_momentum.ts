import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

const EFFICIENCY_LEVEL_GATE = 0.2;
const ACCELERATION_GATE = 1.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_transition_momentum: Strategy = {
    name: "Efficiency Transition Momentum",
    description: "Enters on the one-bar acceleration of the efficiency ratio, the moment a path straightens.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Efficiency Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        // Mask warm-up nulls as NaN so the one-bar rate of change can still be
        // computed once the efficiency series exists.
        const masked = efficiency.map((v) => (v === null ? NaN : v));
        const acceleration = buildRateOfChange(masked, 1);

        return createSignalLoop(cleanData, [efficiency, acceleration], (i) => {
            if (i < lookback) return null;

            const level = efficiency[i];
            const accel = acceleration[i];
            if (level === null || accel === null || !Number.isFinite(accel)) return null;
            if (level < EFFICIENCY_LEVEL_GATE || accel < ACCELERATION_GATE) return null;

            if (closes[i] > closes[i - lookback]) {
                return createBuySignal(cleanData, i, `Efficiency transition up: accel ${accel.toFixed(2)}`);
            }
            if (closes[i] < closes[i - lookback]) {
                return createSellSignal(cleanData, i, `Efficiency transition down: accel ${accel.toFixed(2)}`);
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
