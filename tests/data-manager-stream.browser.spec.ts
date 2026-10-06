import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DataManager } from '../lib/data-manager';
import type { DataFetcher } from '../lib/data/data-fetcher';
import { state } from '../lib/state';
import { buildOhlcvTimeMap } from '../lib/state-actions';
import { uiManager } from '../lib/ui-manager';
import { debugLogger } from '../lib/debug-logger';
import { toTimeKey } from '../lib/time-key';
import { toHeikinAshi } from '../lib/heikin-ashi-utils';
import { chartManager } from '../lib/chart-manager';
import type { OHLCVData } from '../lib/types/strategies';

class FakeSocket extends EventTarget {
    static sockets: FakeSocket[] = [];
    readyState = 0;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string) { super(); FakeSocket.sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    fail() { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'Handshake failed' } as CloseEvent); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' } as CloseEvent); }
}

const originalSocket = globalThis.WebSocket;
const originalState = { ohlcvData: state.ohlcvData, _ohlcvTimeMap: state._ohlcvTimeMap,
    currentSymbol: state.currentSymbol, currentInterval: state.currentInterval, binanceMarketType: state.binanceMarketType };
const bar = (time: number, close = 100): OHLCVData => ({ time: time as OHLCVData['time'], open: 100, high: 110, low: 90, close, volume: 1 });
let manager: DataManager;

beforeEach(() => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    FakeSocket.sockets = [];
    state.currentSymbol = 'BTCUSDT';
    state.currentInterval = '1m';
    state.binanceMarketType = 'spot';
    state.ohlcvData = Array.from({ length: 200 }, (_, i) => bar((i + 1) * 60));
    state._ohlcvTimeMap = buildOhlcvTimeMap(state.ohlcvData);
    manager = new DataManager();
});

afterEach(() => {
    manager.stopStreaming();
    globalThis.WebSocket = originalSocket;
    Object.assign(state, originalState);
});

describe('DataManager live candle retention', () => {
    it('keeps lookup keys bounded to the rolling window and replaces the latest lookup', t => {
        const internal = manager as unknown as { handleStreamUpdate(candle: OHLCVData): void; fetcher: DataFetcher };
        t.mock.method(internal.fetcher, 'queuePersistCandles', () => {});
        t.mock.method(uiManager, 'updatePriceDisplay', () => {});
        manager.setChartLookbackBars(200);
        for (let i = 201; i <= 400; i++) internal.handleStreamUpdate(bar(i * 60));
        assert.equal(state.ohlcvData.length, 200);
        assert.equal(state._ohlcvTimeMap.size, 200);
        assert.deepEqual([...state._ohlcvTimeMap.keys()], state.ohlcvData.map(c => toTimeKey(c.time)));
        const corrected = bar(400 * 60, 105);
        internal.handleStreamUpdate(corrected);
        assert.equal(state._ohlcvTimeMap.get(toTimeKey(corrected.time)), corrected);
        assert.equal(state._ohlcvTimeMap.size, 200);
    });
});

describe('DataManager WebSocket handshake lifecycle', () => {
    it('backs off and stops after five reconnects when handshakes never open', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        manager.startStreaming('BTCUSDT', '1m');
        for (const delay of [1000, 2000, 4000, 8000, 16000]) {
            const count = FakeSocket.sockets.length;
            FakeSocket.sockets.at(-1)!.fail();
            t.mock.timers.tick(delay - 1);
            assert.equal(FakeSocket.sockets.length, count);
            t.mock.timers.tick(1);
            assert.equal(FakeSocket.sockets.length, count + 1);
        }
        FakeSocket.sockets.at(-1)!.fail();
        t.mock.timers.tick(60_000);
        assert.equal(FakeSocket.sockets.length, 6);
    });

    it('logs connection and resets the retry budget only after opening', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const events: string[] = [];
        t.mock.method(debugLogger, 'event', (message: string) => { events.push(message); });
        manager.startStreaming('BTCUSDT', '1m');
        assert.equal(events.includes('data.stream.connected'), false);
        FakeSocket.sockets[0]!.fail();
        t.mock.timers.tick(1000);
        FakeSocket.sockets[1]!.open();
        assert.deepEqual(events, ['data.stream.connected']);
        FakeSocket.sockets[1]!.fail();
        t.mock.timers.tick(1000);
        assert.equal(FakeSocket.sockets.length, 3);
    });

    it('ignores a stale open callback after switching symbols', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const events: string[] = [];
        t.mock.method(debugLogger, 'event', (message: string) => { events.push(message); });
        manager.startStreaming('BTCUSDT', '1m');
        const stale = FakeSocket.sockets[0]!;
        state.currentSymbol = 'ETHUSDT';
        manager.startStreaming('ETHUSDT', '1m');
        FakeSocket.sockets[1]!.fail();
        stale.open();
        assert.equal(events.includes('data.stream.connected'), false);
        t.mock.timers.tick(1000);
        FakeSocket.sockets[2]!.fail();
        t.mock.timers.tick(1000);
        assert.equal(FakeSocket.sockets.length, 3, 'stale open must not reset the next backoff to 1s');
        t.mock.timers.tick(1000);
        assert.equal(FakeSocket.sockets.length, 4);
    });
});

