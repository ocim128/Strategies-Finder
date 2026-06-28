import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildCumulativeDecaySum, buildPercentileRank, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        decay: Math.max(0.5, Math.min(0.99, Number(params.decay ?? 0.90))),
        skewPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.skewPercentileMin ?? 0.70))),
    };
}

export const decaying_return_skewness_autocorrelation: Strategy = {
    name: "Decaying Return Skewness Autocorrelation",
    description: "Follows directional drift when decay-weighted cumulative returns show strong skew with autocorrelation persistence.",
    defaultParams: {
        lookback: 30,
        decay: 0.90,
        skewPercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        decay: "Decay Factor",
        skewPercentileMin: "Min Skew Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);

        // 1-bar returns
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);

        // Decay-weighted cumulative sum of returns
        const decaySum = buildCumulativeDecaySum(returnsClean, p.decay as number);

        // Percentile rank of decay sum
        const decayPctl = buildPercentileRank(decaySum, lookback);

        // Return autocorrelation for persistence
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);

        return createSignalLoop(cleanData, [decayPctl, autocorr], (i) => {
            const dp = decayPctl[i];
            const ac = autocorr[i];
            if (dp === null || ac === null) return null;

            const skewMin = p.skewPercentileMin as number;

            // Buy: positive directional skew + positive autocorrelation
            if (dp > skewMin && ac > 0) {
                return createBuySignal(cleanData, i, `Decay pctl ${dp.toFixed(2)} autocorr ${ac.toFixed(2)} bullish drift`);
            }
            // Sell: negative directional skew + positive autocorrelation
            if (dp < (1 - skewMin) && ac > 0) {
                return createSellSignal(cleanData, i, `Decay pctl ${dp.toFixed(2)} autocorr ${ac.toFixed(2)} bearish drift`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "skewPercentileMin"],
    },
};
