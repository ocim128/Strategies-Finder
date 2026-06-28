import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewVolumeConfirmedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 15))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const true_range_skew_volume_confirmed: Strategy = {
    name: "True Range Skew Volume Confirmed",
    description: "True-range skew acceptance with proxy-volume confirmation.",
    defaultParams: {
        lookback: 15,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeTrueRangeSkewVolumeConfirmedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewVolumeConfirmedParams(params);
        const lookback = p.lookback as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, volumePercentile], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const volPct = volumePercentile[i];
            if (skew === null || median === null || volPct === null || trueRange[i] <= median) return null;

            if (skew > 0 && volPct > volumePercentileMin && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with volume percentile ${volPct.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && volPct > volumePercentileMin && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with volume percentile ${volPct.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volumePercentileMin"],
    },
};
