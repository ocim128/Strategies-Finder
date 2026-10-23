import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getResampleBucketStart, resampleOHLCV } from '../lib/strategies/resample-utils';
import type { OHLCVData } from '../lib/types/strategies';

const candle = (time: number, price: number): OHLCVData => ({
    time: time as OHLCVData['time'], open: price, high: price + 2,
    low: price - 2, close: price + 1, volume: 10,
});

it('resamples across negative timestamps, bucket boundaries and partial final buckets without mutating input', () => {
    const input = [candle(-60, 10), candle(0, 20), candle(60, 30), candle(120, 40)];
    const original = structuredClone(input);
    assert.deepEqual(resampleOHLCV(input, '2m'), [
        { ...candle(-120, 10) },
        { time: 0, open: 20, high: 32, low: 18, close: 31, volume: 20 },
        { ...candle(120, 40) },
    ]);
    assert.deepEqual(input, original);
});

it('preserves pass-through references and standalone bucket alignment', () => {
    const input = [candle(0, 10), candle(60, 20)];
    for (const interval of ['1m', '30s', 'bad', '0m']) {
        assert.equal(resampleOHLCV(input, interval), input);
    }
    assert.deepEqual(resampleOHLCV([], '2m'), []);
    assert.deepEqual(resampleOHLCV([candle(125, 10)], '2m'), [candle(120, 10)]);
    assert.equal(getResampleBucketStart(125.5, '2m'), 120);
    assert.equal(getResampleBucketStart(-0.5, '2m'), -120);
    assert.equal(getResampleBucketStart(125.5, 'bad'), 125);
});
