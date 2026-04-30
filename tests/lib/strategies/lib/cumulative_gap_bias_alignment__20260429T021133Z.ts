import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCumulativeDecaySum, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeCumulativeGapBiasAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.94))),
    };
}

export const cumulative_gap_bias_alignment: Strategy = {
    name: "Cumulative Gap Bias Alignment",
    description:
        "Tracks a decayed cumulative sum of daily gap percentages so multi-day displacement bias can be traded without collapsing the idea into a simple moving average of gaps.",
    defaultParams: {
        lookback: 63,
        decay: 0.94,
    },
    paramLabels: {
        lookback: "Warmup Lookback",
        decay: "Decay",
    },
    normalizeParams: normalizeCumulativeGapBiasAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeGapBiasAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const decayedGapBias = buildCumulativeDecaySum(gapPct, p.decay as number);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback - 1) return null;

            const gapBias = decayedGapBias[i];
            if (gapBias > 0) {
                return createBuySignal(cleanData, i, `Positive cumulative gap bias ${gapBias.toFixed(4)}`);
            }
            if (gapBias < 0) {
                return createSellSignal(cleanData, i, `Negative cumulative gap bias ${gapBias.toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay"],
    },
};
