import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

const EFFICIENCY_WINDOW = 100;

function normalizeLongWindowEfficiencyGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        efficiencyThreshold: Math.max(0.1, Math.min(0.9, Number(params.efficiencyThreshold ?? 0.4))),
    };
}

export const long_window_efficiency_gate: Strategy = {
    name: "Long Window Efficiency Gate",
    description: "Follows the direction of long-window net change when Kaufman efficiency stays above a magic threshold.",
    defaultParams: {
        efficiencyThreshold: 0.4,
    },
    paramLabels: {
        efficiencyThreshold: "Efficiency Threshold",
    },
    normalizeParams: normalizeLongWindowEfficiencyGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLongWindowEfficiencyGateParams(params);
        const efficiencyThreshold = p.efficiencyThreshold as number;
        if (cleanData.length < EFFICIENCY_WINDOW + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, EFFICIENCY_WINDOW);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            if (i < EFFICIENCY_WINDOW) return null;
            const er = efficiency[i];
            if (er === null) return null;

            if (er > efficiencyThreshold && closes[i] > closes[i - EFFICIENCY_WINDOW]) {
                return createBuySignal(cleanData, i, `Long-window efficiency ${er.toFixed(2)} with positive net change`);
            }
            if (er > efficiencyThreshold && closes[i] < closes[i - EFFICIENCY_WINDOW]) {
                return createSellSignal(cleanData, i, `Long-window efficiency ${er.toFixed(2)} with negative net change`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["efficiencyThreshold"],
    },
};
