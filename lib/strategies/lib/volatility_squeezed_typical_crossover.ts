import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming rolling standard deviation of returns percentile rank robustly identifies high-compression setups.
// #SUGGEST_VERIFY: Verify that the volatility percentile rank is computed dynamically and is causal.
function normalizeVolatilitySqueezedTypicalCrossoverParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        volPercentile: Math.max(1, Math.min(100, Number(params.volPercentile ?? 25))),
    };
}

export const volatility_squeezed_typical_crossover: Strategy = {
    name: "Volatility Squeezed Typical Crossover",
    description: "Enters on rolling median crossover when standard deviation of returns resides at a historical percentile low (volatility squeeze).",
    defaultParams: {
        lookback: 40,
        volPercentile: 25,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentile: "Volatility Percentile Max",
    },
    normalizeParams: normalizeVolatilitySqueezedTypicalCrossoverParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilitySqueezedTypicalCrossoverParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const returns = getReturns(cleanData);
        const stddev = buildRollingStdDev(returns, lookback);
        const stddevClean = stddev.map(v => v ?? 0);
        const volRank = buildPercentileRank(stddevClean, lookback);

        const threshold = (p.volPercentile as number) / 100;

        return createSignalLoop(cleanData, [median, volRank], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentMedian = median[i];
            const prevMedian = median[i - 1];
            const rank = volRank[i];

            if (currentMedian === null || prevMedian === null || rank === null) return null;

            // Check volatility squeeze condition
            if (rank <= threshold) {
                // Bullish: Close crosses above the rolling median
                if (prevClose <= prevMedian && currentClose > currentMedian) {
                    return createBuySignal(cleanData, i, `Volatility Squeezed Crossover Bullish (volRank=${(rank * 100).toFixed(0)}%, close=${currentClose.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
                }

                // Bearish: Close crosses below the rolling median
                if (prevClose >= prevMedian && currentClose < currentMedian) {
                    return createSellSignal(cleanData, i, `Volatility Squeezed Crossover Bearish (volRank=${(rank * 100).toFixed(0)}%, close=${currentClose.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentile"],
    },
};
