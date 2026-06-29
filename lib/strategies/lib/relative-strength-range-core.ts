import type { OHLCVData } from "../../types/strategies";
import { calculateATR, calculateSMA } from "../indicators";
import {
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import {
    buildBodyPctSeries,
    buildCloseAcceptanceSeries,
    buildRangeSeries,
    buildTrailingHighLow,
    extractBarMetricSeries,
} from "./price-action-frequency-core";
import {
    buildEfficiencyRatio,
    buildPercentileRank,
    buildRateOfChange,
    buildRollingZScore,
} from "./price-action-statistics-core";
import {
    normalizeIntegerParam,
    normalizeNumberParam,
} from "./range-conviction-core";

export type NullableSeries = (number | null)[];

export type RelativeStrengthRangePrepared = {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    ranges: number[];
    trueRange: number[];
    closeReturn: number[];
    bodyPct: number[];
    closeAcceptance: number[];
    atrByPeriod: Map<number, NullableSeries>;
    smaByPeriod: Map<number, NullableSeries>;
};

export { normalizeIntegerParam, normalizeNumberParam };

export function hasEnoughBars(data: OHLCVData[], requiredBars: number): boolean {
    return data.length >= Math.max(2, Math.round(requiredBars));
}

export function prepareRelativeStrengthRangeData(data: OHLCVData[]): RelativeStrengthRangePrepared {
    const cleanData = ensureCleanData(data);

    return {
        cleanData,
        highs: getHighs(cleanData),
        lows: getLows(cleanData),
        closes: getCloses(cleanData),
        ranges: buildRangeSeries(cleanData),
        trueRange: extractBarMetricSeries(cleanData, "trueRange"),
        closeReturn: extractBarMetricSeries(cleanData, "closeReturn"),
        bodyPct: buildBodyPctSeries(cleanData),
        closeAcceptance: buildCloseAcceptanceSeries(cleanData),
        atrByPeriod: new Map(),
        smaByPeriod: new Map(),
    };
}

export function getPreparedRelativeStrengthRangeData(
    preparedData: unknown,
    data: OHLCVData[]
): RelativeStrengthRangePrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "trueRange" in preparedData
        && "closeAcceptance" in preparedData
        && "atrByPeriod" in preparedData
    ) {
        return preparedData as RelativeStrengthRangePrepared;
    }
    return prepareRelativeStrengthRangeData(data);
}

export function getAtrSeries(prepared: RelativeStrengthRangePrepared, period: number): NullableSeries {
    let atr = prepared.atrByPeriod.get(period);
    if (!atr) {
        atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, period);
        prepared.atrByPeriod.set(period, atr);
    }
    return atr;
}

export function getSmaSeries(prepared: RelativeStrengthRangePrepared, period: number): NullableSeries {
    let sma = prepared.smaByPeriod.get(period);
    if (!sma) {
        sma = calculateSMA(prepared.closes, period);
        prepared.smaByPeriod.set(period, sma);
    }
    return sma;
}

export function buildMomentum(values: number[], lookback: number): NullableSeries {
    return buildRateOfChange(values, lookback);
}

export function buildRangePercentile(prepared: RelativeStrengthRangePrepared, lookback: number): NullableSeries {
    return buildPercentileRank(prepared.trueRange, lookback);
}

export function buildReturnZScore(prepared: RelativeStrengthRangePrepared, lookback: number): NullableSeries {
    return buildRollingZScore(prepared.closeReturn, lookback, 1e-9);
}

export function buildTrailingRatioHighLow(
    prepared: RelativeStrengthRangePrepared,
    lookback: number
): { highest: NullableSeries; lowest: NullableSeries } {
    return buildTrailingHighLow(prepared.cleanData, lookback, false);
}

export function buildEfficiency(prepared: RelativeStrengthRangePrepared, lookback: number): NullableSeries {
    return buildEfficiencyRatio(prepared.cleanData, lookback);
}

export function isOverextendedMove(
    prepared: RelativeStrengthRangePrepared,
    index: number,
    atr: NullableSeries,
    maxRangeAtr: number,
    maxReturnAbs: number
): boolean {
    const priorAtr = index > 0 ? atr[index - 1] : null;
    if (priorAtr !== null && priorAtr > 0 && prepared.trueRange[index] > maxRangeAtr * priorAtr) {
        return true;
    }
    return Math.abs(prepared.closeReturn[index]) > maxReturnAbs;
}

export function hasDirectionalAcceptance(
    prepared: RelativeStrengthRangePrepared,
    index: number,
    minAcceptance: number,
    direction: 1 | -1
): boolean {
    return direction > 0
        ? prepared.closeAcceptance[index] >= minAcceptance
        : prepared.closeAcceptance[index] <= -minAcceptance;
}
