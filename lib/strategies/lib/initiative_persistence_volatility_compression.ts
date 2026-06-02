import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingStdDev } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming initiative pressure autocorrelation under volatility compression robustly triggers entries.
// #SUGGEST_VERIFY: Verify standard deviation ranking window behaves correctly and is causal.
function normalizeInitiativePersistenceVolatilityCompressionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        minAutoCorr: Math.max(0.01, Math.min(0.99, Number(params.minAutoCorr ?? 0.5))),
    };
}

export const initiative_persistence_volatility_compression: Strategy = {
    name: "Initiative Persistence Volatility Compression",
    description: "Signals when highly autocorrelated initiative pressure is observed during a volatility compression phase, capturing highly organized stealth positioning.",
    defaultParams: {
        lookback: 30,
        minAutoCorr: 0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Min Autocorrelation",
    },
    normalizeParams: normalizeInitiativePersistenceVolatilityCompressionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePersistenceVolatilityCompressionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 10) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const scores = initiative.map(v => v ?? 0);
        const autoCorr = buildRollingAutoCorrelation(scores, lookback, 1);

        const returns = getReturns(cleanData);
        const stddev = buildRollingStdDev(returns, lookback);

        // Precompute standard deviation percentile ranks within their trailing window
        const stddevClean = stddev.map(v => v ?? 0);
        const stdPercentiles: number[] = new Array(cleanData.length).fill(0.5);

        for (let i = lookback; i < cleanData.length; i++) {
            const start = i - lookback + 1;
            const currentVal = stddevClean[i];
            let lowerCount = 0;
            let totalCount = 0;
            for (let j = start; j <= i; j++) {
                totalCount++;
                if (stddevClean[j] < currentVal) {
                    lowerCount++;
                }
            }
            stdPercentiles[i] = totalCount > 0 ? lowerCount / totalCount : 0.5;
        }

        return createSignalLoop(cleanData, [initiative, autoCorr, stddev], (i) => {
            if (i < lookback) return null;
            const currentPressure = initiative[i];
            const currentAuto = autoCorr[i];
            const pct = stdPercentiles[i];

            if (currentPressure === null || currentAuto === null) return null;

            // Volatility compression check: standard deviation is in the bottom 40% of its trailing window
            if (pct <= 0.4 && currentAuto > p.minAutoCorr) {
                // Buy: Initiative pressure is positive
                if (currentPressure > 0) {
                    return createBuySignal(cleanData, i, `Initiative Persistence Squeeze Bullish (autoCorr=${currentAuto.toFixed(3)}, stdPct=${(pct * 100).toFixed(0)}%)`);
                }
                // Sell: Initiative pressure is negative
                if (currentPressure < 0) {
                    return createSellSignal(cleanData, i, `Initiative Persistence Squeeze Bearish (autoCorr=${currentAuto.toFixed(3)}, stdPct=${(pct * 100).toFixed(0)}%)`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAutoCorr"],
    },
};
