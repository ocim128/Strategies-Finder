import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeVolatilityStructureRegimeTransitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volPercentileLow: Math.max(0, Math.min(1, Number(params.volPercentileLow ?? 0.25))),
        volPercentileHigh: Math.max(0, Math.min(1, Number(params.volPercentileHigh ?? 0.65))),
    };
}

export const volatility_structure_regime_transition: Strategy = {
    name: "Volatility Structure Regime Transition",
    description: "Volatility regime shift from low to high with directional acceptance.",
    defaultParams: {
        lookback: 30,
        volPercentileLow: 0.25,
        volPercentileHigh: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileLow: "Vol Percentile Low",
        volPercentileHigh: "Vol Percentile High",
    },
    normalizeParams: normalizeVolatilityStructureRegimeTransitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityStructureRegimeTransitionParams(params);
        const lookback = p.lookback as number;
        const volPercentileLow = p.volPercentileLow as number;
        const volPercentileHigh = p.volPercentileHigh as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volatility = buildRollingStdDev(cleanReturns, lookback);
        const cleanVolatility = volatility.map(v => v ?? 0);
        const volPercentile = buildPercentileRank(cleanVolatility, lookback);
        const cleanVolPct = volPercentile.map(v => v ?? 0);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPercentile], (i) => {
            const volPct = volPercentile[i];
            if (volPct === null || volPct <= volPercentileHigh) return null;

            // Check if any of bars i-2, i-1, i had volPercentile < volPercentileLow
            const hadLowVol = (cleanVolPct[i] < volPercentileLow) ||
                             (i >= 1 && cleanVolPct[i - 1] < volPercentileLow) ||
                             (i >= 2 && cleanVolPct[i - 2] < volPercentileLow);

            if (hadLowVol) {
                if (closeAcceptance[i] > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Volatility regime transition: vol percentile ${volPct.toFixed(2)} with bullish acceptance`
                    );
                }
                if (closeAcceptance[i] < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Volatility regime transition: vol percentile ${volPct.toFixed(2)} with bearish acceptance`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileLow", "volPercentileHigh"],
    },
};
