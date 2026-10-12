import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
    normalizeLookbackParams as normalizeParams,
} from "../strategy-helpers";
import { calculateZeroLagEma } from "../trend-confirmation-indicators";

export const zero_lag_ema_confirmation: Strategy = {
    name: "Zero-Lag EMA Confirmation",
    description: "Confirms direction relative to a de-lagged EMA input derived from the same lookback.",
    defaultParams: {
        lookback: 200,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        const closes = getCloses(cleanData);
        const zlema = calculateZeroLagEma(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [zlema], (i) => {
            if (closes[i] > zlema[i]!) return createBuySignal(cleanData, i, "Close above zero-lag EMA");
            if (closes[i] < zlema[i]!) return createSellSignal(cleanData, i, "Close below zero-lag EMA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
