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
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

function normalizeCrossPressureInitiativeInversionParams(params: StrategyParams): StrategyParams {
    const initiativeLookback = Math.max(3, Math.round(params.initiativeLookback ?? 15));
    const divergenceLookback = Math.max(5, Math.round(params.divergenceLookback ?? 25));
    const zThreshold = Math.max(0.5, Number(params.zThreshold ?? 2.0));
    return {
        ...params,
        initiativeLookback,
        divergenceLookback,
        zThreshold,
    };
}

export const cross_pressure_initiative_inversion: Strategy = {
    name: "Cross-Pressure Initiative Inversion",
    description: "Signals on z-score extremes of the divergence between primary and secondary initiative pressure. When the primary shows initiative buying while the secondary shows initiative selling, capital is actively rotating.",
    defaultParams: {
        initiativeLookback: 15,
        divergenceLookback: 25,
        zThreshold: 2.0,
    },
    paramLabels: {
        initiativeLookback: "Initiative Lookback",
        divergenceLookback: "Divergence Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeCrossPressureInitiativeInversionParams,
    crossSymbolConfig: {
        defaultSymbol: "ETHUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCrossPressureInitiativeInversionParams(params);
        const minWarmup = p.initiativeLookback + p.divergenceLookback;
        if (cleanData.length < minWarmup) return [];

        const secondaryData = context.crossSymbol.secondaryData;

        const primaryInitiative = buildInitiativePressureSeries(cleanData, p.initiativeLookback as number);
        const secondaryInitiative = buildInitiativePressureSeries(secondaryData, p.initiativeLookback as number);

        const divergence: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const pi = primaryInitiative[i] ?? 0;
            const si = secondaryInitiative[i] ?? 0;
            divergence[i] = pi - si;
        }

        const zscore = buildRollingZScore(divergence, p.divergenceLookback as number);

        return createSignalLoop(cleanData, [zscore], (i) => {
            if (i < minWarmup) return null;
            const z = zscore[i];
            if (z === null) return null;

            if (z > p.zThreshold) {
                return createBuySignal(cleanData, i, `Initiative pressure inversion bullish (z=${z.toFixed(2)})`);
            }
            if (z < -p.zThreshold) {
                return createSellSignal(cleanData, i, `Initiative pressure inversion bearish (z=${z.toFixed(2)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["initiativeLookback", "divergenceLookback", "zThreshold"],
    },
};
