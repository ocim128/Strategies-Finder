import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank, buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeCompressionEfficiencyBurstParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volPercentileMax: Math.max(0, Math.min(1, Number(params.volPercentileMax ?? 0.25))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.55))),
        compressionBars: Math.max(1, Math.round(Number(params.compressionBars ?? 5))),
    };
}

export const compression_efficiency_burst: Strategy = {
    name: "Compression Efficiency Burst",
    description: "Volatility breakout following extended compression with high efficiency confirmation.",
    defaultParams: {
        lookback: 30,
        volPercentileMax: 0.25,
        efficiencyMin: 0.55,
        compressionBars: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Vol Percentile Max",
        efficiencyMin: "Efficiency Min",
        compressionBars: "Compression Bars",
    },
    normalizeParams: normalizeCompressionEfficiencyBurstParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCompressionEfficiencyBurstParams(params);
        const lookback = p.lookback as number;
        const volPercentileMax = p.volPercentileMax as number;
        const efficiencyMin = p.efficiencyMin as number;
        const compressionBars = p.compressionBars as number;
        if (cleanData.length < lookback + compressionBars + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volatility = buildRollingStdDev(cleanReturns, lookback);
        const cleanVolatility = volatility.map(v => v ?? 0);
        const volPercentile = buildPercentileRank(cleanVolatility, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPercentile, efficiencyRatio], (i) => {
            const volPct = volPercentile[i];
            const eff = efficiencyRatio[i];
            if (volPct === null || eff === null || i < compressionBars) return null;

            // Check if volatility percentile was below volPercentileMax for compressionBars consecutive bars (prior to i, ending at i-1)
            let isCompressed = true;
            for (let k = i - compressionBars; k < i; k++) {
                if (volPercentile[k] === null || volPercentile[k]! >= volPercentileMax) {
                    isCompressed = false;
                    break;
                }
            }

            if (isCompressed && eff > efficiencyMin) {
                if (closeAcceptance[i] > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Compression efficiency burst buy: vol percentile ${volPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
                if (closeAcceptance[i] < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Compression efficiency burst sell: vol percentile ${volPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax", "efficiencyMin", "compressionBars"],
    },
};
