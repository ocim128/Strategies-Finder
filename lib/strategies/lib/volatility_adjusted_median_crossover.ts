import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev, buildEfficiencyRatio } from "./price-action-statistics-core";

const _returns = new WeakMap<OHLCVData[], number[]>();
function getReturns(data: OHLCVData[]): number[] {
    let r = _returns.get(data);
    if (!r) {
        const closes = getCloses(data);
        r = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            r[i] = closes[i] - closes[i - 1];
        }
        _returns.set(data, r);
    }
    return r;
}

// #COMPLETION_DRIVE: Assuming rolling median crossovers are more robust when volatility-adjusted distance and path efficiency are aligned.
// #SUGGEST_VERIFY: Verify standard deviation values are positive and non-zero before threshold evaluation.
function normalizeVolatilityAdjustedMedianCrossoverParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 45))),
        minEfficiency: Math.max(0.01, Math.min(0.99, Number(params.minEfficiency ?? 0.55))),
    };
}

export const volatility_adjusted_median_crossover: Strategy = {
    name: "Volatility Adjusted Median Crossover",
    description: "Enters on rolling median crossovers when the crossing distance exceeds a standard deviation multiple under high path efficiency.",
    defaultParams: {
        lookback: 45,
        minEfficiency: 0.55,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Minimum Efficiency",
    },
    normalizeParams: normalizeVolatilityAdjustedMedianCrossoverParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityAdjustedMedianCrossoverParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);

        const median = buildRollingMedian(closes, lookback);
        const stddev = buildRollingStdDev(returns, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [median, stddev, efficiency], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentMedian = median[i];
            const prevMedian = median[i - 1];
            const sd = stddev[i];
            const eff = efficiency[i];

            if (currentMedian === null || prevMedian === null || sd === null || eff === null) return null;
            if (eff <= p.minEfficiency) return null;

            const distance = Math.abs(currentClose - currentMedian);
            const threshold = 0.5 * sd;

            if (distance > threshold) {
                // Buy: Close crosses above median
                if (prevClose <= prevMedian && currentClose > currentMedian) {
                    return createBuySignal(cleanData, i, `Volatility Gated Crossover Bullish (dist=${distance.toFixed(3)} > thresh=${threshold.toFixed(3)}, eff=${eff.toFixed(3)})`);
                }
                // Sell: Close crosses below median
                if (prevClose >= prevMedian && currentClose < currentMedian) {
                    return createSellSignal(cleanData, i, `Volatility Gated Crossover Bearish (dist=${distance.toFixed(3)} > thresh=${threshold.toFixed(3)}, eff=${eff.toFixed(3)})`);
                }
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
