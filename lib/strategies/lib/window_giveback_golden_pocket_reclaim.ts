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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 26))),
    };
}

export const window_giveback_golden_pocket_reclaim: Strategy = {
    name: "Window Giveback Golden Pocket Reclaim",
    description: "Captures trend continuation when window giveback ratio contracts back below the 0.618 golden pocket level.",
    defaultParams: {
        lookback: 26,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback) return null;
            const prevGb = gb[i - 1];
            const currGb = gb[i];
            if (prevGb === null || currGb === null) return null;

            if (prevGb > 0.618 && currGb <= 0.618) {
                if (closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish golden pocket reclaim: giveback crossed below 0.618 (${prevGb.toFixed(3)} -> ${currGb.toFixed(3)}), close > close[i-${lookback}]`);
                }
                if (closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish golden pocket reclaim: giveback crossed below 0.618 (${prevGb.toFixed(3)} -> ${currGb.toFixed(3)}), close < close[i-${lookback}]`);
                }
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
