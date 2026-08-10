import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";

function normalizeAcceptanceConvictionGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        convictionThreshold: Math.max(0.3, Math.min(0.95, Number(params.convictionThreshold ?? 0.7))),
    };
}

export const acceptance_conviction_gate: Strategy = {
    name: "Acceptance Conviction Gate",
    description: "Follows bars whose close acceptance exceeds a magic threshold as conviction bars.",
    defaultParams: {
        convictionThreshold: 0.7,
    },
    paramLabels: {
        convictionThreshold: "Conviction Threshold",
    },
    normalizeParams: normalizeAcceptanceConvictionGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAcceptanceConvictionGateParams(params);
        const convictionThreshold = p.convictionThreshold as number;
        if (cleanData.length < 2) return [];

        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (closeAcceptance[i] > convictionThreshold) {
                return createBuySignal(cleanData, i, `Conviction bar: close acceptance ${closeAcceptance[i].toFixed(3)}`);
            }
            if (closeAcceptance[i] < -convictionThreshold) {
                return createSellSignal(cleanData, i, `Conviction bar: close acceptance ${closeAcceptance[i].toFixed(3)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["convictionThreshold"],
    },
};
