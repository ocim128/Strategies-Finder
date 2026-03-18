import type { OHLCVData, Trade } from "./strategies/index";
import { parseTimeToUnixSeconds } from "./time-normalization";

export interface OpenTradeDisplayMetrics {
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    durationMs: number;
    displayExitReason: Trade["exitReason"];
    isSyntheticLiveExit: boolean;
}

function getTimestampMs(value: Trade["entryTime"] | Trade["exitTime"]): number {
    const sec = parseTimeToUnixSeconds(value);
    return sec === null ? 0 : sec * 1000;
}

function calculateApproxNetPnl(trade: Trade, exitPrice: number): { pnl: number; pnlPercent: number } {
    const directionFactor = trade.type === "long" ? 1 : -1;
    const rawPnl = (exitPrice - trade.entryPrice) * directionFactor * trade.size;
    const pnl = rawPnl - (trade.fees ?? 0);
    const entryValue = trade.size * trade.entryPrice;
    const pnlPercent = entryValue > 0 ? (pnl / entryValue) * 100 : trade.pnlPercent;
    return { pnl, pnlPercent };
}

function detectSyntheticExit(
    trade: Trade,
    liveCandle: OHLCVData
): { reason: "stop_loss" | "take_profit"; exitPrice: number } | null {
    if (trade.type === "long") {
        if (trade.stopLossPrice != null && Number.isFinite(trade.stopLossPrice) && liveCandle.low <= trade.stopLossPrice) {
            return { reason: "stop_loss", exitPrice: trade.stopLossPrice };
        }
        if (trade.takeProfitPrice != null && Number.isFinite(trade.takeProfitPrice) && liveCandle.high >= trade.takeProfitPrice) {
            return { reason: "take_profit", exitPrice: trade.takeProfitPrice };
        }
        return null;
    }

    if (trade.stopLossPrice != null && Number.isFinite(trade.stopLossPrice) && liveCandle.high >= trade.stopLossPrice) {
        return { reason: "stop_loss", exitPrice: trade.stopLossPrice };
    }
    if (trade.takeProfitPrice != null && Number.isFinite(trade.takeProfitPrice) && liveCandle.low <= trade.takeProfitPrice) {
        return { reason: "take_profit", exitPrice: trade.takeProfitPrice };
    }
    return null;
}

export function resolveOpenTradeDisplayMetrics(
    trade: Trade,
    liveCandle: OHLCVData | null,
    nowMs: number = Date.now()
): OpenTradeDisplayMetrics {
    const entryTs = getTimestampMs(trade.entryTime);
    const exitTs = getTimestampMs(trade.exitTime);
    const defaultDurationMs = entryTs > 0 && exitTs >= entryTs ? exitTs - entryTs : 0;
    const base: OpenTradeDisplayMetrics = {
        exitPrice: trade.exitPrice,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        durationMs: defaultDurationMs,
        displayExitReason: trade.exitReason,
        isSyntheticLiveExit: false,
    };

    if (trade.exitReason !== "end_of_data" || !liveCandle) {
        return base;
    }

    const liveCandleTsSec = parseTimeToUnixSeconds(liveCandle.time);
    const entryTsSec = parseTimeToUnixSeconds(trade.entryTime);
    if (liveCandleTsSec !== null && entryTsSec !== null && liveCandleTsSec < entryTsSec) {
        return base;
    }

    const syntheticExit = detectSyntheticExit(trade, liveCandle);
    if (syntheticExit) {
        const liveExit = calculateApproxNetPnl(trade, syntheticExit.exitPrice);
        return {
            exitPrice: syntheticExit.exitPrice,
            pnl: liveExit.pnl,
            pnlPercent: liveExit.pnlPercent,
            durationMs: entryTs > 0 ? Math.max(0, nowMs - entryTs) : defaultDurationMs,
            displayExitReason: syntheticExit.reason,
            isSyntheticLiveExit: true,
        };
    }

    const liveClose = Number(liveCandle.close);
    if (!Number.isFinite(liveClose)) {
        return base;
    }

    const liveMark = calculateApproxNetPnl(trade, liveClose);
    return {
        exitPrice: liveClose,
        pnl: liveMark.pnl,
        pnlPercent: liveMark.pnlPercent,
        durationMs: entryTs > 0 ? Math.max(0, nowMs - entryTs) : defaultDurationMs,
        displayExitReason: trade.exitReason,
        isSyntheticLiveExit: false,
    };
}
