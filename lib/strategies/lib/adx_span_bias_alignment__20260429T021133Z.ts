import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateADX } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeAdxSpanBiasAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        adx_period: Math.max(2, Math.round(Number(params.adx_period ?? 21))),
        span_lookback: Math.max(2, Math.round(Number(params.span_lookback ?? 63))),
        adx_floor: Math.max(0, Number(params.adx_floor ?? 20)),
    };
}

export const adx_span_bias_alignment: Strategy = {
    name: "ADX Span Bias Alignment",
    description:
        "Requires a sufficiently strong ADX regime, then uses the midpoint of a trailing high-low span as the structural divider between bullish and bearish daily control.",
    defaultParams: {
        adx_period: 21,
        span_lookback: 63,
        adx_floor: 20,
    },
    paramLabels: {
        adx_period: "ADX Period",
        span_lookback: "Span Lookback",
        adx_floor: "ADX Floor",
    },
    normalizeParams: normalizeAdxSpanBiasAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAdxSpanBiasAlignmentParams(params);
        const adxPeriod = p.adx_period as number;
        const spanLookback = p.span_lookback as number;
        const minLookback = Math.max(spanLookback + 1, adxPeriod * 2);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const adx = calculateADX(highs, lows, closes, adxPeriod);
        const { highest, lowest } = buildTrailingHighLow(cleanData, spanLookback);

        return createSignalLoop(cleanData, [adx, highest, lowest], (i) => {
            if (i < minLookback - 1) return null;

            const adxValue = adx[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (adxValue === null || hi === null || lo === null || adxValue <= (p.adx_floor as number)) return null;

            const midpoint = (hi + lo) / 2;
            if (closes[i] > midpoint) {
                return createBuySignal(cleanData, i, `ADX ${adxValue.toFixed(2)} with close above span midpoint`);
            }
            if (closes[i] < midpoint) {
                return createSellSignal(cleanData, i, `ADX ${adxValue.toFixed(2)} with close below span midpoint`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adx_period", "span_lookback", "adx_floor"],
    },
};
