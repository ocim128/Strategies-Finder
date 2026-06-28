import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizePriceVolumeCorrelationManipulationDetectParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        correlationMax: Math.max(-1, Math.min(1, Number(params.correlationMax ?? -0.20))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.55))),
    };
}

export const price_volume_correlation_manipulation_detect: Strategy = {
    name: "Price Volume Correlation Manipulation Detect",
    description: "Price-volume correlation break as manipulation signal.",
    defaultParams: {
        lookback: 25,
        correlationMax: -0.20,
        volumePercentileMin: 0.55,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMax: "Correlation Max",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizePriceVolumeCorrelationManipulationDetectParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeCorrelationManipulationDetectParams(params);
        const lookback = p.lookback as number;
        const correlationMax = p.correlationMax as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

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

            if (corr < correlationMax && volPct > volumePercentileMin) {
                if (ret < 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Manipulation buy: correlation ${corr.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
                if (ret > 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Manipulation sell: correlation ${corr.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMax", "volumePercentileMin"],
    },
};
