import { parseIntervalSeconds } from "./interval-utils";
import { trimToClosedCandles } from "./closed-candle-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { BacktestSettings, OHLCVData } from "./types/strategies";

const DEFAULT_MIN_CLOSED_CANDLES = 200;

export interface ClosedCandleWindow {
    candles: OHLCVData[];
    closedCandleTimeSec: number;
    nextOpenCandle: OHLCVData | null;
}

export function getDefaultAlertMinClosedCandles(): number {
    return DEFAULT_MIN_CLOSED_CANDLES;
}

export function selectClosedCandleWindow(
    candles: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000),
    minClosedCandles: number = DEFAULT_MIN_CLOSED_CANDLES
): ClosedCandleWindow | null {
    if (candles.length === 0) return null;
    const intervalSeconds = parseIntervalSeconds(interval);
    if (!intervalSeconds || intervalSeconds <= 0) return null;

    let closedCount = 0;
    for (const candle of candles) {
        const openSec = parseTimeToUnixSeconds(candle.time);
        if (openSec === null || openSec + intervalSeconds > nowSec) break;
        closedCount += 1;
    }
    if (closedCount < minClosedCandles) return null;

    const closedTime = parseTimeToUnixSeconds(candles[closedCount - 1]!.time);
    if (closedTime === null) return null;

    return {
        candles: candles.slice(0, closedCount),
        closedCandleTimeSec: closedTime,
        nextOpenCandle: closedCount < candles.length ? candles[closedCount]! : null,
    };
}

export function buildExecutionAwareCandleWindow(
    closedCandles: OHLCVData[],
    nextOpenCandle: OHLCVData | null,
    settings: BacktestSettings
): OHLCVData[] {
    if (settings.executionModel !== "next_open") {
        return closedCandles;
    }
    if (!nextOpenCandle || closedCandles.length === 0) {
        return closedCandles;
    }

    const nextTime = parseTimeToUnixSeconds(nextOpenCandle.time);
    const lastTime = parseTimeToUnixSeconds(closedCandles[closedCandles.length - 1].time);
    const nextOpen = Number(nextOpenCandle.open);

    if (nextTime === null || !Number.isFinite(nextOpen) || nextOpen <= 0) {
        return closedCandles;
    }
    if (lastTime !== null && nextTime <= lastTime) {
        return closedCandles;
    }

    const bridgeCandle: OHLCVData = {
        time: nextOpenCandle.time,
        open: nextOpen,
        high: nextOpen,
        low: nextOpen,
        close: nextOpen,
        volume: 0,
    };

    return [...closedCandles, bridgeCandle];
}

export interface ExecutionAwareClosedCandleOptions {
    nowSec?: number;
    minClosedCandles?: number;
    fallbackToTrimmedClosed?: boolean;
}

export function selectExecutionAwareClosedCandles(
    candles: OHLCVData[],
    interval: string,
    settings: BacktestSettings,
    options?: ExecutionAwareClosedCandleOptions
): OHLCVData[] | null {
    const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
    const minClosedCandles = options?.minClosedCandles ?? DEFAULT_MIN_CLOSED_CANDLES;
    const closedWindow = selectClosedCandleWindow(candles, interval, nowSec, minClosedCandles);
    if (closedWindow) {
        return buildExecutionAwareCandleWindow(
            closedWindow.candles,
            closedWindow.nextOpenCandle,
            settings
        );
    }
    if (options?.fallbackToTrimmedClosed !== true) {
        return null;
    }

    const closedCandles = trimToClosedCandles(candles, interval, nowSec);
    const nextOpenCandle = closedCandles.length < candles.length
        ? candles[closedCandles.length] ?? null
        : null;
    return buildExecutionAwareCandleWindow(closedCandles, nextOpenCandle, settings);
}

export function countClosedCandles(
    candles: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000)
): number {
    if (candles.length === 0) return 0;
    const intervalSeconds = parseIntervalSeconds(interval);
    if (!intervalSeconds || intervalSeconds <= 0) return candles.length;
    const lastOpenSec = parseTimeToUnixSeconds(candles[candles.length - 1].time);
    if (lastOpenSec === null) return candles.length;
    return nowSec < lastOpenSec + intervalSeconds ? Math.max(0, candles.length - 1) : candles.length;
}
