import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildEfficiencyRatio,
    buildRateOfChange,
    buildRollingSkewness,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        skewThreshold: Math.max(0, Number(params.skewThreshold ?? 1.5)),
        erMin: Math.max(0, Math.min(1, Number(params.erMin ?? 0.15))),
    };
}

export const return_skewness_dislocation_fade: Strategy = {
    name: "Return Skewness Dislocation Fade",
    description: "Fades return distribution skewness extremes in non-choppy (efficient) regimes.",
    defaultParams: {
        lookback: 30,
        skewThreshold: 1.5,
        erMin: 0.15,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewThreshold: "Skewness Threshold",
        erMin: "Min Efficiency Ratio",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const retNumbers = returns.map((v) => (v !== null ? v : 0));

        const skew = buildRollingSkewness(retNumbers, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [skew, efficiency], (i) => {
            const s = skew[i];
            const er = efficiency[i];
            if (s === null || er === null) return null;

            if (er > p.erMin) {
                // Buy: negative skewness (overload to downside) with high efficiency -> long reversion
                if (s < -p.skewThreshold) {
                    return createBuySignal(cleanData, i, `Skewness fade buy: skew ${s.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
                // Sell: positive skewness (overload to upside) with high efficiency -> short reversion
                if (s > p.skewThreshold) {
                    return createSellSignal(cleanData, i, `Skewness fade sell: skew ${s.toFixed(2)}, ER ${er.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "erMin"],
    },
};
