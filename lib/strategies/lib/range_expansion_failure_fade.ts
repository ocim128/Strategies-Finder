import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeRangeExpansionFailureFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        rangePercentileMin: Math.max(0, Math.min(1, Number(params.rangePercentileMin ?? 0.70))),
        wickImbalanceMin: Math.max(0, Math.min(1, Number(params.wickImbalanceMin ?? 0.25))),
    };
}

export const range_expansion_failure_fade: Strategy = {
    name: "Range Expansion Failure Fade",
    description: "Range expansion failure with wick rejection as mean reversion.",
    defaultParams: {
        lookback: 25,
        rangePercentileMin: 0.70,
        wickImbalanceMin: 0.25,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Range Percentile Min",
        wickImbalanceMin: "Wick Imbalance Min",
    },
    normalizeParams: normalizeRangeExpansionFailureFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRangeExpansionFailureFadeParams(params);
        const lookback = p.lookback as number;
        const rangePercentileMin = p.rangePercentileMin as number;
        const wickImbalanceMin = p.wickImbalanceMin as number;
        if (cleanData.length < lookback + 1) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");

        return createSignalLoop(cleanData, [rangePercentile, wickImbalance], (i) => {
            const rngPct = rangePercentile[i];
            const imb = wickImbalance[i];
            if (rngPct === null || imb === null) return null;

            const acc = closeAcceptance[i];
            if (rngPct > rangePercentileMin) {
                if (imb < -wickImbalanceMin && acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Range expansion failed down: range percentile ${rngPct.toFixed(2)}, wick imbalance ${imb.toFixed(2)}, close acceptance ${acc.toFixed(2)}`
                    );
                }
                if (imb > wickImbalanceMin && acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Range expansion failed up: range percentile ${rngPct.toFixed(2)}, wick imbalance ${imb.toFixed(2)}, close acceptance ${acc.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin", "wickImbalanceMin"],
    },
};
