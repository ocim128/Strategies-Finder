import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        correlationMin: Math.max(0.05, Math.min(0.95, Number(params.correlationMin ?? 0.25))),
    };
}

export const range_efficiency_correlation_regime: Strategy = {
    name: "Range Efficiency Correlation Regime",
    description: "Follows directional acceptance when range and efficiency are positively correlated, confirming trending regime.",
    defaultParams: {
        lookback: 30,
        correlationMin: 0.25,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMin: "Min Correlation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const ranges = buildRangeSeries(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const effClean = efficiency.map(v => v ?? 0);
        const corr = buildRollingCorrelation(ranges, effClean, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null) return null;
            if (c < (p.correlationMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Range-eff corr ${c.toFixed(2)} bullish acceptance`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Range-eff corr ${c.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMin"],
    },
};
