import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingHighLow, buildRollingAverage } from "./price-action-frequency-core";
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

// #COMPLETION_DRIVE: Assuming systematic volatility expansion confirms institutional boundary breakouts.
// #SUGGEST_VERIFY: Verify standard deviation values are positive and non-zero before multiplying by rise factor.
function normalizeVolatilityRegimeBoundaryAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStdDevRise: Math.max(0.1, Number(params.minStdDevRise ?? 1.05)),
    };
}

export const volatility_regime_boundary_acceptance: Strategy = {
    name: "Volatility Regime Boundary Acceptance",
    description: "Signals boundary breakouts under rising volatility regimes confirmed by positive or negative close acceptance.",
    defaultParams: {
        lookback: 30,
        minStdDevRise: 1.05,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStdDevRise: "Minimum Volatility Rise",
    },
    normalizeParams: normalizeVolatilityRegimeBoundaryAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityRegimeBoundaryAcceptanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const stddev = buildRollingStdDev(returns, lookback);
        const stddevClean = stddev.map(v => v ?? 0);
        const avgStddev = buildRollingAverage(stddevClean, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest, stddev, avgStddev, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const sd = stddev[i];
            const avg = avgStddev[i];
            const acc = closeAcceptance[i];

            if (hi === null || lo === null || sd === null || avg === null || acc === null) return null;

            const threshold = p.minStdDevRise * avg;

            // Buy logic: Close breaks above trailing high, close acceptance is positive, and current standard deviation is > minStdDevRise times its average
            if (currentClose > hi && acc > 0 && sd > threshold) {
                return createBuySignal(cleanData, i, `Bullish Boundary Vol-Expansion (close=${currentClose.toFixed(2)}, stddev=${sd.toFixed(5)} > thresh=${threshold.toFixed(5)})`);
            }

            // Sell logic: Close breaks below trailing low, close acceptance is negative, and current standard deviation is > minStdDevRise times its average
            if (currentClose < lo && acc < 0 && sd > threshold) {
                return createSellSignal(cleanData, i, `Bearish Boundary Vol-Expansion (close=${currentClose.toFixed(2)}, stddev=${sd.toFixed(5)} > thresh=${threshold.toFixed(5)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStdDevRise"],
    },
};
