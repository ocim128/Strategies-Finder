import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
        efficiencyThreshold: Math.max(0, Math.min(1, Number(params.efficiencyThreshold ?? 0.60))),
    };
}

export const efficiency_gated_decoupling_break: Strategy = {
    name: "Efficiency Gated Decoupling Break",
    description: "Chases breakouts with high efficiency ratio and strong closing pressure.",
    defaultParams: {
        lookback: 35,
        efficiencyThreshold: 0.60,
    },
    paramLabels: {
        lookback: "Lookback Window",
        efficiencyThreshold: "Efficiency Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const er = efficiency[i];
            if (er === null || i < lookback) return null;

            const cl = closeLocation[i];
            const change = closes[i] - closes[i - lookback];

            if (er > p.efficiencyThreshold) {
                if (change > 0 && cl > 0.7) {
                    return createBuySignal(cleanData, i, `Efficiency breakout buy: ER ${er.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                if (change < 0 && cl < 0.3) {
                    return createSellSignal(cleanData, i, `Efficiency breakout sell: ER ${er.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyThreshold"],
    },
};
