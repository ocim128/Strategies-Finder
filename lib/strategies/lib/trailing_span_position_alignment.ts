import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeTrailingSpanPositionAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
        upper_pct: Math.min(0.99, Math.max(0.01, Number(params.upper_pct ?? 0.7))),
        lower_pct: Math.min(0.99, Math.max(0.01, Number(params.lower_pct ?? 0.3))),
    };
}

export const trailing_span_position_alignment: Strategy = {
    name: "Trailing Span Position Alignment",
    description: "Where the close sits within its trailing min-to-max span is a normalized boundary position. Close near the trailing high means price is pressing the upper boundary; near the trailing low means pressing the lower boundary.",
    defaultParams: {
        lookback: 20,
        upper_pct: 0.7,
        lower_pct: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        upper_pct: "Upper %",
        lower_pct: "Lower %",
    },
    normalizeParams: normalizeTrailingSpanPositionAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingSpanPositionAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const closes = getCloses(cleanData);
        const minMax = buildRollingMinMax(closes, p.lookback);

        return createSignalLoop(cleanData, [minMax.min, minMax.max], (i) => {
            if (i < p.lookback) return null;
            const low = minMax.min[i];
            const high = minMax.max[i];
            if (low === null || high === null) return null;
            if (high === low) return null;

            const spanPosition = (closes[i] - low) / (high - low);
            if (spanPosition > p.upper_pct) {
                return createBuySignal(cleanData, i, `Span position ${spanPosition.toFixed(3)} above upper threshold`);
            }
            if (spanPosition < p.lower_pct) {
                return createSellSignal(cleanData, i, `Span position ${spanPosition.toFixed(3)} below lower threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "upper_pct", "lower_pct"],
    },
};
