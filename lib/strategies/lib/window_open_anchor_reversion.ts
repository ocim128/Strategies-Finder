import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";

const ATR_PERIOD = 20;
const WINDOW_OPEN_STRETCH = 2.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const window_open_anchor_reversion: Strategy = {
    name: "Window Open Anchor Reversion",
    description: "Fades closes stretched at least 2.5 ATR from the opening price of the bar that started the trailing window.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Window Open Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const opens = getOpens(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < lookback + 1) return null;
            const a = atr[i];
            if (a === null || a <= 0) return null;

            // Fixed, non-repainting reference: the open of the bar `lookback`
            // bars ago never moves with price.
            const stretch = (closes[i] - opens[i - lookback]) / a;
            if (stretch <= -WINDOW_OPEN_STRETCH) {
                return createBuySignal(cleanData, i, `Close ${(-stretch).toFixed(2)} ATR below window open`);
            }
            if (stretch >= WINDOW_OPEN_STRETCH) {
                return createSellSignal(cleanData, i, `Close ${stretch.toFixed(2)} ATR above window open`);
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