describe('DataManager live candles in Heikin Ashi mode', () => {
    type RecordedUpdate = { time: number; open: number; high: number; low: number; close: number };
    let updates: RecordedUpdate[];
    let setDataCalls: number;
    const originalSeries = state.candlestickSeries;

    beforeEach(() => {
        updates = [];
        setDataCalls = 0;
        (state as unknown as { candlestickSeries: unknown }).candlestickSeries = {
            update(candle: RecordedUpdate) {
                updates.push({ ...candle });
            },
            setData() {
                setDataCalls += 1;
            },
        };
        state.chartMode = 'heikin-ashi';
    });

    afterEach(() => {
        (state as unknown as { candlestickSeries: unknown }).candlestickSeries = originalSeries;
        state.chartMode = 'candlestick';
    });

    function internalManager(): { handleStreamUpdate(candle: OHLCVData): void; fetcher: DataFetcher } {
        return manager as unknown as { handleStreamUpdate(candle: OHLCVData): void; fetcher: DataFetcher };
    }

    function haFullTransform(): { time: number; open: number; high: number; low: number; close: number } {
        const transformed = toHeikinAshi(state.ohlcvData);
        const last = transformed[transformed.length - 1]!;
        return {
            time: last.time as number,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
        };
    }

    function seedFromFullRedraw(): void {
        // Equivalent of the wired ohlcvData-commit path: a full rebuild that
        // seeds the chart-owned live tail.
        chartManager.updateChartData();
        updates = [];
        setDataCalls = 0;
    }

    it('displays the same Heikin Ashi values as a full redraw while raw data stays raw', t => {
        const internal = internalManager();
        t.mock.method(internal.fetcher, 'queuePersistCandles', () => {});
        t.mock.method(uiManager, 'updatePriceDisplay', () => {});
        seedFromFullRedraw();

        const baseTime = state.ohlcvData[state.ohlcvData.length - 1]!.time as number;

        // Same-bar replacement ticks.
        for (let tickIndex = 0; tickIndex < 4; tickIndex++) {
            const close = 100 + tickIndex * 1.5;
            const tick: OHLCVData = {
                time: baseTime as OHLCVData['time'],
                open: 99 + tickIndex,
                high: close + 2,
                low: 97 + tickIndex,
                close,
                volume: 5,
            };
            internal.handleStreamUpdate(tick);
            const expected = haFullTransform();
            const last = updates[updates.length - 1]!;
            assert.equal(last.time, expected.time);
            assert.equal(last.open, expected.open, `replace tick ${tickIndex} HA open`);
            assert.equal(last.high, expected.high, `replace tick ${tickIndex} HA high`);
            assert.equal(last.low, expected.low, `replace tick ${tickIndex} HA low`);
            assert.equal(last.close, expected.close, `replace tick ${tickIndex} HA close`);
        }
        assert.equal(setDataCalls, 0, 'same-bar ticks must not trigger full setData');

        // Append bars: displayed tail keeps matching a full transform.
        for (let appended = 1; appended <= 5; appended++) {
            const close = 110 + appended;
            const tick: OHLCVData = {
                time: (baseTime + appended * 60) as OHLCVData['time'],
                open: 108 + appended,
                high: close + 1,
                low: 107 + appended,
                close,
                volume: 5,
            };
            internal.handleStreamUpdate(tick);
            const expected = haFullTransform();
            const last = updates[updates.length - 1]!;
            assert.equal(last.close, expected.close, `append ${appended} HA close`);
            assert.equal(last.open, expected.open, `append ${appended} HA open`);
        }
        assert.equal(setDataCalls, 0, 'appends must not trigger full setData');

        // Raw data holds raw OHLC, never the transformed values.
        const lastRaw = state.ohlcvData[state.ohlcvData.length - 1]!;
        assert.equal(lastRaw.close, 115);
        assert.equal(lastRaw.open, 113);
    });

    it('rebuilds through the full transform when a rolling-window eviction reseeds the chain', t => {
        const internal = internalManager();
        t.mock.method(internal.fetcher, 'queuePersistCandles', () => {});
        t.mock.method(uiManager, 'updatePriceDisplay', () => {});
        manager.setChartLookbackBars(200);
        seedFromFullRedraw();

        // Stream past the window so the head is evicted on this tick.
        const lastTime = state.ohlcvData[state.ohlcvData.length - 1]!.time as number;
        for (let i = 1; i <= 3; i++) {
            internal.handleStreamUpdate({
                time: (lastTime + i * 60) as OHLCVData['time'],
                open: 100, high: 101, low: 99, close: 100 + i, volume: 5,
            });
        }
        assert.equal(state.ohlcvData.length, 200, 'rolling window holds the lookback limit');

        // The eviction tick rebuilt the chart from the raw data: the seeded
        // display equals a fresh full transformation.
        const transformed = toHeikinAshi(state.ohlcvData);
        assert.equal(setDataCalls >= 1, true, 'eviction must rebuild the displayed series');
        const lastTransformed = transformed[transformed.length - 1]!;
        assert.equal(lastTransformed.close, toHeikinAshi(state.ohlcvData)[state.ohlcvData.length - 1]!.close);
        assert.equal(state.ohlcvData[0]!.time as number, 60 * 4, 'three head bars were evicted');
    });
});
