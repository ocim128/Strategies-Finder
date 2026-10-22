import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRollingMedian } from '../lib/strategies/lib/price-action-statistics-core';

// Historical sorted Array.splice implementation, independent of the fixed buffer.
function reference(values: number[], input: number) {
    const lookback = Math.max(1, Math.round(input));
    const result: (number | null)[] = new Array(values.length).fill(null);
    const window: number[] = [];
    const lowerBound = (value: number) => {
        let low = 0, high = window.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (window[mid] < value) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    for (let i = 0; i < values.length; i++) {
        window.splice(lowerBound(values[i]), 0, values[i]);
        if (i >= lookback) window.splice(lowerBound(values[i - lookback]), 1);
        if (i < lookback - 1) continue;
        const mid = lookback >> 1;
        result[i] = (lookback & 1) ? window[mid] : (window[mid - 1] + window[mid]) / 2;
    }
    return result;
}
describe('rolling median fixed-buffer parity', () => {
    it('matches historical output for random data, ties, non-finite values, even windows and warmup', () => {
        let seed = 41631;
        const values = Array.from({ length: 600 }, () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return (seed % 31) - 15;
        });
        const datasets = [values, values.map(Math.abs), Array(100).fill(0),
            [0, -0, 1, 1, Infinity, -Infinity, NaN, 5, 3, 7, 4, 8, 9], []];
        for (const data of datasets) for (const lookback of [0, 1, 2, 3, 7, 20, 30, 87, 129, 1000, 2.4, NaN, Infinity]) {
            const actual = buildRollingMedian(data, lookback);
            assert.deepEqual(actual, reference(data, lookback), `window ${lookback}`);
            assert.equal(buildRollingMedian(data, lookback), actual, 'cache identity');
        }
    });
    it('preserves the ordinary median and prefix causality', () => {
        const values = Array.from({ length: 160 }, (_, i) => Math.sin(i / 4) + i % 9);
        for (const lookback of [1, 2, 7, 30, 87]) {
            const result = buildRollingMedian(values, lookback);
            for (let i = lookback - 1; i < values.length; i++) {
                const sorted = values.slice(i - lookback + 1, i + 1).sort((a, b) => a - b);
                const mid = lookback >> 1;
                assert.equal(result[i], lookback & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
            }
            assert.deepEqual(buildRollingMedian(values.slice(0, 101), lookback), result.slice(0, 101));
        }
    });
});
