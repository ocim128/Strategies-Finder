import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

const DISPLACEMENT_GAP_ZONE_RANGE_LOOKBACK = 20;

function normalizeDisplacementGapZoneAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_size_pct: Math.max(0.0001, Math.abs(Number(params.gap_size_pct ?? 0.01))),
        hold_lookback: Math.max(1, Math.round(Number(params.hold_lookback ?? 5))),
    };
}

export const displacement_gap_zone_alignment: Strategy = {
    name: "Displacement Gap Zone Alignment",
    description:
        "Tracks significant runaway gaps at fresh 20-day extremes and only confirms them once price has defended the gap zone for several sessions.",
    defaultParams: {
        gap_size_pct: 0.01,
        hold_lookback: 5,
    },
    paramLabels: {
        gap_size_pct: "Gap Size %",
        hold_lookback: "Hold Lookback",
    },
    normalizeParams: normalizeDisplacementGapZoneAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDisplacementGapZoneAlignmentParams(params);
        const gapSize = p.gap_size_pct as number;
        const holdLookback = p.hold_lookback as number;
        if (cleanData.length < DISPLACEMENT_GAP_ZONE_RANGE_LOOKBACK + holdLookback + 1) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const { highest, lowest } = buildTrailingHighLow(cleanData, DISPLACEMENT_GAP_ZONE_RANGE_LOOKBACK);
        const signals: ReturnType<typeof createBuySignal>[] = [];

        let bullishGapIndex: number | null = null;
        let bullishGapOpen = 0;
        let bearishGapIndex: number | null = null;
        let bearishGapOpen = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const priorHigh = highest[i];
            const priorLow = lowest[i];

            if (priorHigh !== null && gaps[i] > gapSize && cleanData[i].high > priorHigh) {
                bullishGapIndex = i;
                bullishGapOpen = cleanData[i].open;
            }
            if (priorLow !== null && gaps[i] < -gapSize && cleanData[i].low < priorLow) {
                bearishGapIndex = i;
                bearishGapOpen = cleanData[i].open;
            }

            if (bullishGapIndex !== null) {
                if (cleanData[i].low <= bullishGapOpen) {
                    bullishGapIndex = null;
                } else if (i - bullishGapIndex + 1 >= holdLookback) {
                    signals.push(createBuySignal(cleanData, i, "Runaway bullish gap held above its open"));
                    bullishGapIndex = null;
                }
            }

            if (bearishGapIndex !== null) {
                if (cleanData[i].high >= bearishGapOpen) {
                    bearishGapIndex = null;
                } else if (i - bearishGapIndex + 1 >= holdLookback) {
                    signals.push(createSellSignal(cleanData, i, "Runaway bearish gap held below its open"));
                    bearishGapIndex = null;
                }
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gap_size_pct", "hold_lookback"],
    },
};
