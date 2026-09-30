import { selectClosedCandleWindow } from "../alert-evaluation-window";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";

export interface TopMeanReplayTargetWindow {
    /** Closed candles plus the current candle when its open is already available. */
    executionCandles: OHLCVData[];
    /** Last fully closed candle, kept separate so terminal marks remain causal. */
    closedCandleTimeSec: number | null;
}

/**
 * Replay fills execute at candle opens, so the current candle's open is usable
 * once its timestamp is at or before the frozen cutoff. Terminal valuation
 * still uses only fully closed candles through `closedCandleTimeSec`.
 */
export function selectTopMeanReplayTargetWindow(
    candles: OHLCVData[],
    interval: string,
    cutoffSec: number,
): TopMeanReplayTargetWindow {
    const closedWindow = selectClosedCandleWindow(candles, interval, cutoffSec, 1);
    const executionCandles = closedWindow?.candles ?? [];
    const partialOpen = closedWindow?.nextOpenCandle
        ?? (executionCandles.length === 0 ? candles[0] ?? null : null);
    if (partialOpen) {
        const openTimeSec = parseTimeToUnixSeconds(partialOpen.time);
        if (openTimeSec !== null && openTimeSec <= cutoffSec) {
            executionCandles.push(partialOpen);
        }
    }
    return {
        executionCandles,
        closedCandleTimeSec: closedWindow?.closedCandleTimeSec ?? null,
    };
}
