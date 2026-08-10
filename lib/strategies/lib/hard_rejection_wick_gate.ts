import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeHardRejectionWickGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rejectionThreshold: Math.max(0.1, Math.min(0.9, Number(params.rejectionThreshold ?? 0.5))),
    };
}

export const hard_rejection_wick_gate: Strategy = {
    name: "Hard Rejection Wick Gate",
    description: "Follows bars whose wick imbalance exceeds a magic threshold as hard single-side rejection events.",
    defaultParams: {
        rejectionThreshold: 0.5,
    },
    paramLabels: {
        rejectionThreshold: "Rejection Threshold",
    },
    normalizeParams: normalizeHardRejectionWickGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeHardRejectionWickGateParams(params);
        const rejectionThreshold = p.rejectionThreshold as number;
        if (cleanData.length < 2) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");

        return createSignalLoop(cleanData, [], (i) => {
            if (wickImbalance[i] > rejectionThreshold) {
                return createBuySignal(cleanData, i, `Hard lower-wick rejection: imbalance ${wickImbalance[i].toFixed(3)}`);
            }
            if (wickImbalance[i] < -rejectionThreshold) {
                return createSellSignal(cleanData, i, `Hard upper-wick rejection: imbalance ${wickImbalance[i].toFixed(3)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rejectionThreshold"],
    },
};
