/**
 * Shared normalization for captured Finder run configurations.
 *
 * Used by BOTH the browser "Copy Configuration" payload and the server-side
 * archive config log (`archive/asset opportunity/config.txt`). When the trade
 * filter toggle is off, the raw min/max inputs are stale UI values that no
 * runner enforces; captured verbatim they read as an active filter (the
 * "minTrades: 50 strictly enforced" archive misread). Normalizing them to null
 * keeps a captured config unambiguous: bounds present = filter enforced.
 */

export interface TradeFilterCapture {
    tradeFilterEnabled: boolean;
    minTrades: number | null;
    maxTrades: number | null;
}

export function captureTradeFilter(source: {
    tradeFilterEnabled?: boolean | null;
    minTrades?: number | null;
    maxTrades?: number | null;
}): TradeFilterCapture {
    const enabled = source.tradeFilterEnabled === true;
    return {
        tradeFilterEnabled: enabled,
        minTrades: enabled && typeof source.minTrades === "number" && Number.isFinite(source.minTrades)
            ? source.minTrades
            : null,
        maxTrades: enabled && typeof source.maxTrades === "number" && Number.isFinite(source.maxTrades)
            ? source.maxTrades
            : null,
    };
}
