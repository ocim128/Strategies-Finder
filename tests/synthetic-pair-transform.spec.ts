import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    aggregateSyntheticBars,
    buildSyntheticPairDataset,
    buildSyntheticPairPayload,
    pickSourceInterval,
    SyntheticAlignmentError,
    SyntheticQuoteError,
} from '../scripts/lib/synthetic-pair';
import type { OHLCVData } from '../lib/types/strategies';

function bar(time: number, overrides: Partial<OHLCVData> = {}): OHLCVData {
    return {
        time: time as OHLCVData['time'],
        open: overrides.open ?? 100,
        high: overrides.high ?? 105,
        low: overrides.low ?? 90,
        close: overrides.close ?? 102,
        volume: overrides.volume ?? 1234,
    };
}

describe('synthetic pair dataset builder', () => {
    it('builds ratio bars from aligned intersection timestamps', () => {
        const base = [
            bar(10, { open: 200, high: 220, low: 180, close: 210 }),
            bar(20, { open: 210, high: 250, low: 190, close: 240 }),
            bar(30, { open: 240, high: 260, low: 230, close: 250 }),
        ];
        const quote = [
            bar(10, { open: 1000, high: 1010, low: 990, close: 1005 }),
            bar(20, { open: 1005, high: 1020, low: 995, close: 1010 }),
            bar(30, { open: 1010, high: 1015, low: 995, close: 1000 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.equal(dataset.bars.length, 3);
        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10, 20, 30]);

        assert.equal(dataset.bars[0].open, 200 / 1000);
        assert.equal(dataset.bars[0].close, 210 / 1005);
        // high/low use same-instant ratios: max/min of (open, close, base.high/quote.high, base.low/quote.low)
        assert.equal(dataset.bars[0].high, 220 / 1010);
        assert.equal(dataset.bars[0].low, 180 / 990);
        assert.equal(dataset.bars[0].volume, 1234);

        assert.equal(dataset.bars[1].open, 210 / 1005);
        assert.equal(dataset.bars[1].close, 240 / 1010);
        assert.equal(dataset.bars[1].high, 250 / 1020);
        assert.equal(dataset.bars[1].low, 190 / 995);

        assert.equal(dataset.meta.droppedBars, 0);
        assert.equal(dataset.meta.alignedBars, 3);
    });

    it('keeps high >= max(open, close) and low <= min(open, close)', () => {
        const base = [
            bar(10, { open: 100, high: 120, low: 60, close: 110 }),
        ];
        const quote = [
            bar(10, { open: 500, high: 510, low: 490, close: 505 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '5m' });
        const candle = dataset.bars[0];

        assert.ok(candle.high >= candle.open, 'high should bound open');
        assert.ok(candle.high >= candle.close, 'high should bound close');
        assert.ok(candle.low <= candle.open, 'low should bound open');
        assert.ok(candle.low <= candle.close, 'low should bound close');
    });

    it('normalizes timestamps, sorts ascending, and dedupes by last-write-wins', () => {
        const base = [
            bar(30, { open: 10, high: 11, low: 9, close: 10.5 }),
            bar(10, { open: 8, high: 12, low: 6, close: 9 }),
            bar(20, { open: 9, high: 10, low: 7, close: 9.5 }),
            bar(20, { open: 9, high: 10, low: 7, close: 9.75 }),
        ];
        const quote = [
            bar(10, { open: 100, high: 101, low: 99, close: 100.5 }),
            bar(20, { open: 100.5, high: 102, low: 99.5, close: 101 }),
            bar(30, { open: 101, high: 101.5, low: 99.5, close: 100 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10, 20, 30]);
        assert.equal(dataset.bars[1].close, 9.75 / 101);
        assert.equal(dataset.meta.droppedBars, 0);
        assert.equal(dataset.meta.alignedBars, 3);
    });

    it('drops bars with missing or invalid quote legs and reports counts', () => {
        const base = [
            bar(10, { open: 100, high: 101, low: 99, close: 100 }),
            bar(20, { open: 100, high: 101, low: 99, close: 100 }),
            bar(30, { open: 100, high: 101, low: 99, close: 100 }),
            bar(40, { open: 100, high: 101, low: 99, close: 100 }),
        ];
        const quote = [
            bar(10, { open: 1000, high: 1010, low: 990, close: 1000 }),
            bar(30, { open: 0, high: 1010, low: 990, close: 1000 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m', minBars: 1 });

        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10]);
        assert.equal(dataset.meta.droppedBars, 3);
        assert.equal(dataset.meta.alignedBars, 1);
    });

    it('rejects empty base bars', () => {
        assert.throws(
            () => buildSyntheticPairDataset({ base: [], quote: [bar(1)], interval: '15m' }),
            /base.*at least one aligned bar/i
        );
    });

    it('rejects when no aligned bars remain', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(30)];

        assert.throws(
            () => buildSyntheticPairDataset({ base, quote, interval: '15m' }),
            SyntheticAlignmentError
        );
    });

    it('rejects empty quote bars', () => {
        assert.throws(
            () => buildSyntheticPairDataset({ base: [bar(1)], quote: [], interval: '15m' }),
            SyntheticQuoteError
        );
    });

    it('rejects when aligned bars are below minBars', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        assert.throws(
            () => buildSyntheticPairDataset({ base, quote, interval: '15m', minBars: 3 }),
            SyntheticAlignmentError
        );
    });
});

describe('synthetic pair payload builder', () => {
    it('produces import-compatible payload metadata and data shape', () => {
        const base = [bar(10), bar(20), bar(30)];
        const quote = [bar(10), bar(20), bar(30)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BNBUSDT',
            quoteSymbol: 'PAXGUSDT',
            interval: '15m',
            base,
            quote,
            generatedAt: '2026-01-01T00:00:00.000Z',
        });

        assert.equal(payload.symbol, 'BNBPAXG');
        assert.equal(payload.interval, '15m');
        assert.equal(payload.provider, 'synthetic');
        assert.equal(payload.generatedAt, '2026-01-01T00:00:00.000Z');
        assert.equal(payload.bars, 3);

        assert.equal(payload.source.method, 'ratio');
        assert.equal(payload.source.baseSymbol, 'BNBUSDT');
        assert.equal(payload.source.quoteSymbol, 'PAXGUSDT');

        assert.equal(payload.data.length, 3);
        for (const row of payload.data) {
            assert.equal(typeof row.time, 'number');
            assert.ok(Number.isFinite(row.open));
            assert.ok(Number.isFinite(row.high));
            assert.ok(Number.isFinite(row.low));
            assert.ok(Number.isFinite(row.close));
            assert.equal(row.volume, 1234);
        }
    });

    it('derives default synthetic symbol from base and quote suffix', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'ETHUSDT',
            quoteSymbol: 'PAXGUSDT',
            interval: '5m',
            base,
            quote,
        });

        assert.equal(payload.symbol, 'ETHPAXG');
    });

    it('allows explicit synthetic symbol override', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BNBUSDT',
            quoteSymbol: 'PAXGUSDT',
            symbol: 'BNBPAXGCUSTOM',
            interval: '1h',
            base,
            quote,
        });

        assert.equal(payload.symbol, 'BNBPAXGCUSTOM');
    });

    it('aggregates finer source bars before writing target payload', () => {
        const base = [
            bar(0, { open: 100, high: 104, low: 99, close: 103, volume: 10 }),
            bar(60, { open: 103, high: 108, low: 102, close: 107, volume: 20 }),
        ];
        const quote = [
            bar(0, { open: 200, high: 202, low: 198, close: 201, volume: 40 }),
            bar(60, { open: 201, high: 204, low: 200, close: 203, volume: 50 }),
        ];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BTCUSDT',
            quoteSymbol: 'ETHUSDT',
            interval: '2m',
            base,
            quote,
            sourceInterval: '1m',
        });

        assert.equal(payload.source.sourceInterval, '1m');
        assert.equal(payload.bars, 1);
        assert.equal(payload.data[0].open, 100 / 200);
        assert.equal(payload.data[0].close, 107 / 203);
        assert.equal(payload.data[0].volume, 30);
    });
});

