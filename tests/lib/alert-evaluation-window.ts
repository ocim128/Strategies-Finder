import { parseIntervalSeconds } from "./interval-utils";
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
    if (candles.length < 2) return null;
    const intervalSeconds = parseIntervalSeconds(interval);
    if (!intervalSeconds || intervalSeconds <= 0) return null;

    let closedIdx = candles.length - 1;
    const lastOpenSec = Number(candles[closedIdx].time);
    if (!Number.isFinite(lastOpenSec)) return null;

    if (nowSec < lastOpenSec + intervalSeconds) {
        closedIdx -= 1;
    }
    if (closedIdx < minClosedCandles - 1) return null;

    const closedTime = Number(candles[closedIdx].time);
    if (!Number.isFinite(closedTime)) return null;

    return {
        candles: candles.slice(0, closedIdx + 1),
        closedCandleTimeSec: closedTime,
        nextOpenCandle: closedIdx + 1 < candles.length ? candles[closedIdx + 1] : null,
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

    const nextTime = Number(nextOpenCandle.time);
    const lastTime = Number(closedCandles[closedCandles.length - 1].time);
    const nextOpen = Number(nextOpenCandle.open);

    if (!Number.isFinite(nextTime) || !Number.isFinite(nextOpen) || nextOpen <= 0) {
        return closedCandles;
    }
    if (Number.isFinite(lastTime) && nextTime <= lastTime) {
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

export function countClosedCandles(
    candles: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000)
): number {
    if (candles.length === 0) return 0;
    const intervalSeconds = parseIntervalSeconds(interval);
    if (!intervalSeconds || intervalSeconds <= 0) return candles.length;
    const lastOpenSec = Number(candles[candles.length - 1].time);
    if (!Number.isFinite(lastOpenSec)) return candles.length;
    return nowSec < lastOpenSec + intervalSeconds ? Math.max(0, candles.length - 1) : candles.length;
}
