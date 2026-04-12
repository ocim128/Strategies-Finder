import type {
    Strategy,
    OHLCVData,
    StrategyParams,
    StrategyExecutionContext,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildRollingPairCorrelation } from "./cross-symbol-helpers";

function normalizeCorrelationFlashGammaTriggerParams(params: StrategyParams): StrategyParams {
    const corrLookback = Math.max(3, Math.round(params.corrLookback ?? 10));
    const corrDropThreshold = Math.max(-1, Math.min(0, Number(params.corrDropThreshold ?? -0.15)));
    return {
        ...params,
        corrLookback,
        corrDropThreshold,
    };
}

export const correlation_flash_gamma_trigger: Strategy = {
    name: "Correlation Flash Gamma Trigger",
    description: "Signals when rolling pair correlation drops sharply (flash decoupling) with high body pct on the primary bar — a vol-expansion gamma trigger with directional conviction.",
    defaultParams: {
        corrLookback: 10,
        corrDropThreshold: -0.15,
    },
    paramLabels: {
        corrLookback: "Correlation Lookback",
        corrDropThreshold: "Correlation Drop Threshold",
    },
    normalizeParams: normalizeCorrelationFlashGammaTriggerParams,
    crossSymbolConfig: {
        defaultSymbol: "BTCUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCorrelationFlashGammaTriggerParams(params);
        if (cleanData.length < p.corrLookback * 2) return [];

        const secondaryData = context.crossSymbol.secondaryData;
        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);

        const correlation = buildRollingPairCorrelation(primaryCloses, secondaryCloses, p.corrLookback as number);
        const corrNumbers: number[] = correlation.map(v => v ?? 0);
        const corrROC = buildRateOfChange(corrNumbers, 2);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [correlation], (i) => {
            if (i < p.corrLookback * 2) return null;
            const roc = corrROC[i];
            if (roc === null) return null;

            if (roc < p.corrDropThreshold && bodyPct[i] > 0.6 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Flash decoupling with bullish body (corrROC=${roc.toFixed(3)})`);
            }
            if (roc < p.corrDropThreshold && bodyPct[i] > 0.6 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Flash decoupling with bearish body (corrROC=${roc.toFixed(3)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["corrLookback", "corrDropThreshold"],
    },
};
