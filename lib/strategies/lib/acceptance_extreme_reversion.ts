import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";

function normalizeAcceptanceExtremeReversionParams(params: StrategyParams): StrategyParams {
    const threshold = Number(params.threshold ?? 0.5);
    return {
        ...params,
        threshold: Math.max(0.1, Math.min(0.9, Number.isFinite(threshold) ? threshold : 0.5)),
    };
}

export const acceptance_extreme_reversion: Strategy = {
    name: "Acceptance Extreme Reversion",
    description: "Fades bars settling at extreme close-acceptance magnitudes, a one-bar climax in close control.",
    defaultParams: {
        threshold: 0.5,
    },
    paramLabels: {
        threshold: "Acceptance Threshold",
    },
    normalizeParams: normalizeAcceptanceExtremeReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const threshold = normalizeAcceptanceExtremeReversionParams(params).threshold as number;

        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createCurrentBarSignalLoop(cleanData, [], (i) => {
            if (acceptance[i] <= -threshold) {
                return createBuySignal(cleanData, i, `Acceptance extreme buy: settlement ${acceptance[i].toFixed(2)} at or below -${threshold}`);
            }
            if (acceptance[i] >= threshold) {
                return createSellSignal(cleanData, i, `Acceptance extreme sell: settlement ${acceptance[i].toFixed(2)} at or above ${threshold}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["threshold"],
    },
};
