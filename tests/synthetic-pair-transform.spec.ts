import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    aggregateSyntheticBars,
    buildSyntheticPairDataset,
    buildSyntheticPairFromLegs,
    buildSyntheticPairPayload,
    pickSourceInterval,
    resolveSyntheticAvailableIntervals,
    resolveSyntheticSourceBars,
    SyntheticAlignmentError,
    SyntheticQuoteError,
} from '../scripts/lib/synthetic-pair';
import type { OHLCVData } from '../lib/types/strategies';

function bar(time: number, overrides: Partial<OHLCVData> = {}): OHLCVData {
    return {
        time: time as OHLCVData['time'],
        open: overrides.open ?? 100,
        high: overrides.high ?? 105,
        low: overrides.low ?? 90,
        close: overrides.close ?? 102,
        volume: overrides.volume ?? 1234,
    };
}

describe('synthetic pair dataset builder', () => {
    it('requests enough raw source bars to preserve the target final bar count after sub-bar aggregation', () => {
        assert.equal(resolveSyntheticSourceBars(50_000, 5), 250_000);
        assert.equal(resolveSyntheticSourceBars(50_000, 12), 600_000);
    });

    it('builds ratio bars from aligned intersection timestamps', () => {
        const base = [
            bar(10, { open: 200, high: 220, low: 180, close: 210 }),
            bar(20, { open: 210, high: 250, low: 190, close: 240 }),
            bar(30, { open: 240, high: 260, low: 230, close: 250 }),
        ];
        const quote = [
            bar(10, { open: 1000, high: 1010, low: 990, close: 1005 }),
            bar(20, { open: 1005, high: 1020, low: 995, close: 1010 }),
            bar(30, { open: 1010, high: 1015, low: 995, close: 1000 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.equal(dataset.bars.length, 3);
        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10, 20, 30]);

        assert.equal(dataset.bars[0].open, 200 / 1000);
        assert.equal(dataset.bars[0].close, 210 / 1005);
        // high/low use same-instant ratios: max/min of (open, close, base.high/quote.high, base.low/quote.low)
        assert.equal(dataset.bars[0].high, 220 / 1010);
        assert.equal(dataset.bars[0].low, 180 / 990);
        assert.equal(dataset.bars[0].volume, 1234);

        assert.equal(dataset.bars[1].open, 210 / 1005);
        assert.equal(dataset.bars[1].close, 240 / 1010);
        assert.equal(dataset.bars[1].high, 250 / 1020);
        assert.equal(dataset.bars[1].low, 190 / 995);

        assert.equal(dataset.meta.droppedBars, 0);
        assert.equal(dataset.meta.alignedBars, 3);
    });

    it('keeps high >= max(open, close) and low <= min(open, close)', () => {
        const base = [
            bar(10, { open: 100, high: 120, low: 60, close: 110 }),
        ];
        const quote = [
            bar(10, { open: 500, high: 510, low: 490, close: 505 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '5m' });
        const candle = dataset.bars[0];

        assert.ok(candle.high >= candle.open, 'high should bound open');
        assert.ok(candle.high >= candle.close, 'high should bound close');
        assert.ok(candle.low <= candle.open, 'low should bound open');
        assert.ok(candle.low <= candle.close, 'low should bound close');
    });

    it('degrades gracefully when only some quote OHLC points are zero or non-finite', () => {
        // rHigh (220/0) and rLow (180/0) become NaN and are filtered out;
        // the bar is still emitted with high/low collapsing onto the
        // finite open/close ratios. Locking this in so a future "cleanup"
        // cannot silently switch to dropping the whole bar.
        const base = [bar(10, { open: 200, high: 220, low: 180, close: 210 })];
        const quote = [bar(10, { open: 1000, high: 0, low: 0, close: 1005 })];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '5m' });

        assert.equal(dataset.bars.length, 1);
        assert.equal(dataset.bars[0].open, 200 / 1000);
        assert.equal(dataset.bars[0].close, 210 / 1005);
        assert.equal(dataset.bars[0].high, 210 / 1005);
        assert.equal(dataset.bars[0].low, 200 / 1000);
    });

    it('normalizes timestamps, sorts ascending, and dedupes by last-write-wins', () => {
        const base = [
            bar(30, { open: 10, high: 11, low: 9, close: 10.5 }),
            bar(10, { open: 8, high: 12, low: 6, close: 9 }),
            bar(20, { open: 9, high: 10, low: 7, close: 9.5 }),
            bar(20, { open: 9, high: 10, low: 7, close: 9.75 }),
        ];
        const quote = [
            bar(10, { open: 100, high: 101, low: 99, close: 100.5 }),
            bar(20, { open: 100.5, high: 102, low: 99.5, close: 101 }),
            bar(30, { open: 101, high: 101.5, low: 99.5, close: 100 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10, 20, 30]);
        assert.equal(dataset.bars[1].close, 9.75 / 101);
        assert.equal(dataset.meta.droppedBars, 0);
        assert.equal(dataset.meta.alignedBars, 3);
    });

    it('drops bars with missing or invalid quote legs and reports counts', () => {
        const base = [
            bar(10, { open: 100, high: 101, low: 99, close: 100 }),
            bar(20, { open: 100, high: 101, low: 99, close: 100 }),
            bar(30, { open: 100, high: 101, low: 99, close: 100 }),
            bar(40, { open: 100, high: 101, low: 99, close: 100 }),
        ];
        const quote = [
            bar(10, { open: 1000, high: 1010, low: 990, close: 1000 }),
            bar(30, { open: 0, high: 1010, low: 990, close: 1000 }),
        ];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m', minBars: 1 });

        assert.deepEqual(dataset.bars.map((bar) => bar.time), [10]);
        assert.equal(dataset.meta.droppedBars, 3);
        assert.equal(dataset.meta.alignedBars, 1);
    });

    it('rejects empty base bars', () => {
        assert.throws(
            () => buildSyntheticPairDataset({ base: [], quote: [bar(1)], interval: '15m' }),
            /base.*at least one aligned bar/i
        );
    });

    it('rejects when no aligned bars remain', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(30)];

        assert.throws(
            () => buildSyntheticPairDataset({ base, quote, interval: '15m' }),
            SyntheticAlignmentError
        );
    });

    it('rejects empty quote bars', () => {
        assert.throws(
            () => buildSyntheticPairDataset({ base: [bar(1)], quote: [], interval: '15m' }),
            SyntheticQuoteError
        );
    });

    it('rejects when aligned bars are below minBars', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        assert.throws(
            () => buildSyntheticPairDataset({ base, quote, interval: '15m', minBars: 3 }),
            SyntheticAlignmentError
        );
    });
});

