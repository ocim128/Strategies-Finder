import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { DataPersistence, type PersistenceContext } from '../lib/data/data-persistence';
import { clearCachedCandlesDatabase, clearLocalDailyCsvCachesForSymbols, saveCachedCandles } from '../lib/candle-cache';
import { resetLocalApiAvailability } from '../lib/local-api-transport';
import type { OHLCVData, Time } from '../lib/types/strategies';
import { FakeCandleIndexedDb } from './helpers/fake-candle-indexeddb';

const originalFetch = globalThis.fetch;
const originalIndexedDb = globalThis.indexedDB;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const bar = (time: number | string, close = 100): OHLCVData => ({ time: time as Time, open: 100, high: 110, low: 90, close, volume: 1 });
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
let idb: FakeCandleIndexedDb;
let persistence: DataPersistence;
let ctx: PersistenceContext;
let requests: OHLCVData[][];
let failNextStore: boolean;

beforeEach(async () => {
    await clearCachedCandlesDatabase();
    idb = new FakeCandleIndexedDb();
    globalThis.indexedDB = idb as unknown as IDBFactory;
    persistence = new DataPersistence();
    ctx = { syncAtByKey: new Map(), setCachedCandles: () => {} };
    requests = [];
    failNextStore = false;
    resetLocalApiAvailability();
    clearLocalDailyCsvCachesForSymbols();
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/api/sqlite/status')) return json({ ok: true });
        assert.ok(url.includes('/api/sqlite/store-ohlcv'), url);
        requests.push((JSON.parse(String(init!.body)) as { candles: OHLCVData[] }).candles);
        if (failNextStore) {
            failNextStore = false;
            return json({ ok: false, error: 'Write rejected' }, 400);
        }
        return json({ ok: true });
    };
});

afterEach(async () => {
    await clearCachedCandlesDatabase();
    globalThis.indexedDB = originalIndexedDb;
    globalThis.fetch = originalFetch;
    resetLocalApiAvailability();
    clearLocalDailyCsvCachesForSymbols();
});

function queue(candles: OHLCVData[]) {
    persistence.queuePersistCandles({
        symbol: 'BTCUSDT', interval: '1m', resolvedProvider: 'binance',
        storageSymbol: 'BTCUSDT', storageInterval: '1m', cacheKey: 'BTCUSDT::1m',
        providerLabel: 'Binance', candles, ctx,
    });
}

async function flush(t: TestContext, candles: OHLCVData[], elapsed = 1200) {
    queue(candles);
    t.mock.timers.tick(elapsed);
    await drain();
}

describe('stream candle persistence', () => {
    it('upserts same-timestamp corrections and the finalized previous candle', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        await flush(t, [bar(60), bar(120)]);
        await flush(t, [bar(60), bar('1970-01-01T00:02:00Z', 105)]);
        await flush(t, [bar(60), bar(120, 108), bar(180)]);
        assert.deepEqual(requests.map(rows => rows.map(row => [row.time, row.close])), [
            [[60, 100], [120, 100]], [[120, 105]], [[120, 108], [180, 100]],
        ]);
    });

    it('retains the cursor after failed writes and falls back even before the snapshot interval', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        await flush(t, [bar(60), bar(120)]);
        failNextStore = true;
        await flush(t, [bar(60), bar(120), bar(180)]);
        assert.equal(idb.writes.length, 2, 'rejected SQLite write must immediately persist a fallback snapshot');
        await flush(t, [bar(60), bar(120), bar(180), bar(240)]);
        assert.deepEqual(requests[2]!.map(row => row.time), [120, 180, 240]);
    });

    it('writes snapshots every 30 seconds under continuous stream updates', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        await flush(t, [bar(60), bar(120)]);
        for (let i = 1; i <= 8; i++) await flush(t, [bar(60), bar(120, 100 + i)], 5000);
        assert.equal(requests.length, 9);
        assert.deepEqual(idb.writes.map(record => record.updatedAt), [101_200, 131_200]);
    });

    it('retries an aborted snapshot without advancing the successful snapshot clock', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        idb.nextWriteOutcome = 'abort';
        await flush(t, [bar(60), bar(120)]);
        assert.equal(idb.records.size, 0);
        await flush(t, [bar(60), bar(120, 105)]);
        assert.equal(idb.writes.length, 2);
        assert.equal(idb.records.get('BTCUSDT::1m')!.candles[1]!.close, 105);
    });

    it('serializes slow writes and coalesces updates queued during a flush', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        let release!: (response: Response) => void;
        const fetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (String(input).includes('/store-ohlcv') && requests.length === 0) {
                requests.push((JSON.parse(String(init!.body)) as { candles: OHLCVData[] }).candles);
                return new Promise<Response>(resolve => { release = resolve; });
            }
            return fetch(input, init);
        };
        await flush(t, [bar(60), bar(120)]);
        await flush(t, [bar(60), bar(120), bar(180)]);
        queue([bar(60), bar(120, 108), bar(180), bar(240)]);
        assert.equal(requests.length, 1);
        release(json({ ok: true }));
        await drain();
        t.mock.timers.tick(1200);
        await drain();
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1]!.map(row => row.time), [120, 180, 240]);
        assert.equal(idb.writes.length, 1);
    });
});

