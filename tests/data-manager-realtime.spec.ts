import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { countRealtimeGapBars, findFirstGapAnchorTime } from '../lib/realtime-gap-utils';
import type { OHLCVData, Time } from '../lib/types/strategies';

describe('DataManager realtime gap detection', () => {
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
