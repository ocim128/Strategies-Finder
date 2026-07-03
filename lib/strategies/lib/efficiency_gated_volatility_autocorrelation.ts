import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Number(params.minEfficiency ?? 0.6),
    };
}

export const efficiency_gated_volatility_autocorrelation: Strategy = {
    name: "Efficiency-Gated Volatility Autocorrelation",
    description: "Trend following strategy combining Kaufman Efficiency Ratio and return autocorrelation gating.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Min Efficiency Ratio",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const er = buildEfficiencyRatio(cleanData, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [ac, er, closeLoc], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentEr = er[i];
            const currentLoc = closeLoc[i];
            if (currentAc === null || currentEr === null) return null;

            // Buy: autocorrelation of close returns > 0.2, efficiency ratio > minEfficiency, and close location > 0.75
            if (currentAc > 0.2 && currentEr > (p.minEfficiency as number) && currentLoc > 0.75) {
                return createBuySignal(cleanData, i, `Eff Gated AC Buy: AC ${currentAc.toFixed(2)}, ER ${currentEr.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }
            // Sell: autocorrelation of close returns > 0.2, efficiency ratio > minEfficiency, and close location < 0.25
            if (currentAc > 0.2 && currentEr > (p.minEfficiency as number) && currentLoc < 0.25) {
                return createSellSignal(cleanData, i, `Eff Gated AC Sell: AC ${currentAc.toFixed(2)}, ER ${currentEr.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
