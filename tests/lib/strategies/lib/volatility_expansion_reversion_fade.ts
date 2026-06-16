import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    buildEfficiencyRatio,
    buildPercentileRank,
    buildRollingStdDev,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        volPercentileMin: Math.max(0, Math.min(1, Number(params.volPercentileMin ?? 0.85))),
        maxEfficiency: Math.max(0, Math.min(1, Number(params.maxEfficiency ?? 0.20))),
    };
}

export const volatility_expansion_reversion_fade: Strategy = {
    name: "Volatility Expansion Reversion Fade",
    description: "Fades high-volatility breakouts that lack path efficiency and close location conviction.",
    defaultParams: {
        lookback: 30,
        volPercentileMin: 0.85,
        maxEfficiency: 0.20,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volPercentileMin: "Min Volatility Percentile",
        maxEfficiency: "Max Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const stdDev = buildRollingStdDev(returns, lookback);
        const stdDevNumbers = stdDev.map((v) => (v !== null ? v : 0));
        const volPctl = buildPercentileRank(stdDevNumbers, lookback);

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volPctl, efficiency], (i) => {
            const vp = volPctl[i];
            const er = efficiency[i];
            if (vp === null || er === null) return null;

            const cl = closeLocation[i];

            if (vp > p.volPercentileMin && er < p.maxEfficiency) {
                // Buy: high volatility, low efficiency, and close location is low -> fade buy
                if (cl < 0.3) {
                    return createBuySignal(cleanData, i, `Volatility expansion fade buy: vol rank ${vp.toFixed(2)}, ER ${er.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                // Sell: high volatility, low efficiency, and close location is high -> fade sell
                if (cl > 0.7) {
                    return createSellSignal(cleanData, i, `Volatility expansion fade sell: vol rank ${vp.toFixed(2)}, ER ${er.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMin", "maxEfficiency"],
    },
};
