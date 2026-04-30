import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian, extractBarMetricSeries } from "./price-action-statistics-core";

const BODY_DISPLACEMENT_MULTIPLIER = 1.5;

function normalizeRelativeBodyDisplacementAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        bodyLookback: Math.max(2, Math.round(params.bodyLookback ?? 20)),
        anchorLookback: Math.max(2, Math.round(params.anchorLookback ?? 63)),
    };
}

export const relative_body_displacement_alignment: Strategy = {
    name: "Relative Body Displacement Alignment",
    description:
        "Requires the candle body to be unusually dominant relative to recent history, then aligns that displacement with a longer-term rolling median trend anchor.",
    defaultParams: {
        bodyLookback: 20,
        anchorLookback: 63,
    },
    paramLabels: {
        bodyLookback: "Body Lookback",
        anchorLookback: "Anchor Lookback",
    },
    normalizeParams: normalizeRelativeBodyDisplacementAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRelativeBodyDisplacementAlignmentParams(params);
        const minLookback = Math.max(p.bodyLookback as number, p.anchorLookback as number);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const averageBodyPct = buildRollingAverage(bodyPct, p.bodyLookback as number);
        const median = buildRollingMedian(closes, p.anchorLookback as number);

        return createSignalLoop(cleanData, [averageBodyPct, median], (i) => {
            if (i < minLookback - 1) return null;

            const avgBody = averageBodyPct[i];
            const med = median[i];
            if (avgBody === null || med === null || avgBody <= 0) return null;
            if (bodyPct[i] < avgBody * BODY_DISPLACEMENT_MULTIPLIER) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, "Large relative body with close above anchor median");
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, "Large relative body with close below anchor median");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bodyLookback", "anchorLookback"],
    },
};