describe('IndexedDB write acknowledgements', () => {
    it('reports completion and returns false for errors, aborts, and synchronous failures', async () => {
        for (const outcome of ['complete', 'error', 'abort', 'throw'] as const) {
            idb.nextWriteOutcome = outcome;
            assert.equal(await saveCachedCandles('BTCUSDT', '1m', [bar(120)], 'manual'), outcome === 'complete');
        }
    });
});

describe('IBKR authoritative local data', () => {
    function load(importedCandles?: OHLCVData[], signal?: AbortSignal) {
        return persistence.loadNonBinanceLocalData({
            symbol: 'AUDITROI\u2022', interval: '30m', provider: 'ibkr-local', maxBars: 2,
            storageSymbol: 'AUDITROI\u2022', storageInterval: '30m', cacheKey: 'AUDITROI\u2022::30m',
            importedCandles, signal, ctx,
        });
    }

    it('returns an explicit import without reading any fallback source', async () => {
        globalThis.fetch = async () => { throw new Error('unnecessary request'); };
        const result = await load([bar(60), bar(120), bar(180)]);
        assert.equal(result?.source, 'imported');
        assert.deepEqual(result?.candles.map(candle => candle.time), [120, 180]);
        assert.equal(idb.reads, 0);
    });

    it('returns a seed without probing SQLite or reading IndexedDB', async () => {
        const urls: string[] = [];
        globalThis.fetch = async input => {
            urls.push(String(input));
            assert.ok(String(input).includes('/price-data/ibkr/csv/30m/'));
            return new Response('time,open,high,low,close,volume\n2024-01-01T00:00:00Z,100,110,90,105,1\n2024-01-01T00:30:00Z,100,110,90,105,1\n');
        };
        const result = await load();
        assert.equal(result?.source, 'seed');
        assert.equal(result?.candles.length, 2);
        assert.equal(urls.length, 1);
        assert.equal(idb.reads, 0);
    });

    it('compares persisted fallbacks when the seed is missing', async () => {
        idb.records.set('AUDITROI\u2022::30m', { key: 'AUDITROI\u2022::30m', candles: [bar(60), bar(120)], updatedAt: 0 });
        globalThis.fetch = async input => {
            const url = String(input);
            if (url.includes('/price-data/')) return new Response('', { status: 404 });
            if (url.includes('/status')) return json({ ok: true });
            return json({ ok: true, candles: [bar(60)] });
        };
        const result = await load();
        assert.equal(result?.source, 'cache');
        assert.equal(result?.candles.length, 2);
        assert.equal(idb.reads, 1);
    });

    it('does not load fallbacks after cancellation during seed loading', async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            controller.abort();
            return new Response('', { status: 404 });
        };
        assert.equal(await load(undefined, controller.signal), null);
        assert.equal(calls, 1);
        assert.equal(idb.reads, 0);
    });
});
