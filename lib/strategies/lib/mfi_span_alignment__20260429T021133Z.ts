import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateMFI } from "../indicators";
import { buildTrailingHighLow, clamp } from "./price-action-frequency-core";

function normalizeMfiSpanAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        mfi_period: Math.max(2, Math.round(Number(params.mfi_period ?? 21))),
        span_lookback: Math.max(2, Math.round(Number(params.span_lookback ?? 63))),
        zone_edge: Math.max(0.5, Math.min(0.99, Number(params.zone_edge ?? 0.65))),
    };
}

export const mfi_span_alignment: Strategy = {
    name: "MFI Span Alignment",
    description:
        "Uses Money Flow Index as the participation gate but keeps the structural trigger grounded in whether price is already accepted in the upper or lower zone of a trailing span.",
    defaultParams: {
        mfi_period: 21,
        span_lookback: 63,
        zone_edge: 0.65,
    },
    paramLabels: {
        mfi_period: "MFI Period",
        span_lookback: "Span Lookback",
        zone_edge: "Zone Edge",
    },
    normalizeParams: normalizeMfiSpanAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMfiSpanAlignmentParams(params);
        const mfiPeriod = p.mfi_period as number;
        const spanLookback = p.span_lookback as number;
        const minLookback = Math.max(mfiPeriod, spanLookback + 1);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const mfi = calculateMFI(highs, lows, closes, volumes, mfiPeriod);
        const { highest, lowest } = buildTrailingHighLow(cleanData, spanLookback);

        return createSignalLoop(cleanData, [mfi, highest, lowest], (i) => {
            if (i < minLookback - 1) return null;

            const mfiValue = mfi[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (mfiValue === null || hi === null || lo === null || hi <= lo) return null;

            const position = clamp((closes[i] - lo) / (hi - lo), 0, 1);
            if (mfiValue > 50 && position > (p.zone_edge as number)) {
                return createBuySignal(cleanData, i, `MFI ${mfiValue.toFixed(2)} with upper span acceptance`);
            }
            if (mfiValue < 50 && position < 1 - (p.zone_edge as number)) {
                return createSellSignal(cleanData, i, `MFI ${mfiValue.toFixed(2)} with lower span acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfi_period", "span_lookback", "zone_edge"],
    },
};
