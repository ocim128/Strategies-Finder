import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeMemeSentimentSpikeFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        skewnessPercentileMin: Math.max(0, Math.min(1, Number(params.skewnessPercentileMin ?? 0.80))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.60))),
    };
}

export const meme_sentiment_spike_follow: Strategy = {
    name: "Meme Sentiment Spike Follow",
    description: "Sentiment-driven return skewness burst with volume percentile rank confirmation.",
    defaultParams: {
        lookback: 25,
        skewnessPercentileMin: 0.80,
        volumePercentileMin: 0.60,
    },
    paramLabels: {
        lookback: "Lookback",
        skewnessPercentileMin: "Skewness Percentile Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeMemeSentimentSpikeFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMemeSentimentSpikeFollowParams(params);
        const lookback = p.lookback as number;
        const skewnessPercentileMin = p.skewnessPercentileMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const skew = buildRollingSkewness(cleanReturns, lookback);
        const cleanSkew = skew.map(s => s ?? 0);
        const skewPercentile = buildPercentileRank(cleanSkew, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [skewPercentile, volumePercentile, returns], (i) => {
            const skewPct = skewPercentile[i];
            const volPct = volumePercentile[i];
            const ret = returns[i];
            if (skewPct === null || volPct === null || ret === null) return null;

            if (volPct > volumePercentileMin) {
                if (skewPct > skewnessPercentileMin && ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Meme sentiment spike buy: skew percentile ${skewPct.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
                if (skewPct < (1 - skewnessPercentileMin) && ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Meme sentiment spike sell: skew percentile ${skewPct.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewnessPercentileMin", "volumePercentileMin"],
    },
};
