import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Time } from './lib/strategies/index';
import { isTwoHourParityAligned, resolveTwoHourParityFromTime } from './lib/two-hour-parity';
describe('2H Parity Normalization', () => {
    it('should resolve parity from ISO string candle times', () => {
        expect(resolveTwoHourParityFromTime('2026-02-14T01:00:00Z' as Time)).to.equal('even');
        expect(resolveTwoHourParityFromTime('2026-02-14T00:00:00Z' as Time)).to.equal('odd');
    });

    it('should resolve parity from BusinessDay candle times', () => {
        expect(resolveTwoHourParityFromTime({ year: 2026, month: 2, day: 14 } as Time)).to.equal('odd');
    });

    it('should validate alignment without Number(time) coercion', () => {
        const candles: OHLCVData[] = [
            { time: '2026-02-14T01:00:00Z' as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: '2026-02-14T03:00:00Z' as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ];

        expect(isTwoHourParityAligned(candles, 'even')).to.equal(true);
        expect(isTwoHourParityAligned(candles, 'odd')).to.equal(false);
    });
});

