import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeCloseAcceptanceMomentumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const close_acceptance_momentum: Strategy = {
    name: "Close Acceptance Momentum",
    description:
        "Uses momentum in close acceptance as the participation trigger while price remains aligned with its rolling median.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCloseAcceptanceMomentumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceMomentumParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const acceptanceRoc = buildRateOfChange(acceptance.map((value) => value + 2), 1);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [acceptanceRoc, median], (i) => {
            const roc = acceptanceRoc[i];
            const med = median[i];
            if (roc === null || med === null) return null;

            if (roc > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive close-acceptance momentum ${roc.toFixed(3)}`);
            }
            if (roc < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative close-acceptance momentum ${roc.toFixed(3)}`);
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
