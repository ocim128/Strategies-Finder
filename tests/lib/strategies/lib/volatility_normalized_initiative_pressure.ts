import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
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

// #COMPLETION_DRIVE: Assuming initiative pressure normalized by return standard deviation isolates high-conviction institutional footprints.
// #SUGGEST_VERIFY: Verify standard deviation values are positive and non-zero before dividing.
function normalizeVolatilityNormalizedInitiativePressureParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        pressureThreshold: Math.max(0.1, Number(params.pressureThreshold ?? 2.5)),
    };
}

export const volatility_normalized_initiative_pressure: Strategy = {
    name: "Volatility Normalized Initiative Pressure",
    description: "Signals when initiative pressure normalized by rolling standard deviation of returns exceeds a threshold, isolating structural imbalances.",
    defaultParams: {
        lookback: 35,
        pressureThreshold: 2.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pressureThreshold: "Pressure Threshold",
    },
    normalizeParams: normalizeVolatilityNormalizedInitiativePressureParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityNormalizedInitiativePressureParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const returns = getReturns(cleanData);
        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const stddev = buildRollingStdDev(returns, lookback);

        return createSignalLoop(cleanData, [initiative, stddev], (i) => {
            if (i < lookback) return null;
            const currentPressure = initiative[i];
            const currentStd = stddev[i];

            if (currentPressure === null || currentStd === null || currentStd <= 0) return null;

            const normalizedPressure = currentPressure / currentStd;

            // Buy: Initiative pressure is positive and normalized pressure > pressureThreshold
            if (currentPressure > 0 && normalizedPressure > p.pressureThreshold) {
                return createBuySignal(cleanData, i, `Volatility Normalized Pressure Bullish (normPressure=${normalizedPressure.toFixed(2)}, stddev=${currentStd.toFixed(5)})`);
            }

            // Sell: Initiative pressure is negative and normalized pressure < -pressureThreshold
            if (currentPressure < 0 && normalizedPressure < -(p.pressureThreshold as number)) {
                return createSellSignal(cleanData, i, `Volatility Normalized Pressure Bearish (normPressure=${normalizedPressure.toFixed(2)}, stddev=${currentStd.toFixed(5)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureThreshold"],
    },
};
