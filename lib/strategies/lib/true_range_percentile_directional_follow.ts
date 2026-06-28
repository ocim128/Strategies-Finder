import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangePercentileDirectionalFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        rangePercentileMin: Math.max(0, Math.min(1, Number(params.rangePercentileMin ?? 0.70))),
    };
}

export const true_range_percentile_directional_follow: Strategy = {
    name: "True Range Percentile Directional Follow",
    description: "True-range percentile with directional close acceptance.",
    defaultParams: {
        lookback: 25,
        rangePercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Range Percentile Min",
    },
    normalizeParams: normalizeTrueRangePercentileDirectionalFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangePercentileDirectionalFollowParams(params);
        const lookback = p.lookback as number;
        const rangePercentileMin = p.rangePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const rangePercentile = buildPercentileRank(trueRange, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [rangePercentile], (i) => {
            const rngPct = rangePercentile[i];
            if (rngPct === null) return null;

            const acc = closeAcceptance[i];
            if (rngPct > rangePercentileMin) {
                if (acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish range expansion: true range percentile ${rngPct.toFixed(2)}, close acceptance ${acc.toFixed(2)}`
                    );
                }
                if (acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish range expansion: true range percentile ${rngPct.toFixed(2)}, close acceptance ${acc.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin"],
    },
};
