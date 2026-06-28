import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeCompressionDirectionalBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        volPercentileMax: Math.max(0, Math.min(1, Number(params.volPercentileMax ?? 0.30))),
    };
}

export const compression_directional_breakout: Strategy = {
    name: "Compression Directional Breakout",
    description: "Compression breakout with directional close acceptance.",
    defaultParams: {
        lookback: 25,
        volPercentileMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Vol Percentile Max",
    },
    normalizeParams: normalizeCompressionDirectionalBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCompressionDirectionalBreakoutParams(params);
        const lookback = p.lookback as number;
        const volPercentileMax = p.volPercentileMax as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volatility = buildRollingStdDev(cleanReturns, lookback);
        const cleanVolatility = volatility.map(v => v ?? 0);
        const volPercentile = buildPercentileRank(cleanVolatility, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPercentile], (i) => {
            if (i < 3) return null;

            // Check if prior volatility percentile was below volPercentileMax in the last 3 bars: i-3, i-2, i-1
            let priorCompressed = false;
            for (let k = i - 3; k < i; k++) {
                if (volPercentile[k] !== null && volPercentile[k]! < volPercentileMax) {
                    priorCompressed = true;
                    break;
                }
            }

            const acc = closeAcceptance[i];
            if (priorCompressed) {
                if (acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Compression breakout buy with close acceptance ${acc.toFixed(2)}`
                    );
                }
                if (acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Compression breakout sell with close acceptance ${acc.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax"],
    },
};