describe('synthetic pair payload builder', () => {
    it('produces import-compatible payload metadata and data shape', () => {
        const base = [bar(10), bar(20), bar(30)];
        const quote = [bar(10), bar(20), bar(30)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BNBUSDT',
            quoteSymbol: 'PAXGUSDT',
            interval: '15m',
            base,
            quote,
            generatedAt: '2026-01-01T00:00:00.000Z',
        });

        assert.equal(payload.symbol, 'BNBPAXG');
        assert.equal(payload.interval, '15m');
        assert.equal(payload.provider, 'synthetic');
        assert.equal(payload.generatedAt, '2026-01-01T00:00:00.000Z');
        assert.equal(payload.bars, 3);

        assert.equal(payload.source.method, 'ratio');
        assert.equal(payload.source.baseSymbol, 'BNBUSDT');
        assert.equal(payload.source.quoteSymbol, 'PAXGUSDT');

        assert.equal(payload.data.length, 3);
        for (const row of payload.data) {
            assert.equal(typeof row.time, 'number');
            assert.ok(Number.isFinite(row.open));
            assert.ok(Number.isFinite(row.high));
            assert.ok(Number.isFinite(row.low));
            assert.ok(Number.isFinite(row.close));
            assert.equal(row.volume, 1234);
        }
    });

    it('derives default synthetic symbol from base and quote suffix', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'ETHUSDT',
            quoteSymbol: 'PAXGUSDT',
            interval: '5m',
            base,
            quote,
        });

        assert.equal(payload.symbol, 'ETHPAXG');
    });

    it('allows explicit synthetic symbol override', () => {
        const base = [bar(10), bar(20)];
        const quote = [bar(10), bar(20)];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BNBUSDT',
            quoteSymbol: 'PAXGUSDT',
            symbol: 'BNBPAXGCUSTOM',
            interval: '1h',
            base,
            quote,
        });

        assert.equal(payload.symbol, 'BNBPAXGCUSTOM');
    });

    it('aggregates finer source bars before writing target payload', () => {
        const base = [
            bar(0, { open: 100, high: 104, low: 99, close: 103, volume: 10 }),
            bar(60, { open: 103, high: 108, low: 102, close: 107, volume: 20 }),
        ];
        const quote = [
            bar(0, { open: 200, high: 202, low: 198, close: 201, volume: 40 }),
            bar(60, { open: 201, high: 204, low: 200, close: 203, volume: 50 }),
        ];

        const payload = buildSyntheticPairPayload({
            baseSymbol: 'BTCUSDT',
            quoteSymbol: 'ETHUSDT',
            interval: '2m',
            base,
            quote,
            sourceInterval: '1m',
        });

        assert.equal(payload.source.sourceInterval, '1m');
        assert.equal(payload.bars, 1);
        assert.equal(payload.data[0].open, 100 / 200);
        assert.equal(payload.data[0].close, 107 / 203);
        assert.equal(payload.data[0].volume, 30);
    });
});

