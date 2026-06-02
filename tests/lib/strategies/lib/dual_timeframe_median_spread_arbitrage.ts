import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming dual-timeframe median spreads represent clean price dislocations.
// #SUGGEST_VERIFY: Verify standard deviation values are non-zero to avoid division or multiplication errors under low volatility.
function normalizeDualTimeframeMedianSpreadArbitrageParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        fastLookback: Math.max(2, Math.round(Number(params.fastLookback ?? 20))),
        slowLookback: Math.max(5, Math.round(Number(params.slowLookback ?? 80))),
    };
}

export const dual_timeframe_median_spread_arbitrage: Strategy = {
    name: "Dual Timeframe Median Spread Arbitrage",
    description: "Trades short-term temporal median spreads that overextend relative to long-term volatility, suggesting statistical reversion.",
    defaultParams: {
        fastLookback: 20,
        slowLookback: 80,
    },
    paramLabels: {
        fastLookback: "Fast Median Lookback",
        slowLookback: "Slow Median Lookback",
    },
    normalizeParams: normalizeDualTimeframeMedianSpreadArbitrageParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDualTimeframeMedianSpreadArbitrageParams(params);
        const fastLookback = p.fastLookback as number;
        const slowLookback = p.slowLookback as number;
        const maxLookback = Math.max(fastLookback, slowLookback);
        if (cleanData.length < maxLookback + 5) return [];

        const closes = getCloses(cleanData);
        const fastMedian = buildRollingMedian(closes, fastLookback);
        const slowMedian = buildRollingMedian(closes, slowLookback);

        const returns = getReturns(cleanData);
        const stddev = buildRollingStdDev(returns, slowLookback);

        return createSignalLoop(cleanData, [fastMedian, slowMedian, stddev], (i) => {
            if (i < maxLookback) return null;
            const fm = fastMedian[i];
            const sm = slowMedian[i];
            const sd = stddev[i];

            if (fm === null || sm === null || sd === null) return null;

            const spread = fm - sm;
            const threshold = 1.5 * sd;

            // Buy logic: (Slow Median - Fast Median) > 1.5 * stddev (fast median is oversold)
            if (-spread > threshold) {
                return createBuySignal(cleanData, i, `Temporal Median Spread Arbitrage Bullish (spread=${spread.toFixed(2)}, threshold=${threshold.toFixed(2)})`);
            }

            // Sell logic: (Fast Median - Slow Median) > 1.5 * stddev (fast median is overbought)
            if (spread > threshold) {
                return createSellSignal(cleanData, i, `Temporal Median Spread Arbitrage Bearish (spread=${spread.toFixed(2)}, threshold=${threshold.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastLookback", "slowLookback"],
    },
};
