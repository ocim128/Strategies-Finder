import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateEMA } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        emaPeriod: Math.max(2, Math.round(Number(params.emaPeriod ?? 50))),
    };
}

// Emits buy while close is above its EMA and sell while below. Intended as a
// confirmation strategy (confirmationMode: "agree") so a base entry on a
// synthetic ratio series survives only when the ratio is above its trend line,
// i.e. when the base leg is outperforming the side leg in trend terms.
export const ema_confirmation: Strategy = {
    name: "EMA Confirmation",
    description: "Confirms entries only while close trades above (long) or below (short) its EMA. Use as an entry confirmation strategy.",
    defaultParams: {
        emaPeriod: 50,
    },
    paramLabels: {
        emaPeriod: "EMA Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const emaPeriod = p.emaPeriod as number;
        if (cleanData.length < emaPeriod + 1) return [];

        const closes = getCloses(cleanData);
        const ema = calculateEMA(closes, emaPeriod);

        return createSignalLoop(cleanData, [ema], (i) => {
            if (i < emaPeriod) return null;
            const e = ema[i];
            if (e === null) return null;

            if (closes[i] > e) {
                return createBuySignal(cleanData, i, "Close above EMA");
            }
            if (closes[i] < e) {
                return createSellSignal(cleanData, i, "Close below EMA");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["emaPeriod"],
    },
};