describe('synthetic pair volume proxy', () => {
    it('uses the less-liquid leg as the synthetic volume proxy', () => {
        const base = [bar(10, { volume: 5000 })];
        const quote = [bar(10, { volume: 3000 })];

        const dataset = buildSyntheticPairDataset({ base, quote, interval: '15m' });

        assert.equal(dataset.bars[0].volume, 3000);
    });
});

describe('pickSourceInterval', () => {
    it('picks a finer divisible interval when available', () => {
        const result = pickSourceInterval('4h');
        assert.ok(result);
        assert.equal(result!.sourceInterval, '30m');
        assert.equal(result!.ratio, 8);
    });

    it('returns null when the target is already too fine', () => {
        assert.equal(pickSourceInterval('1m'), null);
    });

    it('respects the availableIntervals allowlist (IBKR case)', () => {
        // IBKR's supportedIntervals: ["1d","4h","1h","30m","15m","5m","1m"].
        // Without the filter, 1d -> 2h (ratio 12). With the filter, 2h is
        // skipped (not in the allowlist) and 4h is picked (ratio 6).
        const ibkr = resolveSyntheticAvailableIntervals('MU\u2022', 'TSLA\u2022');
        assert.deepEqual(ibkr, ['1d', '4h', '1h', '30m', '15m', '5m', '1m']);

        const result1d = pickSourceInterval('1d', 12, ibkr);
        assert.equal(result1d!.sourceInterval, '4h');
        assert.equal(result1d!.ratio, 6);

        // 4h -> 30m (same as crypto, since 30m IS in IBKR's list).
        const result4h = pickSourceInterval('4h', 12, ibkr);
        assert.equal(result4h!.sourceInterval, '30m');
        assert.equal(result4h!.ratio, 8);

        // 1h/2h use the canonical 30m IBKR seed. Optional 5m/15m snapshots
        // are not guaranteed to exist locally, while 30m is the source of
        // truth for ratio-before-aggregation synthetic construction.
        const result1h = pickSourceInterval('1h', 12, ibkr);
        assert.equal(result1h!.sourceInterval, '30m');
        assert.equal(result1h!.ratio, 2);

        const result2h = pickSourceInterval('2h', 12, ibkr);
        assert.equal(result2h!.sourceInterval, '30m');
        assert.equal(result2h!.ratio, 4);
    });

    it('returns null when the allowlist excludes every finer divisible candidate', () => {
        // 1m target with a restrictive allowlist: nothing finer is allowed.
        assert.equal(pickSourceInterval('1m', 12, ['1d', '4h', '1h']), null);
    });

    it('returns undefined allowlist for non-IBKR legs (crypto path)', () => {
        assert.equal(resolveSyntheticAvailableIntervals('BTCUSDT', 'ETHUSDT'), undefined);
    });
});

