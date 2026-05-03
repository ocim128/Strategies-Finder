import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeCompressionExpansionRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        compression_lookback: Math.max(5, Math.round(Number(params.compression_lookback ?? 55))),
        expansion_threshold: Math.max(1.01, Number(params.expansion_threshold ?? 1.5)),
    };
}

export const compression_expansion_router: Strategy = {
    name: "Compression Expansion Router",
    description:
        "Routes compressed volatility to boundary fades and expanded volatility to rolling-median breakouts using ATR-normalized context.",
    defaultParams: {
        compression_lookback: 55,
        expansion_threshold: 1.5,
    },
    paramLabels: {
        compression_lookback: "Compression Lookback",
        expansion_threshold: "Expansion Threshold",
    },
    normalizeParams: normalizeCompressionExpansionRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCompressionExpansionRouterParams(params);
        const lookback = p.compression_lookback as number;
        const expansionThreshold = p.expansion_threshold as number;
        if (cleanData.length < lookback * 2 + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const rollingVolatility = buildRollingStdDev(returns, lookback);
        const averageVolatility = buildRollingAverage(rollingVolatility.map((value) => value ?? 0), lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [rollingVolatility, averageVolatility, atr, median], (i) => {
            if (i < lookback * 2) return null;

            const currentVolatility = rollingVolatility[i];
            const baselineVolatility = averageVolatility[i];
            const currentAtr = atr[i];
            const med = median[i];
            if (
                currentVolatility === null ||
                baselineVolatility === null ||
                baselineVolatility <= 0 ||
                currentAtr === null ||
                currentAtr <= 0 ||
                med === null
            ) {
                return null;
            }

            const volatilityRatio = currentVolatility / baselineVolatility;
            if (volatilityRatio >= expansionThreshold) {
                const cross = checkCrossover(closes, median, i);
                if (cross === "bullish") {
                    return createBuySignal(cleanData, i, `Expansion breakout ratio ${volatilityRatio.toFixed(2)}`);
                }
                if (cross === "bearish") {
                    return createSellSignal(cleanData, i, `Expansion breakdown ratio ${volatilityRatio.toFixed(2)}`);
                }
                return null;
            }

            if (volatilityRatio > 1 / expansionThreshold) return null;

            const atrDistance = (closes[i] - med) / currentAtr;
            if (atrDistance <= -1) {
                return createBuySignal(cleanData, i, `Compression lower fade ${atrDistance.toFixed(2)} ATR`);
            }
            if (atrDistance >= 1) {
                return createSellSignal(cleanData, i, `Compression upper fade ${atrDistance.toFixed(2)} ATR`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["compression_lookback", "expansion_threshold"],
    },
};
