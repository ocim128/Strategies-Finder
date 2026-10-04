import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DataManager } from '../lib/data-manager';
import type { DataFetcher } from '../lib/data/data-fetcher';
import { state } from '../lib/state';
import { buildOhlcvTimeMap } from '../lib/state-actions';
import { uiManager } from '../lib/ui-manager';
import { debugLogger } from '../lib/debug-logger';
import { toTimeKey } from '../lib/time-key';
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
