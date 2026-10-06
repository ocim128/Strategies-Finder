/**
 * Chart-manager live Heikin Ashi updates: the displayed HA values produced by
 * constant-time live ticks must equal a full toHeikinAshi redraw, raw data
 * must stay untouched, and untracked history transitions must fall back to a
 * full rebuild through updateChartData.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chartManager } from '../lib/chart-manager';
import { toHeikinAshi } from '../lib/heikin-ashi-utils';
import { state } from '../lib/state';
import type { OHLCVData } from '../lib/types/strategies';

type SeriesCandle = { time: unknown; open: number; high: number; low: number; close: number };

class FakeCandlestickSeries {
    updates: SeriesCandle[] = [];
    setDataCalls: SeriesCandle[][] = [];
    setDataCallCount = 0;
    baselineUpdates = 0;
    baselineSetDataCount = 0;

    update(candle: SeriesCandle): void {
        this.updates.push(candle);
    }

    setData(candles: SeriesCandle[]): void {
        this.setDataCallCount += 1;
        this.setDataCalls.push(candles);
    }

    /** Keep seeded setData history; future assertions measure deltas. */
    markBaseline(): void {
        this.baselineUpdates = this.updates.length;
        this.baselineSetDataCount = this.setDataCallCount;
    }

    updatesSinceBaseline(): SeriesCandle[] {
        return this.updates.slice(this.baselineUpdates);
    }

    setDataCallsSinceBaseline(): SeriesCandle[][] {
        return this.setDataCalls.slice(this.baselineSetDataCount);
    }

    displayed(): SeriesCandle[] {
        // The effective displayed series: last setData plus every update.
        const base: SeriesCandle[] = this.setDataCalls.length > 0
            ? this.setDataCalls[this.setDataCalls.length - 1]!.map((candle) => ({ ...candle }))
            : [];
        for (const candle of this.updates) {
            if (base.length > 0 && base[base.length - 1]!.time === candle.time) {
                base[base.length - 1] = { ...candle };
            } else {
                base.push({ ...candle });
            }
        }
        return base;
    }
}

const originalState = {
    ohlcvData: state.ohlcvData,
    chartMode: state.chartMode,
    candlestickSeries: state.candlestickSeries,
    chart: state.chart,
};

function rawCandle(time: number, open: number, close: number): OHLCVData {
    return {
        time: time as OHLCVData['time'],
        open,
        high: Math.max(open, close) + 5,
        low: Math.min(open, close) - 5,
        close,
        volume: 10,
    };
}

function makeHistory(count: number): OHLCVData[] {
    const out: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        out.push(rawCandle((i + 1) * 60, 100 + (i % 7), 100 + (i % 7) + (i % 3)));
    }
    return out;
}

let series: FakeCandlestickSeries;

beforeEach(() => {
    series = new FakeCandlestickSeries();
    state.chartMode = 'heikin-ashi';
    state.ohlcvData = makeHistory(50);
    (state as unknown as { candlestickSeries: unknown }).candlestickSeries = series;
    (state as unknown as { chart: unknown }).chart = null;
    chartManager.updateChartData();
    series.markBaseline();
});

afterEach(() => {
    state.chartMode = originalState.chartMode;
    state.ohlcvData = originalState.ohlcvData;
    (state as unknown as { candlestickSeries: unknown }).candlestickSeries = originalState.candlestickSeries;
    (state as unknown as { chart: unknown }).chart = originalState.chart;
});

