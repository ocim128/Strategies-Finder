import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cumulative_return_percentile_reversion as strategy } from '../lib/strategies/lib/cumulative_return_percentile_reversion';
import { buildPercentileRank, buildRateOfChange } from '../lib/strategies/lib/price-action-statistics-core';
import { createBuySignal, createSellSignal, createSignalLoop } from '../lib/strategies/strategy-helpers';
import type { OHLCVData, StrategyParams } from '../lib/types/strategies';

function candles(closes: number[]): OHLCVData[] {
    return closes.map((close, i) => ({ time: (1700000000 + i * 1800) as OHLCVData['time'],
        open: close, high: close, low: close, close, volume: 100 }));
}
// Pre-optimization algorithm is the independent oracle for signals, warmup,
// strict percentile boundaries, reason strings and lower-bound tie ranks.
function reference(data: OHLCVData[], params: StrategyParams) {
    const p = strategy.normalizeParams!(params);
    const lookback = p.lookback;
    if (data.length < lookback) return [];
    const returns = buildRateOfChange(data.map(bar => bar.close), 1).map(v => v ?? 0);
    let sum = 0;
    const rollingSum = returns.map((value, i) => {
        sum += value;
        if (i >= lookback) sum -= returns[i - lookback];
        return sum;
    });
    const ranks = buildPercentileRank(rollingSum, lookback);
    return createSignalLoop(data, [ranks], i => {
        const rank = ranks[i];
        if (rank === null) return null;
        if (rank < 1 - p.pctlExtreme) return createBuySignal(data, i, `Cumulative return percentile buy: pct ${rank.toFixed(2)}`);
        if (rank > p.pctlExtreme) return createSellSignal(data, i, `Cumulative return percentile sell: pct ${rank.toFixed(2)}`);
        return null;
    });
}

describe('cumulative return percentile prepared execution', () => {
    const datasets = [
        candles(Array(300).fill(100)),
        candles(Array.from({ length: 500 }, (_, i) => 100 + Math.sin(i / 7) * 10 + Math.cos(i / 13) * 4)),
        candles(Array.from({ length: 300 }, (_, i) => [100, 100, 110, 110, 100, 90, 90][i % 7])),
        candles([100, 0, 100, 110, 90, NaN, ...Array(120).fill(100)]),
    ];
    it('matches the full-rank oracle for extremes, ties, interior thresholds and rank boundaries', () => {
        for (const data of datasets) {
            const prepared = strategy.prepareFinderData!(data);
            for (const lookback of [2, 3, 4, 7, 20, 87, 200, 1000]) {
                const boundary = (lookback - 2) / (lookback - 1);
                for (const pctlExtreme of [0.5, 0.75, 0.95, 0.999, boundary, boundary - 1e-12, boundary + 1e-12]) {
                    const params = { lookback, pctlExtreme };
                    const expected = reference(data, params);
                    assert.deepEqual(strategy.execute(data, params), expected, JSON.stringify(params));
                    assert.deepEqual(strategy.executePrepared!(prepared, params, data), expected, JSON.stringify(params));
                }
            }
        }
    });
    it('preserves prefix signals when future candles change and never reuses another window', () => {
        const data = datasets[1];
        const prepared = strategy.prepareFinderData!(data);
        for (const params of [{ lookback: 87, pctlExtreme: 0.999 }, { lookback: 20, pctlExtreme: 0.75 }]) {
            const prefix = data.slice(0, 230);
            const prefixSignals = strategy.execute(prefix, params);
            assert.deepEqual(strategy.executePrepared!(prepared, params, data).filter(signal => signal.barIndex! < prefix.length), prefixSignals);
            const changed = [...prefix, ...data.slice(230).map(bar => ({ ...bar, close: bar.close * 7 }))];
            assert.deepEqual(strategy.executePrepared!(prepared, params, changed), reference(changed, params));
            assert.deepEqual(strategy.execute(changed, params).filter(signal => signal.barIndex! < prefix.length), prefixSignals);
        }
    });
    it('bounds retained rank arrays and recomputes evicted lookbacks identically', () => {
        const data = datasets[1];
        const prepared = strategy.prepareFinderData!(data) as { ranks: Map<string, unknown> };
        for (const lookback of [5, 8, 13, 21, 34, 55, 87, 5]) {
            const params = { lookback, pctlExtreme: 0.999 };
            assert.deepEqual(strategy.executePrepared!(prepared, params, data), reference(data, params));
            assert.ok(prepared.ranks.size <= 4);
        }
        assert.deepEqual(strategy.executePrepared!(undefined, strategy.defaultParams, data), reference(data, strategy.defaultParams));
    });
});
