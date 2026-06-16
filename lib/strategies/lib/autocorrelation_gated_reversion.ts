import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        acThreshold: Math.max(-1, Math.min(1, Number(params.acThreshold ?? -0.2))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const autocorrelation_gated_reversion: Strategy = {
    name: "Autocorrelation Gated Reversion",
    description: "Fades extreme stretches only when return autocorrelation indicates a mean-reverting regime.",
    defaultParams: {
        lookback: 40,
        acThreshold: -0.2,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acThreshold: "Autocorrelation Threshold",
        zThreshold: "Return Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const zScore = buildRollingZScore(returns, lookback);
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

        return createSignalLoop(cleanData, [zScore, autoCorr], (i) => {
            const z = zScore[i];
            const ac = autoCorr[i];
            if (z === null || ac === null) return null;

            if (ac < p.acThreshold) {
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Autocorrelation gated buy: Z-score ${z.toFixed(2)} with AC ${ac.toFixed(2)}`);
                }
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Autocorrelation gated sell: Z-score ${z.toFixed(2)} with AC ${ac.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acThreshold", "zThreshold"],
    },
};