describe('synthetic pair volume proxy', () => {
    it('uses the less-liquid leg as the synthetic volume proxy', () => {
        const base = [bar(10, { volume: 5000 })];
        const quote = [bar(10, { volume: 3000 })];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.equal(dataset.bars[0].volume, 3000);
    });
});

describe('pickSourceInterval', () => {
    it('picks a finer divisible interval when available', () => {
        const result = pickSourceInterval('4h');
        assert.ok(result);
        assert.equal(result!.sourceInterval, '30m');
        assert.equal(result!.ratio, 8);
    });

    it('returns null when the target is already too fine', () => {
        assert.equal(pickSourceInterval('1m'), null);
    });
});

describe('aggregateSyntheticBars', () => {
    it('aggregates OHLCV from sub-bars into target buckets', () => {
        const aggregated = aggregateSyntheticBars([
            { time: 0 as OHLCVData['time'], open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { time: 60 as OHLCVData['time'], open: 11, high: 15, low: 10, close: 14, volume: 150 },
        ], '2m');

        assert.equal(aggregated.length, 1);
        assert.equal(Number(aggregated[0].time), 0);
        assert.equal(aggregated[0].open, 10);
        assert.equal(aggregated[0].close, 14);
        assert.equal(aggregated[0].high, 15);
        assert.equal(aggregated[0].low, 9);
        assert.equal(aggregated[0].volume, 250);
    });

    it('uses earliest open and latest close for unsorted sub-bars', () => {
        const aggregated = aggregateSyntheticBars([
            { time: 60 as OHLCVData['time'], open: 11, high: 15, low: 10, close: 14, volume: 150 },
            { time: 0 as OHLCVData['time'], open: 10, high: 12, low: 9, close: 11, volume: 100 },
        ], '2m');

        assert.equal(aggregated.length, 1);
        assert.equal(Number(aggregated[0].time), 0);
        assert.equal(aggregated[0].open, 10);
        assert.equal(aggregated[0].close, 14);
        assert.equal(aggregated[0].high, 15);
        assert.equal(aggregated[0].low, 9);
        assert.equal(aggregated[0].volume, 250);
    });
});
