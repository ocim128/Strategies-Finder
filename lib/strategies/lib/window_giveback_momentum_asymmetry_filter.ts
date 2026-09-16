import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        up_giveback_max: Math.max(0.01, Math.min(1, Number(params.up_giveback_max ?? 0.2))),
    };
}

export const window_giveback_momentum_asymmetry_filter: Strategy = {
    name: "Window Giveback Momentum Asymmetry Filter",
    description: "Applies asymmetric speed filtering: strict shallow giveback for bullish momentum vs loose drift tolerance for shorts.",
    defaultParams: {
        up_giveback_max: 0.2,
    },
    paramLabels: {
        up_giveback_max: "Max Long Giveback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const up_giveback_max = p.up_giveback_max as number;
        if (cleanData.length < 20 + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, 20);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 20) return null;
            const g = gb[i];
            if (g === null) return null;

            if (closes[i] > closes[i - 20] && g <= up_giveback_max && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish asymmetric momentum: giveback ${g.toFixed(3)} <= ${up_giveback_max}, bull bar in up-window`);
            }
            if (closes[i] < closes[i - 20] && g <= 0.50 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish asymmetric drift: giveback ${g.toFixed(3)} <= 0.50, bear bar in down-window`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["up_giveback_max"],
    },
};
