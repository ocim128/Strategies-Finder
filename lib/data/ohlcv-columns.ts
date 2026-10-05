import type { OHLCVData } from "../types/strategies";

/**
 * Columnar candle representation shared by the server CSV loaders: six
 * parallel Float64Arrays keep large seed series off the V8 object graph.
 * Storing candle OBJECTS at worker-cache capacities poisoned V8's collector
 * in TOP_MEAN runs (a 512-entry object cache held ~12.6M live objects and
 * slowed workers 3-12x under GC storms), while typed-array backing stores
 * are GC-invisible external memory and a materialization per cache hit costs
 * ~1-2 ms against ~70-140 ms for a full text re-parse.
 *
 * Inputs already have normalized numeric timestamps; packing preserves
 * `Number(bar.time)`. Candle objects are materialized fresh per read so
 * callers can mutate returned bars without touching the cached columns.
 */
export interface OhlcvColumns {
    time: Float64Array;
    open: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
}

export function columnsFromCandles(candles: OHLCVData[]): OhlcvColumns {
    const n = candles.length;
    const columns: OhlcvColumns = {
        time: new Float64Array(n),
        open: new Float64Array(n),
        high: new Float64Array(n),
        low: new Float64Array(n),
        close: new Float64Array(n),
        volume: new Float64Array(n),
    };
    for (let i = 0; i < n; i += 1) {
        const bar = candles[i]!;
        columns.time[i] = Number(bar.time);
        columns.open[i] = bar.open;
        columns.high[i] = bar.high;
        columns.low[i] = bar.low;
        columns.close[i] = bar.close;
        columns.volume[i] = bar.volume;
    }
    return columns;
}

/**
 * Materialize fresh candle objects from `startIndex` onward. Bars are
 * contiguous by index, so a tail read passes the computed start instead of
 * copying columns; the default materializes the full series. The start index
 * is the caller's bounds policy — no normalization happens here, so an
 * out-of-range start surfaces `Array`'s RangeError (the IBKR loader relies on
 * that throw for its null contract on invalid limits).
 */
export function candlesFromColumns(columns: OhlcvColumns, startIndex = 0): OHLCVData[] {
    const n = columns.time.length;
    const candles: OHLCVData[] = new Array(n - startIndex);
    for (let i = startIndex; i < n; i += 1) {
        candles[i - startIndex] = {
            time: columns.time[i]! as OHLCVData["time"],
            open: columns.open[i]!,
            high: columns.high[i]!,
            low: columns.low[i]!,
            close: columns.close[i]!,
            volume: columns.volume[i]!,
        };
    }
    return candles;
}
