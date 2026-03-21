import { OHLCVData, Signal, Strategy, StrategyParams } from '../../types/strategies';
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from '../strategy-helpers';
import { calculateADX } from '../indicators';

type AdxSlopePivotEntryPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    highs: number[];
    lows: number[];
    adxByPeriod: Map<number, (number | null)[]>;
    pivotRangesByBars: Map<number, { recentHighs: number[]; recentLows: number[] }>;
};

function normalizeAdxSlopePivotEntryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        adxPeriod: Math.max(2, Math.round(params.adxPeriod ?? 14)),
        pivotBars: Math.max(2, Math.round(params.pivotBars ?? 5)),
        adxSlopeLen: Math.max(1, Math.round(params.adxSlopeLen ?? 3)),
    };
}

function prepareAdxSlopePivotEntryData(data: OHLCVData[]): AdxSlopePivotEntryPrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        closes: getCloses(cleanData),
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        adxByPeriod: new Map<number, (number | null)[]>(),
        pivotRangesByBars: new Map<number, { recentHighs: number[]; recentLows: number[] }>(),
    };
}

function getPreparedAdxSlopePivotEntryData(
    preparedData: unknown,
    data: OHLCVData[]
): AdxSlopePivotEntryPrepared {
    if (preparedData && typeof preparedData === 'object' && 'adxByPeriod' in preparedData) {
        return preparedData as AdxSlopePivotEntryPrepared;
    }
    return prepareAdxSlopePivotEntryData(data);
}

function buildPivotRanges(
    highs: number[],
    lows: number[],
    pivotBars: number
): { recentHighs: number[]; recentLows: number[] } {
    const recentHighs = new Array<number>(highs.length).fill(Number.NaN);
    const recentLows = new Array<number>(lows.length).fill(Number.NaN);

    for (let i = pivotBars; i < highs.length; i++) {
        let recentHigh = highs[i - 1];
        let recentLow = lows[i - 1];
        for (let j = i - pivotBars; j < i; j++) {
            recentHigh = Math.max(recentHigh, highs[j]);
            recentLow = Math.min(recentLow, lows[j]);
        }
        recentHighs[i] = recentHigh;
        recentLows[i] = recentLow;
    }

    return { recentHighs, recentLows };
}

export const adx_slope_pivot_entry: Strategy = {
    name: 'ADX Slope Pivot Entry',
    description: 'Uses rising ADX slope to gate momentum and trades closes that break recent pivot ranges.',
    defaultParams: {
        adxPeriod: 14,
        pivotBars: 5,
        adxSlopeLen: 3,
    },
    paramLabels: {
        adxPeriod: 'ADX Period',
        pivotBars: 'Pivot Lookback (bars)',
        adxSlopeLen: 'ADX Slope Length',
    },
    normalizeParams: normalizeAdxSlopePivotEntryParams,
    prepareFinderData: (data) => prepareAdxSlopePivotEntryData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]): Signal[] => {
        const prepared = getPreparedAdxSlopePivotEntryData(preparedData, data);
        const { cleanData, closes, highs, lows, adxByPeriod, pivotRangesByBars } = prepared;
        if (cleanData.length < 8) return [];

        const normalizedParams = normalizeAdxSlopePivotEntryParams(params);
        const adxPeriod = normalizedParams.adxPeriod as number;
        const pivotBars = normalizedParams.pivotBars as number;
        const adxSlopeLen = normalizedParams.adxSlopeLen as number;

        let adx = adxByPeriod.get(adxPeriod);
        if (!adx) {
            adx = calculateADX(highs, lows, closes, adxPeriod);
            adxByPeriod.set(adxPeriod, adx);
        }

        let pivotRanges = pivotRangesByBars.get(pivotBars);
        if (!pivotRanges) {
            pivotRanges = buildPivotRanges(highs, lows, pivotBars);
            pivotRangesByBars.set(pivotBars, pivotRanges);
        }

        const signals: Signal[] = [];

        for (let i = Math.max(pivotBars, adxSlopeLen); i < cleanData.length; i++) {
            const adxNow = adx[i];
            const adxPast = adx[i - adxSlopeLen];
            if (adxNow === null || adxPast === null) continue;

            if (adxNow <= adxPast) continue;

            const recentHigh = pivotRanges.recentHighs[i];
            const recentLow = pivotRanges.recentLows[i];
            if (!Number.isFinite(recentHigh) || !Number.isFinite(recentLow)) continue;

            const close = closes[i];
            if (close > recentHigh) {
                signals.push(createBuySignal(cleanData, i, 'ADX rising + pivot high break'));
            } else if (close < recentLow) {
                signals.push(createSellSignal(cleanData, i, 'ADX rising + pivot low break'));
            }
        }

        return signals;
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] =>
        adx_slope_pivot_entry.executePrepared?.(prepareAdxSlopePivotEntryData(data), params, data) ?? [],
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['adxPeriod', 'pivotBars', 'adxSlopeLen'],
    },
};
