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

/**
 * Pretty-print a captured configuration while inlining arrays of primitives
 * (symbols, strategy keys, sort orders) on one line — an all-strategies
 * selection otherwise balloons the record to hundreds of lines. Shared by the
 * browser "Copy Configuration" payload and the server-side archive config log
 * so both stay byte-compatible.
 */
export function formatCapturedConfiguration(value: unknown, depth = 0): string {
    const pad = "\t".repeat(depth);
    const inner = "\t".repeat(depth + 1);
    if (Array.isArray(value)) {
        const allPrimitives = value.every((item) => item === null || typeof item !== "object");
        if (allPrimitives) return JSON.stringify(value);
        if (value.length === 0) return "[]";
        return "[\n" + value.map((item) => inner + formatCapturedConfiguration(item, depth + 1)).join(",\n") + "\n" + pad + "]";
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return "{}";
        return "{\n" + entries.map(([key, item]) => inner + JSON.stringify(key) + ": " + formatCapturedConfiguration(item, depth + 1)).join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(value);
}
