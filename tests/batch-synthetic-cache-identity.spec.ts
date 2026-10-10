import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBatchDatasetLoaderCore, createBatchDatasetLoadDiagnostics, type CachedPairMetadata } from '../lib/batch-backtest/batch-dataset-loader-core';
import { SyntheticLegCache, buildLegCacheKey, buildPairCacheKey } from '../lib/batch-backtest/synthetic-leg-cache';
import { aggregateSyntheticBars, buildSyntheticPairDatasetFromNormalizedCandles } from '../scripts/lib/synthetic-pair';
import { DATA_CHART_TOTAL_LIMIT, SYNTHETIC_TARGET_BARS } from '../lib/data/constants';
import type { OHLCVData } from '../lib/types/strategies';

const BASE = 'BASE\u2022', QUOTE = 'QUOTE\u2022', THIRD = 'THIRD\u2022';
const PAIR = `${BASE}+${QUOTE}`;
const SOURCE_BARS = Math.min(SYNTHETIC_TARGET_BARS * 8, DATA_CHART_TOTAL_LIMIT);
const PAIR_KEY = buildPairCacheKey({ syntheticSymbol: PAIR, baseSymbol: BASE, quoteSymbol: QUOTE, interval: '4h', sourceInterval: '30m', sourceBars: SOURCE_BARS });

function leg(count = 8, start = 0, price = 101): OHLCVData[] {
    return Array.from({ length: count }, (_, i) => ({ time: (start + i * 1800) as OHLCVData['time'], open: price + i - 1, high: price + i + 2, low: price + i - 2, close: price + i, volume: 10 }));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function context(base: OHLCVData[], quote: OHLCVData[], metadataCache?: SyntheticLegCache<CachedPairMetadata>) {
    const legCache = new SyntheticLegCache<OHLCVData[]>(8);
    legCache.set(buildLegCacheKey(BASE, '30m', SOURCE_BARS), Promise.resolve(base));
    legCache.set(buildLegCacheKey(QUOTE, '30m', SOURCE_BARS), Promise.resolve(quote));
    const data = aggregateSyntheticBars(buildSyntheticPairDatasetFromNormalizedCandles({ base, quote }).bars, '4h');
    const pairCache = new SyntheticLegCache<OHLCVData[]>(8);
    pairCache.set(PAIR_KEY, Promise.resolve(data));
    return { legCache, pairCache, pairMetadataCache: metadataCache, diagnostics: createBatchDatasetLoadDiagnostics(), preferInMemorySyntheticPairs: true };
}

function loader() {
    return createBatchDatasetLoaderCore({ logPrefix: 'identity.test', fetchDetached: async () => [], fetchHistorical: async () => { throw new Error('all legs are preloaded'); } });
}

describe('synthetic cache dataset identity', () => {
    for (const explicitCache of [false, true]) {
        for (const [count, start] of [[8, 0], [8, 14400], [16, 14400]]) {
            it(`isolates pending metadata for different datasets (shared cache=${explicitCache}, bars=${count}, start=${start})`, async () => {
                const metadata = explicitCache ? new SyntheticLegCache<CachedPairMetadata>(8) : undefined;
                const a = context(leg(), leg(), metadata), bBase = leg(count, start, 201), bQuote = leg(count, start);
                const b = context(bBase, bQuote, metadata), gateA = deferred<OHLCVData[]>(), gateB = deferred<OHLCVData[]>();
                a.legCache.set(buildLegCacheKey(BASE, '30m', SOURCE_BARS), gateA.promise);
                b.legCache.set(buildLegCacheKey(BASE, '30m', SOURCE_BARS), gateB.promise);
                const service = loader();
                const first = service.loadWithMetadata(PAIR, '4h', undefined, a);
                const second = service.loadWithMetadata(PAIR, '4h', undefined, b);
                gateB.resolve(bBase);
                await new Promise<void>(resolve => setImmediate(resolve));
                gateA.resolve(leg());
                const [resultA, resultB] = await Promise.all([first, second]);
                assert.deepEqual(resultA.baseCloses, [108]);
                assert.deepEqual(resultB.baseCloses, count === 8 ? [208] : [208, 216]);
                assert.equal(resultB.baseCloses?.length, resultB.data.length);
                assert.deepEqual(Object.keys(resultB).sort(), ['baseCloses', 'baseSymbol', 'data', 'quoteCloses', 'quoteSymbol']);
            });
        }
    }

    it('still shares a metadata attempt for the same dataset', async () => {
        const base = leg(), quote = leg(), a = context(base, quote), b = context(base, quote);
        b.pairCache.set(PAIR_KEY, a.pairCache.peek(PAIR_KEY)!);
        const service = loader();
        const results = await Promise.all([service.loadWithMetadata(PAIR, '4h', undefined, a), service.loadWithMetadata(PAIR, '4h', undefined, b)]);
        assert.deepEqual(results.map(result => result.baseCloses), [[108], [108]]);
        assert.equal(a.diagnostics.legCacheHits + b.diagnostics.legCacheHits, 2);
    });

    it('rebuilds aligned closes when source prices change without changing coverage', async () => {
        const a = context(leg(), leg()), b = context(leg(8, 0, 201), leg());
        const service = loader();
        await service.loadWithMetadata(PAIR, '4h', undefined, a);
        // Fresh build first, then the settled metadata cache path.
        b.pairCache.clear();
        for (let run = 0; run < 2; run++) {
            const result = await service.loadWithMetadata(PAIR, '4h', undefined, b);
            assert.deepEqual(result.baseCloses, [208]);
            assert.deepEqual(result.quoteCloses, [108]);
            assert.equal(result.data[0].close, 208 / 108);
        }
    });

    it('refreshes a shared leg memo after a streamed last-candle replacement', async () => {
        const base = leg(), quote = leg(), run = context(base, quote), service = loader();
        await service.loadWithMetadata(PAIR, '4h', undefined, run);
        base[7] = { ...base[7], close: 109 };
        run.legCache.set(buildLegCacheKey(THIRD, '30m', SOURCE_BARS), Promise.resolve(quote));
        const result = await service.loadWithMetadata(`${BASE}+${THIRD}`, '4h', undefined, run);
        assert.deepEqual(result.baseCloses, [109]);
        assert.equal(result.data[0].close, 109 / 108);
    });
});
