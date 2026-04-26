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
import { buildRollingCorrelation, buildRollingMedian } from "./price-action-statistics-core";
import { buildRelativeStrength } from "./cross-symbol-helpers";

function normalizeCrossSymbolCorrelationTrendParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 30)),
        correlation_threshold: Math.max(-1, Math.min(1, Number(params.correlation_threshold ?? 0.5))),
    };
}

export const cross_symbol_correlation_trend: Strategy = {
    name: "Cross-Symbol Correlation Trend",
    description: "When two symbols are co-moving and the primary's relative strength ratio is above its own rolling median, the primary is leading the pair. The same logic in reverse defines downside leadership.",
    defaultParams: {
        lookback: 30,
        correlation_threshold: 0.5,
    },
    paramLabels: {
        lookback: "Lookback",
        correlation_threshold: "Correlation Threshold",
    },
    normalizeParams: normalizeCrossSymbolCorrelationTrendParams,
    crossSymbolConfig: {
        defaultSymbol: "BTCUSDT",
        userSelectable: true,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const secondaryData = ensureCleanData(context.crossSymbol.secondaryData);
        const p = normalizeCrossSymbolCorrelationTrendParams(params);
        const lookback = p.lookback as number;
        const threshold = p.correlation_threshold as number;
        if (cleanData.length < lookback + 1 || secondaryData.length < lookback + 1) return [];

        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);
        const correlation = buildRollingCorrelation(primaryCloses, secondaryCloses, lookback);
        const ratio = buildRelativeStrength(primaryCloses, secondaryCloses);
        const ratioMedian = buildRollingMedian(ratio, lookback);

        return createSignalLoop(cleanData, [correlation, ratioMedian], (i) => {
            const corr = correlation[i];
            const median = ratioMedian[i];
            const rs = ratio[i];
            if (corr === null || median === null || !Number.isFinite(rs) || corr <= threshold) return null;

            if (rs > median) {
                return createBuySignal(cleanData, i, `Corr ${corr.toFixed(3)} > ${threshold} and RS ${rs.toFixed(4)} above median ${median.toFixed(4)}`);
            }
            if (rs < median) {
                return createSellSignal(cleanData, i, `Corr ${corr.toFixed(3)} > ${threshold} and RS ${rs.toFixed(4)} below median ${median.toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlation_threshold"],
    },
};
