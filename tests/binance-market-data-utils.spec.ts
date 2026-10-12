import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    intervalToSeconds,
    normalizeOhlcvCandles,
    resampleCandles,
    toBinanceInterval,
    translateIntervalForApiBase,
} from '../lib/binance-market-data-utils';
import type { Time } from '../lib/types/strategies';

/**
 * Binance/MEXC candle plumbing: wire rows are normalized and deduped before
 * they enter the engine, coarser intervals are resampled locally, and interval
 * tokens are translated per exchange. All pure and easy to regress.
 */

type Candle = {
    time: Time;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

function candle(time: number, open: number, high: number, low: number, close: number, volume: number): Candle {
    return { time: time as Time, open, high, low, close, volume };
}

describe('binance-market-data-utils: normalizeOhlcvCandles', () => {
    it('sorts ascending and dedupes by time (last row wins)', () => {
        const rows = [
            { time: 3600, open: '2', high: 3, low: 1, close: 2.5, volume: '10' },
            { time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 },
            { time: 0, open: 9, high: 9, low: 9, close: 9, volume: 9 },
        ];
        const out = normalizeOhlcvCandles(rows);
        expect(out).to.have.lengthOf(2);
        expect(out[0].time).to.equal(0);
        expect(out[0].open).to.equal(9);
        expect(out[1].time).to.equal(3600);
        expect(out[1].open).to.equal(2);
        expect(out[1].volume).to.equal(10);
    });

    it('drops rows with unparseable times or numeric fields', () => {
        const rows = [
            { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: 7200, open: 1, high: 'bad', low: 1, close: 1, volume: 1 },
            { time: 'not-a-time', open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: 10800, open: '', high: 1, low: 1, close: 1, volume: 1 },
        ];
        const out = normalizeOhlcvCandles(rows);
        expect(out).to.have.lengthOf(1);
        expect(out[0].time).to.equal(0);
    });

    it('accepts ISO time strings', () => {
        const out = normalizeOhlcvCandles([
            { time: '2023-11-14T22:13:20.000Z', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ]);
        expect(out).to.have.lengthOf(1);
        expect(out[0].time).to.equal(1_700_000_000);
    });

    it('returns an empty array for empty input', () => {
        expect(normalizeOhlcvCandles([])).to.deep.equal([]);
    });
});

describe('binance-market-data-utils: resampleCandles', () => {
    const hourly = [
        candle(0, 10, 12, 9, 11, 1),
        candle(3600, 11, 15, 10, 14, 2),
        candle(7200, 14, 14, 8, 9, 3),
        candle(10800, 9, 10, 7, 8, 4),
    ];

    it('aggregates open/high/low/close/volume into the target bucket', () => {
        const out = resampleCandles(hourly, '4h');
        expect(out).to.have.lengthOf(1);
        expect(out[0].time).to.equal(0);
        expect(out[0].open).to.equal(10);
        expect(out[0].high).to.equal(15);
        expect(out[0].low).to.equal(7);
        expect(out[0].close).to.equal(8);
        expect(out[0].volume).to.equal(10);
    });

    it('emits one candle per target bucket', () => {
        const extended = [...hourly, candle(14400, 8, 9, 6, 7, 5), candle(18000, 7, 8, 5, 6, 6)];
        const out = resampleCandles(extended, '4h');
        expect(out).to.have.lengthOf(2);
        expect(out[1].time).to.equal(14400);
        expect(out[1].open).to.equal(8);
        expect(out[1].close).to.equal(6);
        expect(out[1].volume).to.equal(11);
    });

    it('returns the input unchanged when the target is not coarser', () => {
        expect(resampleCandles(hourly, '1h')).to.equal(hourly);
        expect(resampleCandles(hourly, '30m')).to.equal(hourly);
    });

    it('returns the input unchanged for an unparseable target interval', () => {
        expect(resampleCandles(hourly, 'bad')).to.equal(hourly);
    });

    it('returns an empty array for empty input', () => {
        expect(resampleCandles([], '4h')).to.deep.equal([]);
    });
});

describe('binance-market-data-utils: toBinanceInterval', () => {
    it('passes through native Binance intervals', () => {
        expect(toBinanceInterval('1h')).to.equal('1h');
        expect(toBinanceInterval('1M')).to.equal('1M');
        expect(toBinanceInterval('1m')).to.equal('1m');
    });

    it('maps minute and hour tokens onto Binance intervals', () => {
        expect(toBinanceInterval('60m')).to.equal('1h');
        expect(toBinanceInterval('240m')).to.equal('4h');
        expect(toBinanceInterval('1440m')).to.equal('1d');
        expect(toBinanceInterval('24h')).to.equal('1d');
        expect(toBinanceInterval('168h')).to.equal('1w');
    });

    it('returns null for unsupported tokens', () => {
        expect(toBinanceInterval('7m')).to.equal(null);
        expect(toBinanceInterval('5x')).to.equal(null);
        expect(toBinanceInterval('')).to.equal(null);
    });
});

describe('binance-market-data-utils: translateIntervalForApiBase', () => {
    it('rewrites intervals for a MEXC base', () => {
        expect(translateIntervalForApiBase('https://api.mexc.com', '1h')).to.equal('60m');
        expect(translateIntervalForApiBase('https://api.mexc.com', '1m')).to.equal('1m');
        expect(translateIntervalForApiBase('https://api.mexc.com/', '4h')).to.equal('4h');
    });

    it('returns null when MEXC does not support the interval', () => {
        expect(translateIntervalForApiBase('https://api.mexc.com', '3m')).to.equal(null);
        expect(translateIntervalForApiBase('https://api.mexc.com', '1w')).to.equal(null);
    });

    it('leaves non-MEXC bases untouched', () => {
        expect(translateIntervalForApiBase('https://api.binance.com', '1h')).to.equal('1h');
        expect(translateIntervalForApiBase('https://data-api.binance.vision', '3m')).to.equal('3m');
    });
});

describe('binance-market-data-utils: intervalToSeconds', () => {
    it('converts supported intervals', () => {
        expect(intervalToSeconds('1h')).to.equal(3600);
        expect(intervalToSeconds('1d')).to.equal(86_400);
        expect(intervalToSeconds('15m')).to.equal(900);
    });

    it('returns null for unsupported intervals', () => {
        expect(intervalToSeconds('bad')).to.equal(null);
        expect(intervalToSeconds('0m')).to.equal(null);
    });
});
