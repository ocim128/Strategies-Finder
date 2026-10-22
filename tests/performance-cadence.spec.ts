import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimatePeriodsPerYear } from '../lib/strategies/performance-metrics';
import { timeToNumber } from '../lib/strategies/backtest/backtest-utils';
import type { Time } from '../lib/types/strategies';

type Sample = Time | { time: Time };
const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;
function reference(samples: Sample[], sampleCount = samples.length) {
    const deltas: number[] = [];
    let previous: number | null = null;
    for (let i = 0; i < sampleCount; i++) {
        const sample = samples[i];
        const numeric = timeToNumber(typeof sample === 'object' && sample !== null && 'time' in sample ? sample.time : sample);
        if (numeric === null) continue;
        const current = Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric;
        if (previous !== null && Number.isFinite(current - previous) && current > previous) deltas.push(current - previous);
        previous = current;
    }
    if (!deltas.length) return 1;
    deltas.sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    const typical = deltas.length & 1 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
    return Number.isFinite(typical) && typical > 0 ? Math.max(1, YEAR_MS / typical) : 1;
}
describe('performance cadence weighted median', () => {
    it('matches sorting all observed positive deltas for every supported time shape and prefix', () => {
        let time = 1700000000;
        const numeric = Array.from({ length: 400 }, (_, i) => { time += [1800, 1800, 1800, 64800, 237600][i % 5]; return time as Time; });
        const datasets: Sample[][] = [numeric, numeric.map(time => ({ time })),
            numeric.map(time => new Date(Number(time) * 1000).toISOString() as Time),
            numeric.map(time => Number(time) * 1000 as Time),
            [{ year: 2024, month: 1, day: 2 }, { year: 2024, month: 1, day: 3 }, { year: 2024, month: 1, day: 5 }],
            [100 as Time, 100 as Time, 90 as Time, 'invalid' as Time, 110 as Time, 150 as Time],
            [0, 1, 3, 4, 6, 7, 9].map(day => (1700000000 + day * 86400) as Time),
            [], [0 as Time], Array.from({ length: 80 }, (_, i) => (1700000000 + i * i * 11) as Time)];
        for (const data of datasets) for (let count = 0; count <= data.length; count++) {
            assert.equal(estimatePeriodsPerYear(data, count), reference(data, count), `prefix ${count}`);
        }
    });
});