describe('aggregateSyntheticBars', () => {
    it('aggregates OHLCV from sub-bars into target buckets', () => {
        const aggregated = aggregateSyntheticBars([
            { time: 0 as OHLCVData['time'], open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { time: 60 as OHLCVData['time'], open: 11, high: 15, low: 10, close: 14, volume: 150 },
        ], '2m');

        assert.equal(aggregated.length, 1);
        assert.equal(Number(aggregated[0].time), 0);
        assert.equal(aggregated[0].open, 10);
        assert.equal(aggregated[0].close, 14);
        assert.equal(aggregated[0].high, 15);
        assert.equal(aggregated[0].low, 9);
        assert.equal(aggregated[0].volume, 250);
    });

    it('uses earliest open and latest close for unsorted sub-bars', () => {
        const aggregated = aggregateSyntheticBars([
            { time: 60 as OHLCVData['time'], open: 11, high: 15, low: 10, close: 14, volume: 150 },
            { time: 0 as OHLCVData['time'], open: 10, high: 12, low: 9, close: 11, volume: 100 },
        ], '2m');

        assert.equal(aggregated.length, 1);
        assert.equal(Number(aggregated[0].time), 0);
        assert.equal(aggregated[0].open, 10);
        assert.equal(aggregated[0].close, 14);
        assert.equal(aggregated[0].high, 15);
        assert.equal(aggregated[0].low, 9);
        assert.equal(aggregated[0].volume, 250);
    });
});

describe('buildSyntheticPairFromLegs', () => {
    it('builds 1h and 2h IBKR ratios from canonical 30m legs', async () => {
        const sourceBars = [0, 1800, 3600, 5400].map((time) => bar(time));

        for (const [interval, expectedBars] of [['1h', 2], ['2h', 1]] as const) {
            const calls: string[] = [];
            const result = await buildSyntheticPairFromLegs({
                baseSymbol: 'AAPL\u2022',
                quoteSymbol: 'MSFT\u2022',
                interval,
                targetBars: 2,
                assumeNormalizedLegs: true,
                fetchLeg: async (_symbol, sourceInterval) => {
                    calls.push(sourceInterval);
                    return sourceBars;
                },
            });

            assert.deepEqual(calls, ['30m', '30m']);
            assert.equal(result.sourceInterval, '30m');
            assert.equal(result.bars.length, expectedBars);
        }
    });

    it('runs the full pipeline (fetch -> align -> aggregate) and returns legs + meta', async () => {
        // Two 1m legs that align on timestamps 0 and 60; target interval 2m
        // forces pickSourceInterval to use 1m and aggregate two sub-bars each.
        const fetched: Record<string, OHLCVData[]> = {
            BASE: [
                bar(0, { open: 100, high: 110, low: 95, close: 105, volume: 10 }),
                bar(60, { open: 105, high: 115, low: 100, close: 110, volume: 20 }),
            ],
            QUOTE: [
                bar(0, { open: 50, high: 52, low: 48, close: 51, volume: 5 }),
                bar(60, { open: 51, high: 53, low: 49, close: 52, volume: 6 }),
            ],
        };
        const fetchLeg = async (symbol: string, _sourceInterval: string, _sourceBars: number) =>
            fetched[symbol];

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'BASE',
            quoteSymbol: 'QUOTE',
            interval: '2m',
            targetBars: 2,
            fetchLeg,
        });

        // Aggregated to a single 2m bar at time 0.
        assert.equal(result.bars.length, 1);
        assert.equal(Number(result.bars[0].time), 0);
        // open = base.open(0) / quote.open(0) = 100/50
        assert.equal(result.bars[0].open, 100 / 50);
        // close = base.close(60) / quote.close(60) = 110/52
        assert.equal(result.bars[0].close, 110 / 52);
        // Legs are returned so callers (Portfolio Lab) can compute per-leg stats.
        assert.equal(result.base.length, 2);
        assert.equal(result.quote.length, 2);
        assert.equal(result.meta.alignedBars, 2);
        // Source interval should be the finer interval picked for sub-bar build.
        assert.equal(result.sourceInterval, '1m');
    });

    it('returns empty bars and skips throwing when allowEmptyLegs is true and a leg is empty', async () => {
        const fetchLeg = async (symbol: string): Promise<OHLCVData[]> =>
            symbol === 'BASE' ? [bar(0)] : [];

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'BASE',
            quoteSymbol: 'QUOTE',
            interval: '15m',
            targetBars: 1,
            allowEmptyLegs: true,
            fetchLeg,
        });

        assert.equal(result.bars.length, 0);
        assert.equal(result.meta.alignedBars, 0);
        assert.equal(result.base.length, 1);
        assert.equal(result.quote.length, 0);
    });

    it('throws SyntheticQuoteError on empty quote leg when allowEmptyLegs is not set', async () => {
        const fetchLeg = async (symbol: string): Promise<OHLCVData[]> =>
            symbol === 'BASE' ? [bar(0)] : [];

        await assert.rejects(
            () => buildSyntheticPairFromLegs({
                baseSymbol: 'BASE',
                quoteSymbol: 'QUOTE',
                interval: '15m',
                targetBars: 1,
                fetchLeg,
            }),
            SyntheticQuoteError
        );
    });

    it('honors tailSliceBars to trim the output to the most recent N bars', async () => {
        const base = [bar(0), bar(60), bar(120), bar(180)];

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'BASE',
            quoteSymbol: 'QUOTE',
            interval: '1m',
            targetBars: 4,
            tailSliceBars: 2,
            fetchLeg: async () => base, // same shape for both legs is fine for this test
        });

        // fetchLeg ignores which leg; ensure we sliced to last 2 of [0,60,120,180].
        assert.equal(result.bars.length, 2);
        assert.deepEqual(result.bars.map((b) => Number(b.time)), [120, 180]);
    });

    it('disk-aware fallback: retries at target interval when seed fetch comes back empty', async () => {
        // Simulates the AAPL 1d case: subdivision picks a 4h seed (IBKR
        // allowlist excludes 2h), but the symbol has no 4h data on disk —
        // only 1d. The fallback retries both legs at the target interval
        // (1d) and skips aggregation.
        const calls: Array<{ symbol: string; interval: string }> = [];
        const fetchLeg = async (symbol: string, sourceInterval: string): Promise<OHLCVData[]> => {
            calls.push({ symbol, interval: sourceInterval });
            // Only the target interval (1d) returns data; seed (4h) is empty.
            if (sourceInterval === '1d') {
                return [bar(0, { open: 100, close: 110, high: 115, low: 95, volume: 10 })];
            }
            return [];
        };

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'AAPL\u2022',
            quoteSymbol: 'MSFT\u2022',
            interval: '1d',
            targetBars: 1,
            fetchLeg,
        });

        // First call attempts the 4h seed for both legs (IBKR allowlist
        // excludes the crypto-default 2h), then fallback retries at the
        // 1d target interval.
        assert.deepEqual(
            calls.map((c) => `${c.symbol}@${c.interval}`),
            ['AAPL\u2022@4h', 'MSFT\u2022@4h', 'AAPL\u2022@1d', 'MSFT\u2022@1d']
        );
        // Single bar returned, no aggregation (target-interval data is already 1d).
        assert.equal(result.bars.length, 1);
        assert.equal(result.sourceInterval, '1d');
    });

    it('disk-aware fallback: keeps seed data when seed fetch succeeds (no fallback)', async () => {
        // Subdivision succeeds at the seed interval — fallback must NOT fire.
        // This pins the 4H IBKR case (30m seed exists on disk for MU/TSLA).
        const calls: Array<{ symbol: string; interval: string }> = [];
        const fetchLeg = async (symbol: string, sourceInterval: string): Promise<OHLCVData[]> => {
            calls.push({ symbol, interval: sourceInterval });
            if (sourceInterval === '4h') {
                return [
                    bar(0, { open: 100, high: 110, low: 95, close: 105 }),
                    bar(14400, { open: 105, high: 115, low: 100, close: 110 }),
                ];
            }
            return [];
        };

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'AAPL\u2022',
            quoteSymbol: 'MSFT\u2022',
            interval: '1d',
            targetBars: 1,
            fetchLeg,
        });

        // Only the 4h seed was fetched; no fallback to 1d.
        assert.deepEqual(
            calls.map((c) => `${c.symbol}@${c.interval}`),
            ['AAPL\u2022@4h', 'MSFT\u2022@4h']
        );
        // Aggregation ran: two 4h bars -> one 1d bar at time 0.
        assert.equal(result.bars.length, 1);
        assert.equal(Number(result.bars[0].time), 0);
        assert.equal(result.sourceInterval, '4h');
    });

    it('disk-aware fallback: rejects asymmetric fallback when only one leg has target-interval data', async () => {
        // Regression guard: if base succeeds at seed (4h) but quote is empty
        // at BOTH seed and target, the fallback must NOT swap to one leg at
        // 1d and one empty — that would produce asymmetric-resolution bars.
        // The AND guard ensures we keep the original (base@4h, quote=empty)
        // state and let the existing empty-handling path surface the failure.
        const calls: Array<{ symbol: string; interval: string }> = [];
        const fetchLeg = async (symbol: string, sourceInterval: string): Promise<OHLCVData[]> => {
            calls.push({ symbol, interval: sourceInterval });
            if (symbol === 'AAPL\u2022' && sourceInterval === '4h') {
                return [
                    bar(0, { open: 100, high: 110, low: 95, close: 105 }),
                    bar(14400, { open: 105, high: 115, low: 100, close: 110 }),
                ];
            }
            // NEW• has no data at any interval.
            return [];
        };

        // allowEmptyLegs so we can observe the post-fallback state without
        // catching a SyntheticQuoteError.
        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'AAPL\u2022',
            quoteSymbol: 'NEW\u2022',
            interval: '1d',
            targetBars: 1,
            fetchLeg,
            allowEmptyLegs: true,
        });

        // Fallback fired (target-interval fetches attempted) but did NOT swap
        // because NEW•@1d was empty. base retains its 4h seed data, quote is
        // still empty, and bars is empty (alignment intersection is empty).
        assert.deepEqual(
            calls.map((c) => `${c.symbol}@${c.interval}`),
            ['AAPL\u2022@4h', 'NEW\u2022@4h', 'AAPL\u2022@1d', 'NEW\u2022@1d']
        );
        assert.equal(result.bars.length, 0);
        assert.equal(result.base.length, 2);  // retained 4h seed data
        assert.equal(result.quote.length, 0); // still empty
        // sourceInterval reported as '4h' (subdivided stayed true) — the
        // effective resolution of the surviving leg.
        assert.equal(result.sourceInterval, '4h');
    });
});
