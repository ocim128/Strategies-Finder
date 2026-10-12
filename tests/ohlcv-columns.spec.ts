import { expect } from 'chai';
import { describe, it } from 'node:test';
import { candlesFromColumns, columnsFromCandles } from '../lib/data/ohlcv-columns';
import type { OHLCVData, Time } from '../lib/types/strategies';

/**
 * The columnar candle representation keeps large seed series off the V8 object
 * graph. Packing must preserve values, materialization must return fresh
 * objects (callers mutate returned bars), and an out-of-range start must throw
 * because the IBKR loader relies on that RangeError for its null contract.
 */

function candle(time: number, open: number, high: number, low: number, close: number, volume: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const sample: OHLCVData[] = [
    candle(0, 1, 2, 0.5, 1.5, 10),
    candle(3600, 1.5, 3, 1, 2.5, 20),
    candle(7200, 2.5, 4, 2, 3.5, 30),
];

describe('ohlcv-columns: packing', () => {
    it('packs candles into parallel typed arrays', () => {
        const columns = columnsFromCandles(sample);
        expect(Array.from(columns.time)).to.deep.equal([0, 3600, 7200]);
        expect(Array.from(columns.open)).to.deep.equal([1, 1.5, 2.5]);
        expect(Array.from(columns.high)).to.deep.equal([2, 3, 4]);
        expect(Array.from(columns.low)).to.deep.equal([0.5, 1, 2]);
        expect(Array.from(columns.close)).to.deep.equal([1.5, 2.5, 3.5]);
        expect(Array.from(columns.volume)).to.deep.equal([10, 20, 30]);
    });

    it('produces zero-length columns for empty input', () => {
        const columns = columnsFromCandles([]);
        expect(columns.time.length).to.equal(0);
        expect(candlesFromColumns(columns)).to.deep.equal([]);
    });
});

describe('ohlcv-columns: materialization', () => {
    it('round-trips candles', () => {
        const columns = columnsFromCandles(sample);
        expect(candlesFromColumns(columns)).to.deep.equal(sample);
    });

    it('materializes a tail from a start index', () => {
        const columns = columnsFromCandles(sample);
        const tail = candlesFromColumns(columns, 1);
        expect(tail).to.have.lengthOf(2);
        expect(tail[0].time).to.equal(3600);
        expect(tail[1].time).to.equal(7200);
    });

    it('returns fresh objects so callers can mutate without touching columns', () => {
        const columns = columnsFromCandles(sample);
        const bars = candlesFromColumns(columns);
        bars[0].close = 999;
        expect(columns.close[0]).to.equal(1.5);
        expect(candlesFromColumns(columns)[0].close).to.equal(1.5);
    });

    it('throws for an out-of-range start index (IBKR null contract)', () => {
        const columns = columnsFromCandles(sample);
        expect(() => candlesFromColumns(columns, 5)).to.throw(RangeError);
    });
});
