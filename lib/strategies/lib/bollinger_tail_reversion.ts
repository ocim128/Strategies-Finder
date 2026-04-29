import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateBollingerBands } from "../indicators";

function normalizeBollingerTailReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        std_dev: Math.max(0.1, Math.abs(Number(params.std_dev ?? 2))),
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const bollinger_tail_reversion: Strategy = {
    name: "Bollinger Tail Reversion",
    description:
        "Fades closes outside a Bollinger envelope, assuming volatility-band breaches will snap back toward the rolling mean.",
    defaultParams: {
        std_dev: 2,
        lookback: 20,
    },
    paramLabels: {
        std_dev: "Std Dev",
        lookback: "Lookback",
    },
    normalizeParams: normalizeBollingerTailReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBollingerTailReversionParams(params);
        const lookback = p.lookback as number;
        const stdDev = p.std_dev as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const bands = calculateBollingerBands(closes, lookback, stdDev);

        return createSignalLoop(cleanData, [bands.upper, bands.lower], (i) => {
            const upper = bands.upper[i];
            const lower = bands.lower[i];
            if (upper === null || lower === null) return null;

            if (closes[i] < lower) {
                return createBuySignal(cleanData, i, "Close below lower Bollinger Band");
            }
            if (closes[i] > upper) {
                return createSellSignal(cleanData, i, "Close above upper Bollinger Band");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["std_dev", "lookback"],
    },
};
