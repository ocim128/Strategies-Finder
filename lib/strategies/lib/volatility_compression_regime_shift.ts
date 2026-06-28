import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeVolatilityCompressionRegimeShiftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        volPercentileLow: Math.max(0, Math.min(1, Number(params.volPercentileLow ?? 0.25))),
        volPercentileHigh: Math.max(0, Math.min(1, Number(params.volPercentileHigh ?? 0.60))),
    };
}

export const volatility_compression_regime_shift: Strategy = {
    name: "Volatility Compression Regime Shift",
    description: "Volatility regime transition from compression to expansion.",
    defaultParams: {
        lookback: 25,
        volPercentileLow: 0.25,
        volPercentileHigh: 0.60,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileLow: "Vol Percentile Low",
        volPercentileHigh: "Vol Percentile High",
    },
    normalizeParams: normalizeVolatilityCompressionRegimeShiftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityCompressionRegimeShiftParams(params);
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
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPercentile], (i) => {
            const volPct = volPercentile[i];
            if (volPct === null || i < 3) return null;

            // Check if prior volatility percentile was below volPercentileLow in the last 3 bars: i-3, i-2, i-1
            let priorCompressed = false;
            for (let k = i - 3; k < i; k++) {
                if (volPercentile[k] !== null && volPercentile[k]! < volPercentileLow) {
                    priorCompressed = true;
                    break;
                }
            }

            const acc = closeAcceptance[i];
            if (priorCompressed && volPct > volPercentileHigh) {
                if (acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Regime shift: vol pct ${volPct.toFixed(2)} with positive close acceptance ${acc.toFixed(2)}`
                    );
                }
                if (acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Regime shift: vol pct ${volPct.toFixed(2)} with negative close acceptance ${acc.toFixed(2)}`
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