describe('chart manager live Heikin Ashi updates', () => {
    it('matches a full redraw for same-bar replacements', () => {
        const live = state.ohlcvData[state.ohlcvData.length - 1]!;
        const tick = { ...rawCandle(live.time as number, 111, 113) };
        state.ohlcvData[state.ohlcvData.length - 1] = tick;
        chartManager.updateLiveCandle(tick);

        const expected = toHeikinAshi(state.ohlcvData);
        const updates = series.updatesSinceBaseline();
        assert.equal(updates.length, 1);
        const last = updates[updates.length - 1]!;
        assert.equal(last.time, expected[expected.length - 1]!.time);
        assert.equal(last.open, expected[expected.length - 1]!.open);
        assert.equal(last.high, expected[expected.length - 1]!.high);
        assert.equal(last.low, expected[expected.length - 1]!.low);
        assert.equal(last.close, expected[expected.length - 1]!.close);
        // Same-bar ticks must not trigger a full setData.
        assert.equal(series.setDataCallsSinceBaseline().length, 0);
    });

    it('matches a full redraw for repeated same-bar ticks', () => {
        const live = state.ohlcvData[state.ohlcvData.length - 1]!;
        for (let tickIndex = 0; tickIndex < 5; tickIndex++) {
            const tick = rawCandle(live.time as number, 100 + tickIndex, 102 + tickIndex);
            state.ohlcvData[state.ohlcvData.length - 1] = tick;
            chartManager.updateLiveCandle(tick);
            const expected = toHeikinAshi(state.ohlcvData);
            const updates = series.updatesSinceBaseline();
            assert.equal(
                updates[updates.length - 1]!.close,
                expected[expected.length - 1]!.close,
                `tick ${tickIndex} HA close must equal a full redraw`,
            );
        }
        assert.equal(series.setDataCallsSinceBaseline().length, 0);
    });

    it('matches a full redraw when a new bar appends, and keeps appending in constant time', () => {
        const nextTime = (state.ohlcvData[state.ohlcvData.length - 1]!.time as number) + 60;
        for (let appended = 1; appended <= 10; appended++) {
            const tick = rawCandle(nextTime + (appended - 1) * 60, 90 + appended, 95 + appended * 2);
            state.ohlcvData.push(tick);
            chartManager.updateLiveCandle(tick);

            const expected = toHeikinAshi(state.ohlcvData);
            const seeded = series.setDataCalls[series.setDataCalls.length - 1]!;
            const updates = series.updatesSinceBaseline();
            assert.equal(seeded.length + updates.length, expected.length, `after append ${appended}`);
            for (let i = 0; i < expected.length; i++) {
                const source = i < seeded.length ? seeded[i]! : updates[i - seeded.length]!;
                assert.equal(source.close, expected[i]!.close, `HA close at bar ${i}`);
                assert.equal(source.open, expected[i]!.open, `HA open at bar ${i}`);
            }
        }
        assert.equal(series.setDataCallsSinceBaseline().length, 0, 'appends must never call full setData');
    });

    it('raw candle data stays untouched by live HA updates', () => {
        const before = (state.ohlcvData as OHLCVData[]).map((candle) => ({ ...candle }));
        const live = state.ohlcvData[state.ohlcvData.length - 1]!;
        const tick = rawCandle(live.time as number, 120, 121);
        state.ohlcvData[state.ohlcvData.length - 1] = tick;
        chartManager.updateLiveCandle(tick);
        const nextTime = (live.time as number) + 60;
        const appended = rawCandle(nextTime, 120, 121);
        state.ohlcvData.push(appended);
        chartManager.updateLiveCandle(appended);

        // Raw OHLCV must equal the pre-tick raw OHLCV (plus the streamed
        // tick and appended bar): the HA transformation never writes
        // transformed values back into the source candles.
        assert.equal(state.ohlcvData.length, before.length + 1);
        for (let i = 0; i < before.length - 1; i++) {
            const raw = state.ohlcvData[i]!;
            const original = before[i]!;
            assert.deepEqual(
                [raw.open, raw.high, raw.low, raw.close, raw.volume],
                [original.open, original.high, original.low, original.close, original.volume],
                `raw candle ${i} must be untouched`,
            );
        }
        // The streamed tail keeps its raw OHLC values, not HA values.
        assert.deepEqual(
            [tick.open, tick.high, tick.low, tick.close, tick.volume],
            [120, 126, 115, 121, 10],
        );
        assert.deepEqual(
            [appended.open, appended.high, appended.low, appended.close, appended.volume],
            [120, 126, 115, 121, 10],
        );
    });

    it('falls back to a full rebuild when history is replaced with an earlier-ending tail', () => {
        // Replace history with data ending before the seeded tail time: the
        // live tail identity can no longer be the seeded one. (Same-length
        // same-time replacements always route through the ohlcvData commit,
        // whose updateChartData rebuild reseeds the tail.)
        const replaced = makeHistory(30);
        state.ohlcvData = replaced;
        const tick = rawCandle(replaced[replaced.length - 1]!.time as number, 50, 51);
        state.ohlcvData[state.ohlcvData.length - 1] = tick;
        chartManager.updateLiveCandle(tick);

        assert.equal(series.setDataCallsSinceBaseline().length, 1, 'untracked replacement must rebuild');
        const expected = toHeikinAshi(state.ohlcvData);
        const setData = series.setDataCalls[series.setDataCalls.length - 1]!;
        assert.equal(setData.length, expected.length);
        assert.equal(setData[setData.length - 1]!.open, expected[expected.length - 1]!.open);
    });

    it('initial empty data rebuilds on the first tick', () => {
        state.ohlcvData = [];
        chartManager.updateChartData();
        // Empty data clears the tail without touching the series.
        assert.equal(series.setDataCallsSinceBaseline().length, 0);
        series.markBaseline();

        const tick = rawCandle(60, 100, 101);
        state.ohlcvData = [tick];
        chartManager.updateLiveCandle(tick);

        // With no seeded tail, the first tick rebuilds through setData.
        assert.equal(series.setDataCallsSinceBaseline().length, 1);
        const expected = toHeikinAshi(state.ohlcvData);
        const setData = series.setDataCallsSinceBaseline()[0]!;
        assert.equal(setData.length, 1);
        assert.equal(setData[0]!.open, expected[0]!.open);
        assert.equal(setData[0]!.close, expected[0]!.close);
        assert.equal(series.updatesSinceBaseline().length, 0);
    });

    it('mode switches rebuild through updateChartData and reset the tail', () => {
        state.chartMode = 'candlestick';
        chartManager.updateChartData();
        series.markBaseline();

        // Candlestick mode: live ticks pass the raw candle through unchanged.
        const live = state.ohlcvData[state.ohlcvData.length - 1]!;
        const tick = rawCandle(live.time as number, 140, 141);
        state.ohlcvData[state.ohlcvData.length - 1] = tick;
        chartManager.updateLiveCandle(tick);
        assert.equal(series.updates[series.updates.length - 1]!.close, 141);

        // Back to Heikin Ashi: a full rebuild reseeds the tail.
        state.chartMode = 'heikin-ashi';
        chartManager.updateChartData();
        series.markBaseline();
        const tick2 = rawCandle(live.time as number, 150, 151);
        state.ohlcvData[state.ohlcvData.length - 1] = tick2;
        chartManager.updateLiveCandle(tick2);
        const expected = toHeikinAshi(state.ohlcvData);
        const updates = series.updatesSinceBaseline();
        assert.equal(updates.length, 1);
        assert.equal(updates[updates.length - 1]!.close, expected[expected.length - 1]!.close);
        assert.equal(series.setDataCallsSinceBaseline().length, 0);
    });

    it('eviction rebuilds preserve the visible logical range', () => {
        let visibleRange = { from: 10, to: 40 };
        let rangeRestored: { from: number; to: number } | null = null;
        (state as unknown as { chart: unknown }).chart = {
            timeScale: () => ({
                getVisibleLogicalRange: () => visibleRange,
                setVisibleLogicalRange: (range: { from: number; to: number }) => {
                    rangeRestored = { ...range };
                },
            }),
        };
        try {
            chartManager.rebuildChartDataAfterEviction();
            assert.deepEqual(rangeRestored, { from: 10, to: 40 });
            const expected = toHeikinAshi(state.ohlcvData);
            const setData = series.setDataCallsSinceBaseline()[0]!;
            assert.equal(setData.length, expected.length);
        } finally {
            (state as unknown as { chart: unknown }).chart = null;
            visibleRange = { from: 0, to: 0 };
        }
    });
});
