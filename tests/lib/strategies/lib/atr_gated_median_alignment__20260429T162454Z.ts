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
import { calculateATR } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const ATR_GATED_MEDIAN_ALIGNMENT_ATR_PERIOD = 14;

function normalizeAtrGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        atr_threshold: Math.max(0.01, Number(params.atr_threshold ?? 1.0)),
    };
}

export const atr_gated_median_alignment: Strategy = {
    name: "ATR Gated Median Alignment",
    description:
        "Uses a quiet-volatility ATR gate before allowing the close to align with the rolling median, filtering entries to calmer regimes.",
    defaultParams: {
        lookback: 63,
        atr_threshold: 1.0,
    },
    paramLabels: {
        lookback: "Lookback",
        atr_threshold: "ATR Threshold",
    },
    normalizeParams: normalizeAtrGatedMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAtrGatedMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        const threshold = p.atr_threshold as number;
        if (cleanData.length < Math.max(lookback + 1, ATR_GATED_MEDIAN_ALIGNMENT_ATR_PERIOD)) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(highs, lows, closes, ATR_GATED_MEDIAN_ALIGNMENT_ATR_PERIOD);
        const averageAtr = buildRollingAverage(atr.map((value) => value ?? 0), lookback);

        return createSignalLoop(cleanData, [median, atr, averageAtr], (i) => {
            const m = median[i];
            const atrValue = atr[i];
            const avgAtr = averageAtr[i];
            if (m === null || atrValue === null || avgAtr === null || avgAtr <= 0) return null;
            if (atrValue > threshold * avgAtr) return null;

            if (closes[i] > m) {
                return createBuySignal(cleanData, i, `Quiet ATR regime with close above median`);
            }
            if (closes[i] < m) {
                return createSellSignal(cleanData, i, `Quiet ATR regime with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atr_threshold"],
    },
};
