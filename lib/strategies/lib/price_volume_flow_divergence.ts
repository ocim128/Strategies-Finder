import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizePriceVolumeFlowDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        correlationMax: Math.max(-1, Math.min(1, Number(params.correlationMax ?? -0.20))),
    };
}

export const price_volume_flow_divergence: Strategy = {
    name: "Price Volume Flow Divergence",
    description: "Price-volume divergence as order flow reversal signal.",
    defaultParams: {
        lookback: 25,
        correlationMax: -0.20,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMax: "Correlation Max",
    },
    normalizeParams: normalizePriceVolumeFlowDivergenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeFlowDivergenceParams(params);
        const lookback = p.lookback as number;
        const correlationMax = p.correlationMax as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volumes = getVolumes(cleanData);
        const priceVolumeCorr = buildRollingCorrelation(cleanReturns, volumes, lookback);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [priceVolumeCorr, volumePercentile, returns], (i) => {
            const corr = priceVolumeCorr[i];
            const volPct = volumePercentile[i];
            const ret = returns[i];
            if (corr === null || volPct === null || ret === null) return null;

            if (corr < correlationMax && volPct > 0.50) {
                // volume rising while price falls (expect buy reversion)
                if (ret < 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Divergence buy: correlation ${corr.toFixed(2)}, vol pct ${volPct.toFixed(2)}, ret ${ret.toFixed(4)}`
                    );
                }
                // volume rising while price rises (expect sell reversion)
                if (ret > 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Divergence sell: correlation ${corr.toFixed(2)}, vol pct ${volPct.toFixed(2)}, ret ${ret.toFixed(4)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMax"],
    },
};
