import { expect } from 'chai';
import { describe, it } from 'node:test';
import { trimToClosedCandles } from '../lib/closed-candle-utils';
import type { OHLCVData, Time } from '../lib/types/strategies';

/**
 * Live strategies must ignore the in-progress candle. This trims the trailing
 * (still-open) bar; the boundary is inclusive — a candle whose close equals
 * `now` is closed — and an unusable interval must degrade to "return all".
 */

function candle(time: number | string): OHLCVData {
    return { time: time as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

describe('closed-candle-utils: trimToClosedCandles', () => {
    const data = [candle(0), candle(3600), candle(7200), candle(10800)];

    it('keeps only candles whose window has fully closed', () => {
        expect(trimToClosedCandles(data, '1h', 10800)).to.have.lengthOf(3);
        expect(trimToClosedCandles(data, '1h', 10799)).to.have.lengthOf(2);
        expect(trimToClosedCandles(data, '1h', 3600)).to.have.lengthOf(1);
    });

    it('returns the same array reference when every candle is closed', () => {
        expect(trimToClosedCandles(data, '1h', 20_000)).to.equal(data);
    });

    it('returns the same array reference for empty input', () => {
        const empty: OHLCVData[] = [];
        expect(trimToClosedCandles(empty, '1h', 20_000)).to.equal(empty);
    });

    it('degrades to returning all candles for an unusable interval', () => {
        expect(trimToClosedCandles(data, '', 10800)).to.equal(data);
        expect(trimToClosedCandles(data, 'bad', 10800)).to.equal(data);
    });

    it('normalizes ISO time strings before comparing', () => {
        const iso = [candle('2023-11-14T22:13:20.000Z')]; // 1700000000
        expect(trimToClosedCandles(iso, '1h', 1_700_003_600)).to.have.lengthOf(1);
        expect(trimToClosedCandles(iso, '1h', 1_700_003_599)).to.have.lengthOf(0);
    });
});
