import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRollingMedianAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))),
    };
}

export const rolling_median_acceptance: Strategy = {
    name: "Rolling Median Acceptance",
    description:
        "Uses a trailing rolling median as a robust settlement center and trades whenever the completed close is accepted above or below that migrating value anchor.",
    defaultParams: {
        lookback: 55,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRollingMedianAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingMedianAcceptanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback - 1) return null;

            const med = median[i];
            if (med === null) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Close above rolling median ${med.toFixed(2)}`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Close below rolling median ${med.toFixed(2)}`);
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
