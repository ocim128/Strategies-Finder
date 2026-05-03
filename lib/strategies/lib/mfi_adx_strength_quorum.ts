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
import { calculateADX, calculateMFI } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

function buildDirectionalIndexFlags(highs: number[], lows: number[], closes: number[], period: number): number[] {
    const flags: number[] = new Array(closes.length).fill(0);
    const tr: number[] = new Array(closes.length).fill(0);
    const plusDM: number[] = new Array(closes.length).fill(0);
    const minusDM: number[] = new Array(closes.length).fill(0);

    for (let i = 1; i < closes.length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }

    let trSmooth = 0;
    let plusSmooth = 0;
    let minusSmooth = 0;
    for (let i = 1; i <= period && i < closes.length; i++) {
        trSmooth += tr[i];
        plusSmooth += plusDM[i];
        minusSmooth += minusDM[i];
    }

    for (let i = period; i < closes.length; i++) {
        if (i > period) {
            trSmooth = trSmooth - trSmooth / period + tr[i];
            plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
            minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
        }

        if (trSmooth <= 0) continue;
        const plusDI = 100 * (plusSmooth / trSmooth);
        const minusDI = 100 * (minusSmooth / trSmooth);
        if (plusDI > minusDI) {
            flags[i] = 1;
        } else if (minusDI > plusDI) {
            flags[i] = -1;
        }
    }

    return flags;
}

function normalizeMfiAdxStrengthQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 14))),
        adx_min: Math.max(0, Number(params.adx_min ?? 25)),
    };
}

export const mfi_adx_strength_quorum: Strategy = {
    name: "MFI-ADX Strength Quorum",
    description:
        "Requires MFI momentum and ADX/DI trend intensity to agree relative to a rolling median.",
    defaultParams: {
        lookback: 14,
        adx_min: 25,
    },
    paramLabels: {
        lookback: "Lookback",
        adx_min: "ADX Minimum",
    },
    normalizeParams: normalizeMfiAdxStrengthQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMfiAdxStrengthQuorumParams(params);
        const lookback = p.lookback as number;
        const adxMin = p.adx_min as number;
        if (cleanData.length < lookback * 2 + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const mfi = calculateMFI(highs, lows, closes, volumes, lookback);
        const adx = calculateADX(highs, lows, closes, lookback);
        const median = buildRollingMedian(closes, lookback);
        const diFlags = buildDirectionalIndexFlags(highs, lows, closes, lookback);

        return createSignalLoop(cleanData, [mfi, adx, median], (i) => {
            const moneyFlow = mfi[i];
            const trendStrength = adx[i];
            const med = median[i];
            if (moneyFlow === null || trendStrength === null || med === null || trendStrength <= adxMin) return null;

            if (moneyFlow > 60 && closes[i] > med && diFlags[i] > 0) {
                return createBuySignal(cleanData, i, `MFI/ADX quorum long mfi=${moneyFlow.toFixed(1)} adx=${trendStrength.toFixed(1)}`);
            }
            if (moneyFlow < 40 && closes[i] < med && diFlags[i] < 0) {
                return createSellSignal(cleanData, i, `MFI/ADX quorum short mfi=${moneyFlow.toFixed(1)} adx=${trendStrength.toFixed(1)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "adx_min"],
    },
};
