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
import { buildRollingCorrelation, buildRateOfChange } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingPairCorrelation } from "./cross-symbol-helpers";

function normalizeCloseLocationCorrelationBreakParams(params: StrategyParams): StrategyParams {
    const lookback = Math.max(5, Math.round(params.lookback ?? 25));
    return {
        ...params,
        lookback,
    };
}

export const close_location_correlation_break: Strategy = {
    name: "Close Location Correlation Break",
    description: "Signals when close-location correlation between the pair declines (auction quality diverging) while price correlation remains stable â€” hidden regime break preceding visible price decoupling.",
    defaultParams: {
        lookback: 25,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCloseLocationCorrelationBreakParams,
    crossSymbolConfig: {
        defaultSymbol: "BTCUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationCorrelationBreakParams(params);
        if (cleanData.length < p.lookback * 2) return [];

        const secondaryData = context.crossSymbol.secondaryData;
        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);

        const priceCorr = buildRollingPairCorrelation(primaryCloses, secondaryCloses, p.lookback as number);

        const primaryCLC = buildCloseLocationSeries(cleanData);
        const secondaryCLC = buildCloseLocationSeries(secondaryData);
        const clcCorr = buildRollingCorrelation(primaryCLC, secondaryCLC, p.lookback as number);
        const clcCorrROC = buildRateOfChange(clcCorr.map(v => v ?? 0), 3);

        return createSignalLoop(cleanData, [priceCorr, clcCorrROC], (i) => {
            if (i < p.lookback * 2) return null;
            const pc = priceCorr[i];
            const clcROC = clcCorrROC[i];
            if (pc === null || clcROC === null) return null;

            if (clcROC < 0 && pc > 0.5 && primaryCLC[i] > 0.6) {
                return createBuySignal(cleanData, i, `Auction quality diverging, primary closing strong (clcCorr declining)`);
            }
            if (clcROC < 0 && pc > 0.5 && primaryCLC[i] < 0.4) {
                return createSellSignal(cleanData, i, `Auction quality diverging, primary closing weak (clcCorr declining)`);
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





