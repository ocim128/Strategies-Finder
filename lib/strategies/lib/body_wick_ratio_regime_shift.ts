import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        bodyPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.bodyPercentileMin ?? 0.65))),
    };
}

export const body_wick_ratio_regime_shift: Strategy = {
    name: "Body Wick Ratio Regime Shift",
    description: "Follows directional acceptance when body percentage percentile confirms a trending regime shift from ranging.",
    defaultParams: {
        lookback: 30,
        bodyPercentileMin: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        bodyPercentileMin: "Min Body Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const bodyPctl = buildPercentileRank(bodyPct, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [bodyPctl], (i) => {
            const bp = bodyPctl[i];
            if (bp === null) return null;
            if (bp < (p.bodyPercentileMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Body pctl ${bp.toFixed(2)} trending regime bullish`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Body pctl ${bp.toFixed(2)} trending regime bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "bodyPercentileMin"],
    },
};
