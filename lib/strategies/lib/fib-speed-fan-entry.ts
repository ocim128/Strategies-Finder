import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator, EntryStats, StrategyEvaluation, EntryLevelStat, EntryPreview } from '../../types/strategies';
import { createBuySignal, createSellSignal, detectPivots as detectSharedPivots, ensureCleanData } from '../strategy-helpers';
import { calculateATR } from '../indicators';
import { COLORS } from '../constants';

// ============================================================================
// Fibonacci Speed Fan Entry Scanner (Non-Repainting)
// ============================================================================

interface Pivot {
    index: number;
    price: number;
    isHigh: boolean;
    confirmationIndex: number;
}

interface FanSeries {
    levels: (number | null)[];
    base: (number | null)[];
    slope: (number | null)[];
    endIndex: (number | null)[];
    pivotIsHigh: (boolean | null)[];
}

const FIB_LEVELS = [0.25, 0.382, 0.5, 0.618, 0.75];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function calculateDeviationThreshold(atr: (number | null)[], close: number[], multiplier: number): number[] {
    const threshold: number[] = [];
    for (let i = 0; i < close.length; i++) {
        const atrValue = atr[i];
        if (atrValue === null || close[i] === 0) {
            threshold.push(0);
        } else {
            threshold.push((atrValue / close[i]) * 100 * multiplier);
        }
    }
    return threshold;
}

function resolveLevelIndex(params: StrategyParams): number {
    const rawIndex = Number.isFinite(params.levelIndex) ? params.levelIndex : 3;
    return clamp(Math.round(rawIndex), 0, FIB_LEVELS.length - 1);
}

function getLevelByIndex(index: number): number {
    return FIB_LEVELS[clamp(index, 0, FIB_LEVELS.length - 1)];
}

function getModeLabel(mode: number): string {
    if (mode === 0) return 'cross';
    if (mode === 1) return 'close';
    return 'touch';
}

function isCross(prevClose: number, close: number, prevLine: number, line: number): boolean {
    const prevDiff = prevClose - prevLine;
    const currDiff = close - line;
    return (prevDiff <= 0 && currDiff > 0) || (prevDiff >= 0 && currDiff < 0);
}

function isCrossUp(prevClose: number, close: number, prevLine: number, line: number): boolean {
    return prevClose <= prevLine && close > line;
}

function isCrossDown(prevClose: number, close: number, prevLine: number, line: number): boolean {
    return prevClose >= prevLine && close < line;
}

function isTouch(
    high: number,
    low: number,
    close: number,
    line: number,
    useWick: boolean,
    tolerancePct: number
): boolean {
    if (useWick) {
        return low <= line && high >= line;
    }
    const tolerance = Math.abs(line) * (tolerancePct / 100);
    return Math.abs(close - line) <= tolerance;
}

