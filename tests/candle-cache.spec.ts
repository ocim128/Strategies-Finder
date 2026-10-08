import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearCachedCandlesDatabase, clearLocalDailyCsvCachesForSymbols, loadCachedCandles, loadFreshIbkrCandlesFromPriceData, loadSeedCandlesFromPriceData, mergeCandles, saveCachedCandles } from '../lib/candle-cache';
import { FakeCandleIndexedDb } from './helpers/fake-candle-indexeddb';

describe('Candle cache', () => {
    const originalIndexedDb = (globalThis as Record<string, unknown>).indexedDB;
    const originalFetch = globalThis.fetch;
    let idb: FakeCandleIndexedDb;

    beforeEach(async () => {
        // Close any database connection a previous test retained before
        // replacing the factory it is bound to.
        await clearCachedCandlesDatabase();
        idb = new FakeCandleIndexedDb();
        Object.defineProperty(globalThis, 'indexedDB', {
            value: idb as unknown as IDBFactory,
            configurable: true,
            writable: true,
        });
        clearLocalDailyCsvCachesForSymbols();
    });

    afterEach(async () => {
        try {
            // Clear while the fake factory is installed so the retained
            // connection closes against it, then restore the real globals.
            await clearCachedCandlesDatabase();
        } finally {
            Object.defineProperty(globalThis, 'indexedDB', {
                value: originalIndexedDb,
                configurable: true,
                writable: true,
            });
            globalThis.fetch = originalFetch;
            clearLocalDailyCsvCachesForSymbols();
        }
    });

    it('merges already-parsed candles with sorted dedupe semantics on the fallback path', () => {
        const merged = mergeCandles(
            [
                { time: 2 as any, open: 10, high: 12, low: 9, close: 11, volume: 100 },
                { time: 4 as any, open: 20, high: 22, low: 19, close: 21, volume: 200 },
            ],
            [
                { time: 3 as any, open: 30, high: 32, low: 29, close: 31, volume: 300 },
                { time: 2 as any, open: 13, high: 14, low: 12, close: 13.5, volume: 150 },
            ],
        );

        expect(merged.map((bar) => Number(bar.time))).to.deep.equal([2, 3, 4]);
        expect(merged[0].close).to.equal(13.5);
        expect(merged[1].close).to.equal(31);
    });

    it('loads IBKR CSV candles as sorted deduped parsed candles', async () => {
        const responses = [
            { status: 404, ok: false },
            {
                status: 200,
                ok: true,
                text: async () => [
                    'date,open,high,low,close,volume',
                    '2024-01-02,10,12,9,11,100',
                    '2024-01-01,8,9,7,8.5,80',
                    '2024-01-02,11,13,10,12,110',
                ].join('\n'),
            },
        ];

        globalThis.fetch = (async () => {
            const next = responses.shift();
            if (!next) throw new Error('unexpected fetch');
            return next as Response;
        }) as typeof fetch;

        const candles = await loadSeedCandlesFromPriceData('CACHECSV\u2022', '1d');

        expect(candles).to.not.equal(null);
        expect(candles?.map((bar) => Number(bar.time))).to.deep.equal([
            Date.parse('2024-01-01T00:00:00Z') / 1000,
            Date.parse('2024-01-02T00:00:00Z') / 1000,
        ]);
        expect(candles?.[1].close).to.equal(12);
    });

    it('keeps IBKR local CSV cache entries separated by interval', async () => {
        const requestedPaths: string[] = [];

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const path = String(input);
            requestedPaths.push(path);
            const isDaily = path.includes('/price-data/ibkr/csv/1d/NVDA.csv');
            const isFourHour = path.includes('/price-data/ibkr/csv/4h/NVDA.csv');
            if (!isDaily && !isFourHour) {
                return { status: 404, ok: false } as Response;
            }
            const date = isDaily ? '2024-01-02' : '2024-01-02 14:30:00';
            const close = isDaily ? 101 : 202;
            return {
                status: 200,
                ok: true,
                text: async () => [
                    'time,open,high,low,close,volume',
                    `${date},100,210,90,${close},1000`,
                ].join('\n'),
            } as Response;
        }) as typeof fetch;

        const daily = await loadSeedCandlesFromPriceData('NVDA\u2022', '1d');
        const fourHour = await loadSeedCandlesFromPriceData('NVDA\u2022', '4h');
        const dailyAgain = await loadSeedCandlesFromPriceData('NVDA\u2022', '1d');

        expect(daily?.[0].close).to.equal(101);
        expect(fourHour?.[0].close).to.equal(202);
        expect(dailyAgain?.[0].close).to.equal(101);
        expect(requestedPaths.filter((path) => path.includes('/price-data/ibkr/csv/1d/NVDA.csv'))).to.have.length(1);
        expect(requestedPaths.filter((path) => path.includes('/price-data/ibkr/csv/4h/NVDA.csv'))).to.have.length(1);
    });

    it('excludes daily no-trade placeholders on cold, cached, and fresh IBKR seed reads', async () => {
        globalThis.fetch = async () => new Response([
            'time,open,high,low,close,volume',
            '2026-09-03T04:00:00Z,12.89,20.5,12.7,18.48,7598',
            '2026-09-04T04:00:00Z,0.3696,0.3696,0.3696,0.3696,0',
            '2026-09-08T04:00:00Z,18.585,20,18.425,19.99,7674',
        ].join('\n'));
        const symbol = 'TANH\u2022';
        for (const data of [
            await loadSeedCandlesFromPriceData(symbol, '1d'),
            await loadSeedCandlesFromPriceData(symbol, '1d'),
            await loadFreshIbkrCandlesFromPriceData(symbol, '1d'),
        ]) {
            expect(data?.map(bar => bar.open)).to.deep.equal([12.89, 18.585]);
        }
    });

    it('can bypass a retained IBKR CSV entry when a server synthetic leg needs authoritative data', async () => {
        let close = 101;
        let requests = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const path = String(input);
            if (!path.includes('/price-data/ibkr/csv/30m/NVDA.csv')) {
                return { status: 404, ok: false } as Response;
            }
            requests += 1;
            return {
                status: 200,
                ok: true,
                text: async () => [
                    'time,open,high,low,close,volume',
                    `2026-07-09T19:30:00.000Z,100,210,90,${close},1000`,
                ].join('\n'),
            } as Response;
        }) as typeof fetch;

        const cached = await loadSeedCandlesFromPriceData('NVDA\u2022', '30m');
        close = 202;
        const cachedAgain = await loadSeedCandlesFromPriceData('NVDA\u2022', '30m');
        const fresh = await loadFreshIbkrCandlesFromPriceData('NVDA\u2022', '30m');

        expect(cached?.[0].close).to.equal(101);
        expect(cachedAgain?.[0].close).to.equal(101);
        expect(fresh?.[0].close).to.equal(202);
        expect(requests).to.equal(2);
    });

    it('returns the write-sanitized IndexedDB payload without changing its candle ordering on read', async () => {
        await saveCachedCandles(
            'ethusdt',
            '1h',
            [
                { time: 3 as any, open: 30, high: 31, low: 29, close: 30.5, volume: 300 },
                { time: 1 as any, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
                { time: 1 as any, open: 12, high: 13, low: 11, close: 12.5, volume: 120 },
            ],
            'manual',
        );

        const cached = await loadCachedCandles('ETHUSDT', '1H');

        expect(cached).to.not.equal(null);
        expect(cached?.candles.map((bar) => Number(bar.time))).to.deep.equal([1, 3]);
        expect(cached?.candles[0].close).to.equal(12.5);
        expect(cached?.source).to.equal('manual');
    });
});
