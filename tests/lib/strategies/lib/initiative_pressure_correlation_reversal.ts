import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming initiative pressure correlation reversal robustly indicates passive order-book absorption.
// #SUGGEST_VERIFY: Verify trailing high/low range calculations are not flat to prevent division by zero or invalid boundary percentiles.
function normalizeInitiativePressureCorrelationReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        maxCorrelation: Number(params.maxCorrelation ?? -0.5),
    };
}

export const initiative_pressure_correlation_reversal: Strategy = {
    name: "Initiative Pressure Correlation Reversal",
    description: "Signals reversion when close is near range limits and rolling correlation between price returns and initiative pressure is strongly negative, showing passive absorption.",
    defaultParams: {
        lookback: 30,
        maxCorrelation: -0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxCorrelation: "Max Correlation",
    },
    normalizeParams: normalizeInitiativePressureCorrelationReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureCorrelationReversalParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);
        const initiative = buildInitiativePressureSeries(cleanData, lookback);

        const initiativeClean = initiative.map(v => v ?? 0);
        const corr = buildRollingCorrelation(returns, initiativeClean, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [corr, highest, lowest], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentCorr = corr[i];
            const hi = highest[i];
            const lo = lowest[i];

            if (currentCorr === null || hi === null || lo === null) return null;

            const range = hi - lo;
            if (range <= 0) return null;

            const distToLowPct = (currentClose - lo) / range;
            const distToHighPct = (hi - currentClose) / range;

            if (currentCorr < p.maxCorrelation) {
                // Buy: Close is within 5% of trailing low boundary
                if (distToLowPct <= 0.05) {
                    return createBuySignal(cleanData, i, `Initiative Correlation Reversal Bullish (corr=${currentCorr.toFixed(3)}, distLow=${(distToLowPct * 100).toFixed(1)}%)`);
                }
                // Sell: Close is within 5% of trailing high boundary
                if (distToHighPct <= 0.05) {
                    return createSellSignal(cleanData, i, `Initiative Correlation Reversal Bearish (corr=${currentCorr.toFixed(3)}, distHigh=${(distToHighPct * 100).toFixed(1)}%)`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxCorrelation"],
    },
};
