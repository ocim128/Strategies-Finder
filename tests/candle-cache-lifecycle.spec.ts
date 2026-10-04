import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearCachedCandlesDatabase, loadCachedCandles, saveCachedCandles } from '../lib/candle-cache';
import { FakeCandleIndexedDb } from './helpers/fake-candle-indexeddb';
import type { OHLCVData } from '../lib/types/strategies';

const originalIndexedDb = globalThis.indexedDB;
const candles: OHLCVData[] = [{ time: 60 as OHLCVData['time'], open: 100, high: 110, low: 90, close: 105, volume: 1 }];
let idb: FakeCandleIndexedDb;

beforeEach(async () => {
    await clearCachedCandlesDatabase();
    idb = new FakeCandleIndexedDb();
    idb.records.set('BTCUSDT::1m', { key: 'BTCUSDT::1m', candles, updatedAt: 1 });
    globalThis.indexedDB = idb as unknown as IDBFactory;
});
afterEach(async () => {
    await clearCachedCandlesDatabase();
    globalThis.indexedDB = originalIndexedDb;
});

describe('IndexedDB candle connection lifecycle', () => {
    it('opens after previously unavailable storage becomes available', async () => {
        globalThis.indexedDB = undefined as unknown as IDBFactory;
        assert.equal(await loadCachedCandles('BTCUSDT', '1m'), null);
        globalThis.indexedDB = idb as unknown as IDBFactory;
        assert.deepEqual((await loadCachedCandles('BTCUSDT', '1m'))?.candles, candles);
        assert.equal(idb.openCalls, 1);
    });

    for (const outcome of ['error', 'throw', 'blocked'] as const) {
        it(`recovers from an open ${outcome} after a cooldown without repeated probes`, async t => {
            t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
            idb.nextOpenOutcome = outcome;
            assert.equal(await loadCachedCandles('BTCUSDT', '1m'), null);
            assert.equal(await saveCachedCandles('BTCUSDT', '1m', candles, 'manual'), false);
            assert.equal(idb.openCalls, 1);
            t.mock.timers.tick(1000);
            assert.equal(await saveCachedCandles('BTCUSDT', '1m', candles, 'manual'), true);
            assert.deepEqual((await loadCachedCandles('BTCUSDT', '1m'))?.candles, candles);
            assert.equal(idb.openCalls, 2);
        });
    }

    it('bounds a stalled open and closes its connection if success arrives late', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        idb.nextOpenOutcome = 'stall';
        const result = loadCachedCandles('BTCUSDT', '1m');
        t.mock.timers.tick(8000);
        assert.equal(await result, null);
        idb.completePendingOpen();
        assert.equal(idb.closedConnections, 1);
        t.mock.timers.tick(1000);
        assert.deepEqual((await loadCachedCandles('BTCUSDT', '1m'))?.candles, candles);
    });

    it('closes on versionchange so another tab can delete the database, then reopens', async () => {
        await loadCachedCandles('BTCUSDT', '1m');
        idb.versionChange();
        assert.equal(idb.closedConnections, 1);
        assert.deepEqual((await loadCachedCandles('BTCUSDT', '1m'))?.candles, candles);
        assert.equal(idb.openCalls, 2);
    });

    it('returns null for failed, aborted, and synchronously blocked reads', async () => {
        await loadCachedCandles('BTCUSDT', '1m');
        for (const outcome of ['error', 'abort', 'throw'] as const) {
            idb.nextReadOutcome = outcome;
            assert.equal(await loadCachedCandles('BTCUSDT', '1m'), null);
        }
        assert.deepEqual((await loadCachedCandles('BTCUSDT', '1m'))?.candles, candles);
    });
});
