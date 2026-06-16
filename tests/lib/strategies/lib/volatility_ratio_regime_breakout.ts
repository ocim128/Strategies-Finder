import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    buildPercentileRank,
    buildRollingStdDev,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(11, Math.round(Number(params.lookback ?? 40))),
        pctThreshold: Math.max(0, Math.min(1, Number(params.pctThreshold ?? 0.90))),
    };
}

export const volatility_ratio_regime_breakout: Strategy = {
    name: "Volatility Ratio Regime Breakout",
    description: "Follows trend breakouts triggered by surges in short-term vs long-term return volatility.",
    defaultParams: {
        lookback: 40,
        pctThreshold: 0.90,
    },
    paramLabels: {
        lookback: "Long-term Window",
        pctThreshold: "Ratio Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        // Short-term 10-bar volatility vs Long-term lookback-bar volatility
        const shortVol = buildRollingStdDev(returns, 10);
        const longVol = buildRollingStdDev(returns, lookback);

        const volRatio = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const sv = shortVol[i];
            const lv = longVol[i];
            volRatio[i] = (sv !== null && lv !== null && lv > 1e-12) ? sv / lv : 0;
        }

        const volRatioPctl = buildPercentileRank(volRatio, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volRatioPctl], (i) => {
            const vp = volRatioPctl[i];
            if (vp === null) return null;

            const cl = closeLocation[i];

            if (vp > p.pctThreshold) {
                if (cl > 0.7) {
                    return createBuySignal(cleanData, i, `Volatility ratio breakout buy: percentile ${vp.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                if (cl < 0.3) {
                    return createSellSignal(cleanData, i, `Volatility ratio breakout sell: percentile ${vp.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctThreshold"],
    },
};
