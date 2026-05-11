import type { OHLCVData } from "../../types/index";
import type { NormalizedSettings } from "../../types/backtest";
import { directionFactorFor } from "./backtest-utils";

type Direction = "long" | "short";

interface HistoricalLevelZone {
    lower: number;
    upper: number;
    touches: number;
}

interface HistoricalLevelTargets {
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
}

interface HistoricalLevelParams {
    data: OHLCVData[];
    entryBarIndex: number;
    entryPrice: number;
    direction: Direction;
    config: NormalizedSettings;
    atrArray: (number | null)[];
    baseStopLossPrice: number | null;
    baseTakeProfitPrice: number | null;
}

const PIVOT_STRENGTH = 2;
const MIN_ZONE_TOUCHES = 2;
const ZONE_TOLERANCE_ATR = 0.35;
const EXIT_BUFFER_ATR = 0.1;
const MIN_DISTANCE_ATR = 0.25;
const MIN_DISTANCE_PERCENT = 0.001;

function finitePositive(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveReferenceRange(
    data: OHLCVData[],
    startIndex: number,
    endIndex: number,
    atrArray: (number | null)[],
    atrIndex: number,
    entryPrice: number
): number {
    const atrValue = atrArray[atrIndex];
    if (finitePositive(atrValue)) return atrValue;

    let totalRange = 0;
    let count = 0;
    for (let i = startIndex; i <= endIndex; i++) {
        const candle = data[i];
        const range = candle.high - candle.low;
        if (Number.isFinite(range) && range > 0) {
            totalRange += range;
            count++;
        }
    }

    const averageRange = count > 0 ? totalRange / count : 0;
    return averageRange > 0 ? averageRange : Math.max(entryPrice * 0.01, 1e-9);
}

function isPivotHigh(data: OHLCVData[], index: number, strength: number): boolean {
    const value = data[index].high;
    for (let offset = 1; offset <= strength; offset++) {
        if (data[index - offset].high >= value || data[index + offset].high >= value) {
            return false;
        }
    }
    return true;
}

function isPivotLow(data: OHLCVData[], index: number, strength: number): boolean {
    const value = data[index].low;
    for (let offset = 1; offset <= strength; offset++) {
        if (data[index - offset].low <= value || data[index + offset].low <= value) {
            return false;
        }
    }
    return true;
}

function collectPivotPrices(
    data: OHLCVData[],
    startIndex: number,
    endIndex: number,
    kind: "high" | "low"
): number[] {
    const prices: number[] = [];
    const firstPivot = startIndex + PIVOT_STRENGTH;
    const lastPivot = endIndex - PIVOT_STRENGTH;
    if (lastPivot < firstPivot) return prices;

    for (let i = firstPivot; i <= lastPivot; i++) {
        if (kind === "high" ? isPivotHigh(data, i, PIVOT_STRENGTH) : isPivotLow(data, i, PIVOT_STRENGTH)) {
            prices.push(kind === "high" ? data[i].high : data[i].low);
        }
    }
    return prices;
}

function buildZones(prices: number[], tolerance: number): HistoricalLevelZone[] {
    if (prices.length === 0) return [];

    const sorted = prices
        .filter((price) => Number.isFinite(price) && price > 0)
        .sort((a, b) => a - b);
    const zones: HistoricalLevelZone[] = [];

    for (const price of sorted) {
        const last = zones[zones.length - 1];
        if (!last || price - last.upper > tolerance) {
            zones.push({ lower: price, upper: price, touches: 1 });
            continue;
        }
        last.lower = Math.min(last.lower, price);
        last.upper = Math.max(last.upper, price);
        last.touches++;
    }

    return zones.filter((zone) => zone.touches >= MIN_ZONE_TOUCHES);
}

function isCloserTarget(
    candidate: number,
    current: number | null,
    entryPrice: number,
    direction: Direction
): boolean {
    if (current === null || !Number.isFinite(current)) return true;
    return direction === "short"
        ? candidate > current && candidate < entryPrice
        : candidate < current && candidate > entryPrice;
}

function isCloserStop(
    candidate: number,
    current: number | null,
    entryPrice: number,
    direction: Direction
): boolean {
    if (current === null || !Number.isFinite(current)) return true;
    return direction === "short"
        ? candidate < current && candidate > entryPrice
        : candidate > current && candidate < entryPrice;
}

export function resolveHistoricalLevelTargets(params: HistoricalLevelParams): HistoricalLevelTargets {
    const {
        data,
        entryBarIndex,
        entryPrice,
        direction,
        config,
        atrArray,
        baseStopLossPrice,
        baseTakeProfitPrice,
    } = params;

    const useHistoricalTakeProfit = config.historicalLevelTakeProfitEnabled === true;
    const useHistoricalStopLoss = config.historicalLevelStopLossEnabled === true;
    if ((!useHistoricalTakeProfit && !useHistoricalStopLoss) || config.historicalLevelLookbackBars <= 0) {
        return { stopLossPrice: baseStopLossPrice, takeProfitPrice: baseTakeProfitPrice };
    }

    const historyEndIndex = Math.min(entryBarIndex - 1, data.length - 1);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || historyEndIndex < PIVOT_STRENGTH * 2) {
        return { stopLossPrice: baseStopLossPrice, takeProfitPrice: baseTakeProfitPrice };
    }

    const lookback = Math.max(PIVOT_STRENGTH * 2 + 1, Math.round(config.historicalLevelLookbackBars));
    const startIndex = Math.max(0, historyEndIndex - lookback + 1);
    const referenceRange = resolveReferenceRange(data, startIndex, historyEndIndex, atrArray, historyEndIndex, entryPrice);
    const zoneTolerance = Math.max(referenceRange * ZONE_TOLERANCE_ATR, entryPrice * MIN_DISTANCE_PERCENT);
    const buffer = Math.max(referenceRange * EXIT_BUFFER_ATR, entryPrice * MIN_DISTANCE_PERCENT);
    const minDistance = Math.max(referenceRange * MIN_DISTANCE_ATR, entryPrice * MIN_DISTANCE_PERCENT);

    const resistanceZones = buildZones(collectPivotPrices(data, startIndex, historyEndIndex, "high"), zoneTolerance);
    const supportZones = buildZones(collectPivotPrices(data, startIndex, historyEndIndex, "low"), zoneTolerance);

    const directionFactor = directionFactorFor(direction);
    let stopLossPrice = baseStopLossPrice;
    let takeProfitPrice = baseTakeProfitPrice;

    if (directionFactor > 0) {
        if (useHistoricalTakeProfit) {
            const resistance = resistanceZones
                .filter((zone) => zone.lower - buffer > entryPrice + minDistance)
                .sort((a, b) => a.lower - b.lower)[0];
            if (resistance) {
                const candidate = resistance.lower - buffer;
                if (isCloserTarget(candidate, takeProfitPrice, entryPrice, direction)) {
                    takeProfitPrice = candidate;
                }
            }
        }

        if (useHistoricalStopLoss) {
            const support = supportZones
                .filter((zone) => zone.upper < entryPrice - minDistance)
                .sort((a, b) => b.upper - a.upper)[0];
            if (support) {
                const candidate = support.lower - buffer;
                if (candidate < entryPrice && isCloserStop(candidate, stopLossPrice, entryPrice, direction)) {
                    stopLossPrice = candidate;
                }
            }
        }
    } else {
        if (useHistoricalTakeProfit) {
            const support = supportZones
                .filter((zone) => zone.upper + buffer < entryPrice - minDistance)
                .sort((a, b) => b.upper - a.upper)[0];
            if (support) {
                const candidate = support.upper + buffer;
                if (isCloserTarget(candidate, takeProfitPrice, entryPrice, direction)) {
                    takeProfitPrice = candidate;
                }
            }
        }

        if (useHistoricalStopLoss) {
            const resistance = resistanceZones
                .filter((zone) => zone.lower > entryPrice + minDistance)
                .sort((a, b) => a.lower - b.lower)[0];
            if (resistance) {
                const candidate = resistance.upper + buffer;
                if (candidate > entryPrice && isCloserStop(candidate, stopLossPrice, entryPrice, direction)) {
                    stopLossPrice = candidate;
                }
            }
        }
    }

    return { stopLossPrice, takeProfitPrice };
}
