import type { OHLCVData, Signal, StrategyExecutionContext, Time } from "./types/strategies";
import { parseIntervalSeconds } from "./interval-utils";
import { canonicalTimeKey, timeKey } from "./strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

export interface ContiguousTimeSegment {
    data: OHLCVData[];
    offset: number;
}

type SegmentSignalExecutor = (
    data: OHLCVData[],
    context?: StrategyExecutionContext
) => Signal[];

function candleTimeSec(candle: OHLCVData): number | null {
    return parseTimeToUnixSeconds(candle.time);
}

function buildSegmentTimeIndex(data: readonly OHLCVData[]): Map<string, number> {
    const index = new Map<string, number>();
    for (let i = 0; i < data.length; i++) {
        index.set(timeKey(data[i].time), i);
        index.set(canonicalTimeKey(data[i].time), i);
    }
    return index;
}

function resolveSegmentSignalIndex(
    signal: Signal,
    segment: ContiguousTimeSegment,
    segmentTimeIndex: Map<string, number> | null
): number | null {
    if (Number.isFinite(signal.barIndex as number)) {
        const barIndex = Math.trunc(signal.barIndex as number);
        if (barIndex >= 0 && barIndex < segment.data.length) {
            return barIndex;
        }
    }

    if (segmentTimeIndex === null) return null;

    return segmentTimeIndex.get(timeKey(signal.time))
        ?? segmentTimeIndex.get(canonicalTimeKey(signal.time))
        ?? null;
}

function remapSegmentSignal(
    signal: Signal,
    segment: ContiguousTimeSegment,
    segmentTimeIndex: Map<string, number> | null
): Signal | null {
    const localIndex = resolveSegmentSignalIndex(signal, segment, segmentTimeIndex);
    if (localIndex === null) return null;

    const candle = segment.data[localIndex];
    return {
        ...signal,
        time: candle.time as Time,
        barIndex: segment.offset + localIndex,
    };
}

function sliceContextForSegment(
    context: StrategyExecutionContext | undefined,
    segment: ContiguousTimeSegment
): StrategyExecutionContext | undefined {
    if (!context?.crossSymbol) return context;

    const secondaryData = context.crossSymbol.secondaryData.slice(
        segment.offset,
        segment.offset + segment.data.length
    );
    return {
        ...context,
        crossSymbol: {
            ...context.crossSymbol,
            secondaryData,
            alignedLength: Math.min(segment.data.length, secondaryData.length),
            trimmedLeadingBars: context.crossSymbol.trimmedLeadingBars + segment.offset,
        },
    };
}

export function getOneSecondTimeGapSegments(
    data: OHLCVData[],
    interval: string
): ContiguousTimeSegment[] | null {
    if (parseIntervalSeconds(interval) !== 1 || data.length <= 1) {
        return null;
    }

    const segments: ContiguousTimeSegment[] = [];
    let segmentStart = 0;
    let previousSec = candleTimeSec(data[0]);

    for (let i = 1; i < data.length; i++) {
        const currentSec = candleTimeSec(data[i]);
        if (previousSec === null || currentSec === null || currentSec - previousSec !== 1) {
            segments.push({
                data: data.slice(segmentStart, i),
                offset: segmentStart,
            });
            segmentStart = i;
        }
        previousSec = currentSec;
    }

    if (segmentStart === 0) {
        return null;
    }

    segments.push({
        data: data.slice(segmentStart),
        offset: segmentStart,
    });
    return segments;
}

export function executeStrategyAcrossTimeGapSegments(args: {
    segments: readonly ContiguousTimeSegment[];
    executionContext?: StrategyExecutionContext;
    executeSegment: SegmentSignalExecutor;
}): Signal[] {
    const signals: Signal[] = [];
    for (const segment of args.segments) {
        if (segment.data.length === 0) continue;

        const segmentContext = sliceContextForSegment(args.executionContext, segment);
        const segmentSignals = args.executeSegment(segment.data, segmentContext);
        if (segmentSignals.length === 0) continue;

        let segmentTimeIndex: Map<string, number> | null = null;
        for (const signal of segmentSignals) {
            if (!Number.isFinite(signal.barIndex as number)) {
                segmentTimeIndex ??= buildSegmentTimeIndex(segment.data);
            } else {
                const barIndex = Math.trunc(signal.barIndex as number);
                if (barIndex < 0 || barIndex >= segment.data.length) {
                    segmentTimeIndex ??= buildSegmentTimeIndex(segment.data);
                }
            }
            const remapped = remapSegmentSignal(signal, segment, segmentTimeIndex);
            if (remapped) signals.push(remapped);
        }
    }
    return signals;
}

export function executeStrategyWithTimeGapIsolation(args: {
    data: OHLCVData[];
    interval: string;
    executionContext?: StrategyExecutionContext;
    execute: SegmentSignalExecutor;
}): Signal[] {
    const segments = getOneSecondTimeGapSegments(args.data, args.interval);
    if (!segments) {
        return args.execute(args.data, args.executionContext);
    }

    return executeStrategyAcrossTimeGapSegments({
        segments,
        executionContext: args.executionContext,
        executeSegment: args.execute,
    });
}