function timeKey(time: OHLCVData['time']): string {
    if (typeof time === 'number') return time.toString();
    if (typeof time === 'string') return time;
    return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function buildTimeIndex(data: OHLCVData[]): Map<string, number> {
    const index = new Map<string, number>();
    data.forEach((bar, i) => {
        index.set(timeKey(bar.time), i);
    });
    return index;
}

function buildFanSeries(
    data: OHLCVData[],
    pivots: Pivot[],
    level: number
): FanSeries {
    const len = data.length;
    const levels: (number | null)[] = new Array(len).fill(null);
    const base: (number | null)[] = new Array(len).fill(null);
    const slope: (number | null)[] = new Array(len).fill(null);
    const endIndex: (number | null)[] = new Array(len).fill(null);
    const pivotIsHigh: (boolean | null)[] = new Array(len).fill(null);

    if (pivots.length < 2) {
        return { levels, base, slope, endIndex, pivotIsHigh };
    }

    for (let p = 0; p < pivots.length - 1; p++) {
        const startPivot = pivots[p];
        const endPivot = pivots[p + 1];

        const priceRange = endPivot.price - startPivot.price;
        const barRange = endPivot.index - startPivot.index;
        if (barRange <= 0) continue;

        const slopeBase = priceRange / barRange;
        const fibPrice = startPivot.price + priceRange * level;
        const adjustedSlope = slopeBase * (1 - level);

        const startIndex = endPivot.confirmationIndex;
        const extensionEnd = p + 2 < pivots.length
            ? Math.min(len - 1, pivots[p + 2].confirmationIndex - 1)
            : len - 1;

        if (startIndex > extensionEnd) continue;

        for (let i = startIndex; i <= extensionEnd; i++) {
            const barsFromEnd = i - endPivot.index;
            const fanPrice = fibPrice + adjustedSlope * barsFromEnd;

            levels[i] = fanPrice;
            base[i] = fibPrice;
            slope[i] = adjustedSlope;
            endIndex[i] = endPivot.index;
            pivotIsHigh[i] = endPivot.isHigh;
        }
    }

    return { levels, base, slope, endIndex, pivotIsHigh };
}

function generateSignalsForLevel(
    data: OHLCVData[],
    params: StrategyParams,
    level: number,
    series: FanSeries
): Signal[] {
    if (data.length === 0) return [];

    const entryMode = Number.isFinite(params.entryMode) ? Math.round(params.entryMode) : 0;
    const useWick = params.touchUsesWick === undefined ? true : params.touchUsesWick !== 0;
    const tolerancePct = Math.max(0, Number.isFinite(params.touchTolerancePct) ? params.touchTolerancePct : 0.05);
    const useLong = params.useLong === undefined ? true : params.useLong !== 0;
    const useShort = params.useShort === undefined ? true : params.useShort !== 0;
    const usePivotContext = params.usePivotContext === undefined ? true : params.usePivotContext !== 0;
    const minSignalGap = Math.max(0, Math.round(params.signalCooldownBars ?? 5));

    const signals: Signal[] = [];
    let lastBuyIndex = -Infinity;
    let lastSellIndex = -Infinity;

    for (let i = 1; i < data.length; i++) {
        const line = series.levels[i];
        const prevLine = series.levels[i - 1];
        if (line == null || prevLine == null) continue;

        const pivotHigh = series.pivotIsHigh[i];
        if (usePivotContext && pivotHigh === null) continue;

        const prevClose = data[i - 1].close;
        const currClose = data[i].close;
        const highVal = data[i].high;
        const lowVal = data[i].low;

        let wantBuy = false;
        let wantSell = false;

        if (entryMode === 0) {
            wantBuy = isCrossUp(prevClose, currClose, prevLine, line);
            wantSell = isCrossDown(prevClose, currClose, prevLine, line);
        } else if (entryMode === 1) {
            wantBuy = currClose > line;
            wantSell = currClose < line;
        } else {
            const touched = isTouch(highVal, lowVal, currClose, line, useWick, tolerancePct);
            if (touched) {
                if (currClose > line) {
                    wantBuy = true;
                } else if (currClose < line) {
                    wantSell = true;
                }
            }
        }

        if (usePivotContext) {
            if (pivotHigh) {
                wantSell = false;
            } else {
                wantBuy = false;
            }
        }

        if (!useLong) wantBuy = false;
        if (!useShort) wantSell = false;

        if (wantBuy && i - lastBuyIndex < minSignalGap) {
            wantBuy = false;
        }
        if (wantSell && i - lastSellIndex < minSignalGap) {
            wantSell = false;
        }

        if (wantBuy && wantSell) continue;

        if (wantBuy) {
            signals.push(createBuySignal(data, i, `Fan ${level} ${getModeLabel(entryMode)}`));
            lastBuyIndex = i;
        } else if (wantSell) {
            signals.push(createSellSignal(data, i, `Fan ${level} ${getModeLabel(entryMode)}`));
            lastSellIndex = i;
        }
    }

    return signals;
}

function buildSignalsAndContext(
    data: OHLCVData[],
    params: StrategyParams
): {
    cleanData: OHLCVData[];
    signals: Signal[];
    pivots: Pivot[];
    fanSeriesByLevel: FanSeries[];
    selectedLevelIndex: number;
    selectedLevel: number;
    selectedSeries: FanSeries;
} {
    const cleanData = ensureCleanData(data);
    if (cleanData.length === 0) {
        return {
            cleanData,
            signals: [],
            pivots: [],
            fanSeriesByLevel: [],
            selectedLevelIndex: 0,
            selectedLevel: getLevelByIndex(0),
            selectedSeries: { levels: [], base: [], slope: [], endIndex: [], pivotIsHigh: [] }
        };
    }

    const depth = Math.max(2, Math.round(params.depth ?? 11));
    const atrPeriod = Math.max(1, Math.round(params.atrPeriod ?? 10));
    const deviation = Number.isFinite(params.deviationMult) ? params.deviationMult : 3;
    const selectedLevelIndex = resolveLevelIndex(params);
    const selectedLevel = getLevelByIndex(selectedLevelIndex);

    const high = cleanData.map(d => d.high);
    const low = cleanData.map(d => d.low);
    const close = cleanData.map(d => d.close);

    const atr = calculateATR(high, low, close, atrPeriod);
    const devThreshold = calculateDeviationThreshold(atr, close, deviation);
    const pivots = detectSharedPivots(cleanData, {
        depth,
        deviationThreshold: devThreshold,
        extremaMode: 'strict',
        includeConfirmationIndex: true,
        deviationInclusive: false
    }).map((pivot): Pivot => ({
        index: pivot.index,
        price: pivot.price,
        isHigh: pivot.isHigh,
        confirmationIndex: pivot.confirmationIndex ?? pivot.index
    }));

    const fanSeriesByLevel = FIB_LEVELS.map(level => buildFanSeries(cleanData, pivots, level));
    const selectedSeries = fanSeriesByLevel[selectedLevelIndex] ?? { levels: [], base: [], slope: [], endIndex: [], pivotIsHigh: [] };
    const signals = generateSignalsForLevel(cleanData, params, selectedLevel, selectedSeries);

    return { cleanData, signals, pivots, fanSeriesByLevel, selectedLevelIndex, selectedLevel, selectedSeries };
}

function buildEntryPreview(data: OHLCVData[], params: StrategyParams): EntryPreview | null {
    const context = buildSignalsAndContext(data, params);
    const cleanData = context.cleanData;

    if (cleanData.length < 2) {
        return {
            mode: Number.isFinite(params.entryMode) ? Math.round(params.entryMode) : 0,
            direction: 'none',
            level: context.selectedLevel,
            fanPrice: null,
            lastClose: null,
            distance: null,
            distancePct: null,
            status: 'unavailable',
            note: 'Not enough data'
        };
    }

    const lastIndex = cleanData.length - 1;
    const line = context.selectedSeries.levels[lastIndex];
    const prevLine = context.selectedSeries.levels[lastIndex - 1];
    const pivotHigh = context.selectedSeries.pivotIsHigh[lastIndex];

    const entryMode = Number.isFinite(params.entryMode) ? Math.round(params.entryMode) : 0;
    const useWick = params.touchUsesWick === undefined ? true : params.touchUsesWick !== 0;
    const tolerancePct = Math.max(0, Number.isFinite(params.touchTolerancePct) ? params.touchTolerancePct : 0.05);
    const usePivotContext = params.usePivotContext === undefined ? true : params.usePivotContext !== 0;
    const useLong = params.useLong === undefined ? true : params.useLong !== 0;
    const useShort = params.useShort === undefined ? true : params.useShort !== 0;

    let allowLong = useLong;
    let allowShort = useShort;
    if (usePivotContext) {
        if (pivotHigh === true) {
            allowLong = false;
        } else if (pivotHigh === false) {
            allowShort = false;
        } else {
            allowLong = false;
            allowShort = false;
        }
    }

    const direction: EntryPreview['direction'] = allowLong && allowShort
        ? 'both'
        : allowLong
            ? 'long'
            : allowShort
                ? 'short'
                : 'none';

    if (line == null || prevLine == null) {
        const note = pivotHigh == null && usePivotContext
            ? 'Waiting for pivot confirmation'
            : 'Fan line not available yet';
        return {
            mode: entryMode,
            direction,
            level: context.selectedLevel,
            fanPrice: null,
            lastClose: cleanData[lastIndex].close,
            distance: null,
            distancePct: null,
            status: 'unavailable',
            note
        };
    }

    const prevClose = cleanData[lastIndex - 1].close;
    const currClose = cleanData[lastIndex].close;
    const high = cleanData[lastIndex].high;
    const low = cleanData[lastIndex].low;

    let wantBuy = false;
    let wantSell = false;

    if (entryMode === 0) {
        wantBuy = isCrossUp(prevClose, currClose, prevLine, line);
        wantSell = isCrossDown(prevClose, currClose, prevLine, line);
    } else if (entryMode === 1) {
        wantBuy = currClose > line;
        wantSell = currClose < line;
    } else {
        const touched = isTouch(high, low, currClose, line, useWick, tolerancePct);
        if (touched) {
            if (currClose > line) {
                wantBuy = true;
            } else if (currClose < line) {
                wantSell = true;
            }
        }
    }

    if (!allowLong) wantBuy = false;
    if (!allowShort) wantSell = false;

    const triggered = (wantBuy || wantSell);
    const status: EntryPreview['status'] = direction === 'none'
        ? 'unavailable'
        : triggered
            ? 'triggered'
            : 'waiting';

    const distance = line - currClose;
    const distancePct = currClose !== 0 ? (distance / currClose) * 100 : null;
    const modeLabel = getModeLabel(entryMode);
    const note = status === 'triggered'
        ? `Triggered (${modeLabel}) on latest bar`
        : status === 'waiting'
            ? `Waiting for ${modeLabel} at fan`
            : 'No direction available';

    return {
        mode: entryMode,
        direction,
        level: context.selectedLevel,
        fanPrice: line,
        lastClose: currClose,
        distance,
        distancePct,
        status,
        note
    };
}

function evaluateEntryLevelStats(
    data: OHLCVData[],
    params: StrategyParams,
    signals: Signal[],
    level: number,
    series: FanSeries
): EntryLevelStat {
    const cleanData = ensureCleanData(data);
    const maxBars = Math.max(1, Math.round(params.maxBars ?? 50));
    const maxRetests = Math.max(1, Math.round(params.maxRetests ?? 3));
    const minRetestsForWin = Math.max(1, Math.round(params.minRetestsForWin ?? 1));
    const retestMode = Number.isFinite(params.retestMode) ? Math.round(params.retestMode) : 2;
    const useWick = params.touchUsesWick === undefined ? true : params.touchUsesWick !== 0;
    const tolerancePct = Math.max(0, Number.isFinite(params.touchTolerancePct) ? params.touchTolerancePct : 0.05);

    if (cleanData.length === 0 || signals.length === 0) {
        return {
            level,
            totalEntries: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            avgRetestBars: 0,
            avgRetests: 0,
        };
    }

    const timeIndex = buildTimeIndex(cleanData);
    let totalEntries = 0;
    let wins = 0;
    let totalRetests = 0;
    let totalRetestBars = 0;

    for (const signal of signals) {
        let entryIndex = Number.isFinite(signal.barIndex)
            ? Math.trunc(signal.barIndex as number)
            : timeIndex.get(timeKey(signal.time));

        if (entryIndex === undefined || entryIndex < 0 || entryIndex >= cleanData.length - 1) {
            continue;
        }

        const base = series.base[entryIndex];
        const slope = series.slope[entryIndex];
        const endIdx = series.endIndex[entryIndex];
        if (base == null || slope == null || endIdx == null) {
            continue;
        }

        const end = Math.min(cleanData.length - 1, entryIndex + maxBars);
        if (end <= entryIndex) continue;

        totalEntries += 1;
        let retestCount = 0;
        let firstRetestBars = maxBars;

        for (let i = entryIndex + 1; i <= end; i++) {
            const line = base + slope * (i - endIdx);
            const prevLine = base + slope * (i - 1 - endIdx);
            const close = cleanData[i].close;
            const prevClose = cleanData[i - 1].close;
            const high = cleanData[i].high;
            const low = cleanData[i].low;

            let hit = false;
            if (retestMode === 0) {
                hit = isCross(prevClose, close, prevLine, line);
            } else if (retestMode === 1) {
                hit = isTouch(high, low, close, line, false, tolerancePct);
            } else {
                hit = isTouch(high, low, close, line, useWick, tolerancePct);
            }

            if (hit) {
                retestCount += 1;
                if (firstRetestBars === maxBars) {
                    firstRetestBars = i - entryIndex;
                }
                if (retestCount >= maxRetests) {
                    break;
                }
            }
        }

        const cappedRetests = Math.min(retestCount, maxRetests);
        totalRetests += cappedRetests;
        totalRetestBars += Math.min(firstRetestBars, maxBars);

        if (cappedRetests >= minRetestsForWin) {
            wins += 1;
        }
    }

    const losses = Math.max(0, totalEntries - wins);
    const winRate = totalEntries > 0 ? (wins / totalEntries) * 100 : 0;
    const avgRetests = totalEntries > 0 ? totalRetests / totalEntries : 0;
    const avgRetestBars = totalEntries > 0 ? totalRetestBars / totalEntries : 0;

    return {
        level,
        totalEntries,
        wins,
        losses,
        winRate,
        avgRetestBars,
        avgRetests
    };
}

function evaluateEntryTargetStats(
    data: OHLCVData[],
    params: StrategyParams,
    signals: Signal[],
    level: number
): EntryLevelStat {
    const cleanData = ensureCleanData(data);
    const maxBars = Math.max(1, Math.round(params.maxBars ?? 50));
    const targetPctRaw = Number.isFinite(params.targetPct) ? params.targetPct : 0;
    const targetPct = Math.min(2, Math.max(0, targetPctRaw));

    if (cleanData.length === 0 || signals.length === 0 || targetPct <= 0) {
        return {
            level,
            totalEntries: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            avgRetestBars: 0,
            avgRetests: 0,
            avgTargetBars: 0
        };
    }

    const timeIndex = buildTimeIndex(cleanData);
    let totalEntries = 0;
    let wins = 0;
    let totalTargetBars = 0;

    for (const signal of signals) {
        let entryIndex = Number.isFinite(signal.barIndex)
            ? Math.trunc(signal.barIndex as number)
            : timeIndex.get(timeKey(signal.time));

        if (entryIndex === undefined || entryIndex < 0 || entryIndex >= cleanData.length - 1) {
            continue;
        }

        const entryPrice = cleanData[entryIndex].close;
        if (entryPrice <= 0) {
            continue;
        }

        const isLong = signal.type === 'buy';
        const target = isLong
            ? entryPrice * (1 + targetPct / 100)
            : entryPrice * (1 - targetPct / 100);

        const end = Math.min(cleanData.length - 1, entryIndex + maxBars);
        if (end <= entryIndex) continue;

        totalEntries += 1;
        let hit = false;
        let hitBars = maxBars;

        for (let i = entryIndex + 1; i <= end; i++) {
            const bar = cleanData[i];
            if (isLong) {
                if (bar.high >= target) {
                    hit = true;
                    hitBars = i - entryIndex;
                    break;
                }
            } else {
                if (bar.low <= target) {
                    hit = true;
                    hitBars = i - entryIndex;
                    break;
                }
            }
        }

        if (hit) {
            wins += 1;
        }

        totalTargetBars += Math.min(hitBars, maxBars);
    }

    const losses = Math.max(0, totalEntries - wins);
    const winRate = totalEntries > 0 ? (wins / totalEntries) * 100 : 0;
    const avgTargetBars = totalEntries > 0 ? totalTargetBars / totalEntries : 0;

    return {
        level,
        totalEntries,
        wins,
        losses,
        winRate,
        avgRetestBars: avgTargetBars,
        avgRetests: 0,
        avgTargetBars
    };
}

function buildZigZagLine(data: OHLCVData[], pivots: Pivot[]): (number | null)[] {
    const zigzag: (number | null)[] = new Array(data.length).fill(null);
    if (pivots.length < 1) return zigzag;

    for (let p = 0; p < pivots.length; p++) {
        zigzag[pivots[p].index] = pivots[p].price;
    }

    for (let p = 0; p < pivots.length - 1; p++) {
        const start = pivots[p];
        const end = pivots[p + 1];
        const steps = end.index - start.index;
        if (steps <= 0) continue;
        const priceStep = (end.price - start.price) / steps;
        for (let i = start.index; i <= end.index; i++) {
            zigzag[i] = start.price + priceStep * (i - start.index);
        }
    }

    return zigzag;
}

// ============================================================================
// Strategy
// ============================================================================

export const fib_speed_fan_entry: Strategy = {
    name: 'Fib Speed Fan Entry Scanner',
    description: 'Non-repainting entry scanner using confirmed Fibonacci Speed Fan levels. Includes entry-only winrate based on fan retests (no exits needed).',
    defaultParams: {
        depth: 11,
        atrPeriod: 10,
        deviationMult: 3,
        levelIndex: 3,
        entryMode: 0,
        retestMode: 2,
        targetPct: 0,
        touchUsesWick: 1,
        touchTolerancePct: 0.05,
        usePivotContext: 1,
        useLong: 1,
        useShort: 1,
        signalCooldownBars: 5,
        maxBars: 50,
        maxRetests: 3,
        minRetestsForWin: 1
    },
    paramLabels: {
        depth: 'Pivot Depth',
        atrPeriod: 'ATR Period',
        deviationMult: 'Deviation Multiplier',
        levelIndex: 'Level Index (0-4: 0.25/0.382/0.5/0.618/0.75)',
        entryMode: 'Entry Mode',
        retestMode: 'Retest Mode',
        targetPct: 'Target % (0-2, 0=off)',
        touchUsesWick: 'Touch Uses Wick (0/1)',
        touchTolerancePct: 'Touch Tolerance % (close-only)',
        usePivotContext: 'Use Pivot Context (0/1)',
        useLong: 'Enable Long (0/1)',
        useShort: 'Enable Short (0/1)',
        signalCooldownBars: 'Min Bars Between Signals',
        maxBars: 'Retest Horizon (bars)',
        maxRetests: 'Retest Count Cap',
        minRetestsForWin: 'Min Retests for Win'
    },
    metadata: {
        role: 'entry',
        direction: 'both'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const context = buildSignalsAndContext(data, params);
        return context.signals;
    },
    evaluate: (data: OHLCVData[], params: StrategyParams, signals?: Signal[]): StrategyEvaluation => {
        const context = buildSignalsAndContext(data, params);
        const usedSignals = signals ?? context.signals;
        const cleanData = context.cleanData;
        const targetPctRaw = Number.isFinite(params.targetPct) ? params.targetPct : 0;
        const targetPct = Math.min(2, Math.max(0, targetPctRaw));
        const useTarget = targetPct > 0;

        const levelStats: EntryLevelStat[] = [];
        for (let i = 0; i < FIB_LEVELS.length; i++) {
            const level = FIB_LEVELS[i];
            const series = context.fanSeriesByLevel[i];
            if (!series) {
                levelStats.push({
                    level,
                    totalEntries: 0,
                    wins: 0,
                    losses: 0,
                    winRate: 0,
                    avgRetestBars: 0,
                    avgRetests: 0
                });
                continue;
            }
            const levelSignals = generateSignalsForLevel(cleanData, params, level, series);
            levelStats.push(useTarget
                ? evaluateEntryTargetStats(cleanData, params, levelSignals, level)
                : evaluateEntryLevelStats(cleanData, params, levelSignals, level, series));
        }

        const selectedStats = useTarget
            ? evaluateEntryTargetStats(cleanData, params, usedSignals, context.selectedLevel)
            : evaluateEntryLevelStats(cleanData, params, usedSignals, context.selectedLevel, context.selectedSeries);

        if (context.selectedLevelIndex >= 0 && context.selectedLevelIndex < levelStats.length) {
            levelStats[context.selectedLevelIndex] = selectedStats;
        }

        const maxBars = Math.max(1, Math.round(params.maxBars ?? 50));
        const maxRetests = Math.max(1, Math.round(params.maxRetests ?? 3));
        const minRetestsForWin = Math.max(1, Math.round(params.minRetestsForWin ?? 1));
        const entryMode = Number.isFinite(params.entryMode) ? Math.round(params.entryMode) : 0;
        const retestMode = Number.isFinite(params.retestMode) ? Math.round(params.retestMode) : 2;
        const useWick = params.touchUsesWick === undefined ? true : params.touchUsesWick !== 0;
        const touchTolerancePct = Math.max(0, Number.isFinite(params.touchTolerancePct) ? params.touchTolerancePct : 0.05);

        const entryStats: EntryStats = {
            mode: 'fan_retest',
            winDefinition: useTarget ? 'target' : 'retest',
            targetPct: targetPct,
            avgTargetBars: useTarget ? selectedStats.avgTargetBars ?? selectedStats.avgRetestBars : undefined,
            levels: levelStats,
            selectedLevel: context.selectedLevel,
            selectedLevelIndex: context.selectedLevelIndex,
            totalEntries: selectedStats.totalEntries,
            wins: selectedStats.wins,
            losses: selectedStats.losses,
            winRate: selectedStats.winRate,
            avgRetestBars: selectedStats.avgRetestBars,
            avgRetests: selectedStats.avgRetests,
            maxBars,
            maxRetests,
            minRetestsForWin,
            entryMode,
            retestMode,
            useWick,
            touchTolerancePct
        };

        return { signals: usedSignals, entryStats };
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const context = buildSignalsAndContext(data, params);
        const cleanData = context.cleanData;
        if (cleanData.length === 0) return [];
        const indicators: StrategyIndicator[] = [];

        if (context.pivots.length > 0) {
            const zigzag = buildZigZagLine(cleanData, context.pivots);
            indicators.push({ name: 'ZigZag', type: 'line', values: zigzag, color: COLORS.Trend });
        }

        if (context.selectedSeries.levels.length > 0) {
            indicators.push({
                name: `Fan ${context.selectedLevel}`,
                type: 'line',
                values: context.selectedSeries.levels,
                color: '#FFA726'
            });
        }

        return indicators;
    },
    entryPreview: (data: OHLCVData[], params: StrategyParams): EntryPreview | null => {
        return buildEntryPreview(data, params);
    },
};


