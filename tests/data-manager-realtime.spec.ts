import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { countRealtimeGapBars, findFirstGapAnchorTime } from '../lib/realtime-gap-utils';
import type { OHLCVData, Time } from '../lib/types/strategies';

describe('DataManager realtime gap detection', () => {
    const candleAt = (year: number, month: number): OHLCVData => ({
        time: (Date.UTC(year, month - 1, 1) / 1000) as Time,
        open: 1, high: 1, low: 1, close: 1, volume: 1,
    });

    it('keeps monthly and minute intervals distinct', () => {
        const april = candleAt(2026, 4);
        const may = candleAt(2026, 5);
        assert.equal(countRealtimeGapBars(april.time, may.time, '1M'), 0);
        assert.equal(findFirstGapAnchorTime([april, may], '1M'), null);
        assert.equal(countRealtimeGapBars(april.time, may.time, '1m'), 43_199);
    });

    it('handles adjacent calendar months of different lengths and year boundaries', () => {
        for (const [year, month] of [[2026, 1], [2026, 2], [2024, 2], [2026, 12]]) {
            const candles = [candleAt(year, month), candleAt(year, month + 1)];
            assert.equal(countRealtimeGapBars(candles[0].time, candles[1].time, '1M'), 0);
            assert.equal(findFirstGapAnchorTime(candles, '1M'), null);
        }
    });

    it('counts missing monthly candles and finds the first monthly gap', () => {
        const candles = [candleAt(2026, 1), candleAt(2026, 2), candleAt(2026, 4)];
        assert.equal(countRealtimeGapBars(candles[1].time, candles[2].time, ' 1M '), 1);
        assert.equal(findFirstGapAnchorTime(candles, '1M'), candles[1].time);
        assert.equal(countRealtimeGapBars(candleAt(2025, 10).time, candleAt(2026, 4).time, '3M'), 1);
        assert.equal(countRealtimeGapBars(candles[2].time, candles[0].time, '1M'), 0);
    });

    it('rejects out-of-range business days without leaking NaN into gap counts', () => {
        const invalid = { year: 300_000, month: 1, day: 1 };
        assert.equal(countRealtimeGapBars(invalid, 1_711_443_600, '5m'), 0);
        assert.equal(countRealtimeGapBars(1_711_443_600, invalid, '5m'), 0);
    });

    it('returns zero for same-bar and adjacent-bar updates', () => {
        assert.equal(countRealtimeGapBars(1_711_443_300, 1_711_443_300, '5m'), 0);
        assert.equal(countRealtimeGapBars(1_711_443_300, 1_711_443_600, '5m'), 0);
    });

    it('counts skipped 5m candles across a long realtime hole', () => {
        const lastBar = Date.UTC(2026, 2, 24, 22, 55, 0) / 1000;
        const nextBar = Date.UTC(2026, 2, 25, 7, 55, 0) / 1000;
        assert.equal(countRealtimeGapBars(lastBar, nextBar, '5m'), 107);
    });

    it('returns zero for invalid timestamps or intervals', () => {
        assert.equal(countRealtimeGapBars(null, 1_711_443_600, '5m'), 0);
        assert.equal(countRealtimeGapBars(1_711_443_300, 'bad-time', '5m'), 0);
        assert.equal(countRealtimeGapBars(1_711_443_300, 1_711_443_600, 'bad-interval'), 0);
    });

    it('finds the candle before the first internal cached gap', () => {
        const candles: OHLCVData[] = [
            { time: (Date.UTC(2026, 2, 24, 22, 45, 0) / 1000) as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: (Date.UTC(2026, 2, 24, 22, 50, 0) / 1000) as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: (Date.UTC(2026, 2, 24, 22, 55, 0) / 1000) as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: (Date.UTC(2026, 2, 25, 7, 55, 0) / 1000) as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: (Date.UTC(2026, 2, 25, 8, 0, 0) / 1000) as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ];

        assert.equal(
            findFirstGapAnchorTime(candles, '5m'),
            Date.UTC(2026, 2, 24, 22, 55, 0) / 1000
        );
    });
});
