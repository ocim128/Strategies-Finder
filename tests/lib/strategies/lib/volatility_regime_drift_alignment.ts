import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming low-volatility return standard deviation compression gates steady, persistent close location drifts.
// #SUGGEST_VERIFY: Verify standard deviation ranking window behaves correctly and is causal.
function normalizeVolatilityRegimeDriftAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        clsLocThreshold: Math.max(0.5, Math.min(0.99, Number(params.clsLocThreshold ?? 0.65))),
    };
}

export const volatility_regime_drift_alignment: Strategy = {
    name: "Volatility Regime Drift Alignment",
    description: "Captures steady price drift when it occurs during a low-volatility regime, avoiding counter-trend traps.",
    defaultParams: {
        lookback: 30,
        clsLocThreshold: 0.65,
    },
    paramLabels: {
        lookback: "Lookback Window",
        clsLocThreshold: "Close Location Threshold",
    },
    normalizeParams: normalizeVolatilityRegimeDriftAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityRegimeDriftAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);

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

        return createSignalLoop(cleanData, [avgCloseLoc, stddev], (i) => {
            if (i < lookback) return null;
            const currentAvgLoc = avgCloseLoc[i];
            const pct = stdPercentiles[i];

            if (currentAvgLoc === null) return null;

            // Volatility compression check: standard deviation is in the bottom 40% of its trailing window (pct <= 0.40)
            if (pct <= 0.40) {
                // Buy: Rolling average close location is above clsLocThreshold
                if (currentAvgLoc > p.clsLocThreshold) {
                    return createBuySignal(cleanData, i, `Volatility Compressed Drift Bullish (avgLoc=${currentAvgLoc.toFixed(3)}, stdPct=${(pct * 100).toFixed(0)}%)`);
                }
                // Sell: Rolling average close location is below 1 minus clsLocThreshold
                if (currentAvgLoc < 1 - (p.clsLocThreshold as number)) {
                    return createSellSignal(cleanData, i, `Volatility Compressed Drift Bearish (avgLoc=${currentAvgLoc.toFixed(3)}, stdPct=${(pct * 100).toFixed(0)}%)`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clsLocThreshold"],
    },
};
