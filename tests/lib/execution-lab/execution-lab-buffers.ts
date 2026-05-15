import { parseTimeToUnixSeconds } from "../time-normalization";
import type { PolymarketClob1sQuoteRow } from "../second-market/types";
import type { OHLCVData } from "../types/strategies";

type TimedCandle = {
    ts: number;
    candle: OHLCVData;
};

function candleUnixSeconds(candle: OHLCVData): number | null {
    const seconds = parseTimeToUnixSeconds(candle.time);
    return seconds === null || !Number.isFinite(seconds) ? null : Math.floor(seconds);
}

function timedCandles(candles: readonly OHLCVData[]): TimedCandle[] {
    const out: TimedCandle[] = [];
    for (const candle of candles) {
        const ts = candleUnixSeconds(candle);
        if (ts !== null) out.push({ ts, candle });
    }
    return out;
}

function trimCandles(candles: OHLCVData[], maxCandles: number): OHLCVData[] {
    return candles.length > maxCandles ? candles.slice(-maxCandles) : candles;
}

export function mergeExecutionLabCandles(
    current: readonly OHLCVData[],
    incoming: readonly OHLCVData[],
    maxCandles: number
): OHLCVData[] {
    if (incoming.length === 0) return current as OHLCVData[];
    const normalizedIncoming = timedCandles(incoming);
    if (normalizedIncoming.length === 0) return current as OHLCVData[];

    const currentTail = current[current.length - 1];
    const currentTailTs = currentTail ? candleUnixSeconds(currentTail) : null;
    let incomingIsOrdered = true;
    for (let i = 1; i < normalizedIncoming.length; i += 1) {
        if (normalizedIncoming[i].ts < normalizedIncoming[i - 1].ts) {
            incomingIsOrdered = false;
            break;
        }
    }

    const appendable = current.length === 0
        || (currentTailTs !== null && incomingIsOrdered && normalizedIncoming[0].ts >= currentTailTs);

    if (appendable) {
        const next = current.slice() as OHLCVData[];
        for (const item of normalizedIncoming) {
            const tail = next[next.length - 1];
            const tailTs = tail ? candleUnixSeconds(tail) : null;
            if (tailTs === item.ts) {
                next[next.length - 1] = item.candle;
            } else {
                next.push(item.candle);
            }
        }
        return trimCandles(next, maxCandles);
    }

    const byTime = new Map<number, OHLCVData>();
    for (const item of timedCandles(current)) byTime.set(item.ts, item.candle);
    for (const item of normalizedIncoming) byTime.set(item.ts, item.candle);
    return Array.from(byTime.entries())
        .sort((left, right) => left[0] - right[0])
        .slice(-maxCandles)
        .map((entry) => entry[1]);
}

export function sortedMapValues<T>(buffer: ReadonlyMap<number, T>): T[] {
    return Array.from(buffer.entries())
        .sort((left, right) => left[0] - right[0])
        .map((entry) => entry[1]);
}

function quoteKey(quote: PolymarketClob1sQuoteRow): string {
    return [
        quote.series_id,
        quote.symbol,
        quote.event_start_ts,
        quote.sample_ts,
        quote.yes_token_id,
        quote.no_token_id,
    ].join("|");
}

export function mergeExecutionLabQuotes(
    ...quoteGroups: readonly (readonly PolymarketClob1sQuoteRow[])[]
): PolymarketClob1sQuoteRow[] {
    const byKey = new Map<string, PolymarketClob1sQuoteRow>();
    for (const group of quoteGroups) {
        for (const quote of group) {
            if (!Number.isFinite(quote.sample_ts)) continue;
            const key = quoteKey(quote);
            const existing = byKey.get(key);
            if (!existing || (quote.source_ts_ms ?? 0) >= (existing.source_ts_ms ?? 0)) {
                byKey.set(key, quote);
            }
        }
    }
    return Array.from(byKey.values()).sort((left, right) =>
        left.sample_ts - right.sample_ts
        || left.event_start_ts - right.event_start_ts
        || (left.source_ts_ms ?? 0) - (right.source_ts_ms ?? 0)
    );
}
