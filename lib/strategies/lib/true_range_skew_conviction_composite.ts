import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewConvictionCompositeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.35))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const true_range_skew_conviction_composite: Strategy = {
    name: "True Range Skew Conviction Composite",
    description: "Multi-metric conviction composite for signal quality.",
    defaultParams: {
        lookback: 20,
        efficiencyMin: 0.35,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeTrueRangeSkewConvictionCompositeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewConvictionCompositeParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, efficiencyRatio, volumePercentile], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const efficiency = efficiencyRatio[i];
            const volPct = volumePercentile[i];
            if (skew === null || median === null || efficiency === null || volPct === null || trueRange[i] <= median) return null;

            if (skew > 0 && efficiency > efficiencyMin && volPct > volumePercentileMin && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with efficiency ${efficiency.toFixed(2)}, volume percentile ${volPct.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && efficiency > efficiencyMin && volPct > volumePercentileMin && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with efficiency ${efficiency.toFixed(2)}, volume percentile ${volPct.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin", "volumePercentileMin"],
    },
};
