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
import { buildRollingMedian } from "./price-action-statistics-core";

const DIRECTIONAL_INDEX_REGIME_ADX_PERIOD = 14;

function normalizeDirectionalIndexRegimeAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        adx_threshold: Math.max(0, Number(params.adx_threshold ?? 25)),
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 55))),
    };
}

function buildDirectionalIndexSeries(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): { plusDI: (number | null)[]; minusDI: (number | null)[] } {
    const length = closes.length;
    const plusDI: (number | null)[] = new Array(length).fill(null);
    const minusDI: (number | null)[] = new Array(length).fill(null);

    if (length < period + 1) return { plusDI, minusDI };

    const tr: number[] = new Array(length).fill(0);
    const plusDM: number[] = new Array(length).fill(0);
    const minusDM: number[] = new Array(length).fill(0);

    for (let i = 1; i < length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }

    let trSmooth = 0;
    let plusSmooth = 0;
    let minusSmooth = 0;

    for (let i = 1; i <= period; i++) {
        trSmooth += tr[i];
        plusSmooth += plusDM[i];
        minusSmooth += minusDM[i];
    }

    for (let i = period; i < length; i++) {
        if (i > period) {
            trSmooth = trSmooth - trSmooth / period + tr[i];
            plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
            minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
        }

        if (trSmooth <= 0) {
            plusDI[i] = 0;
            minusDI[i] = 0;
            continue;
        }

        plusDI[i] = 100 * (plusSmooth / trSmooth);
        minusDI[i] = 100 * (minusSmooth / trSmooth);
    }

    return { plusDI, minusDI };
}

export const directional_index_regime_alignment: Strategy = {
    name: "Directional Index Regime Alignment",
    description:
        "Uses ADX as a trend-strength gate, DI dominance for direction, and a rolling median for structural price alignment.",
    defaultParams: {
        adx_threshold: 25,
        median_lookback: 55,
    },
    paramLabels: {
        adx_threshold: "ADX Threshold",
        median_lookback: "Median Lookback",
    },
    normalizeParams: normalizeDirectionalIndexRegimeAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDirectionalIndexRegimeAlignmentParams(params);
        const medianLookback = p.median_lookback as number;
        const adxThreshold = p.adx_threshold as number;
        if (cleanData.length < Math.max(medianLookback, DIRECTIONAL_INDEX_REGIME_ADX_PERIOD * 2) + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const median = buildRollingMedian(closes, medianLookback);
        const adx = calculateADX(highs, lows, closes, DIRECTIONAL_INDEX_REGIME_ADX_PERIOD);
        const di = buildDirectionalIndexSeries(highs, lows, closes, DIRECTIONAL_INDEX_REGIME_ADX_PERIOD);

        return createSignalLoop(cleanData, [median, adx, di.plusDI, di.minusDI], (i) => {
            const m = median[i];
            const a = adx[i];
            const plus = di.plusDI[i];
            const minus = di.minusDI[i];
            if (m === null || a === null || plus === null || minus === null || a <= adxThreshold) return null;

            if (plus > minus && closes[i] > m) {
                return createBuySignal(cleanData, i, `ADX ${a.toFixed(1)} strong with +DI above -DI`);
            }
            if (minus > plus && closes[i] < m) {
                return createSellSignal(cleanData, i, `ADX ${a.toFixed(1)} strong with -DI above +DI`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["adx_threshold", "median_lookback"],
    },
};
