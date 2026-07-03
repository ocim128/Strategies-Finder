import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isStockMarketDatasetKey,
    isIbkrSymbol,
    isMarkedLocalStockSymbol,
    isStockMarketSymbol,
    markIbkrSymbol,
    markStockSymbol,
    stripIbkrMarker,
    stripMarkedLocalStockSymbol,
    stripStockMarketMarker,
} from '../lib/local-daily-datasets';
import {
    extractCandlesFromStockMarketCsvPayload,
    parseStockMarketCsvDate,
} from '../lib/candle-cache';
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
} from '../scripts/lib/synthetic-pair';
import { parseSyntheticPairToken } from '../lib/finder-manager';
import { parsePortfolioSyntheticPairSymbol } from '../lib/portfolioLab/portfolio-lab-synthetic';
import type { OHLCVData } from '../lib/types/strategies';

describe('stock-market diamond marker helpers', () => {
    it('marks a bare ticker and is idempotent', () => {
        assert.equal(markStockSymbol('AAPL'), 'AAPL\u2666');
        assert.equal(markStockSymbol('aapl'), 'AAPL\u2666');
        assert.equal(markStockSymbol('AAPL\u2666'), 'AAPL\u2666');
    });

    it('detects marked symbols and ignores bare ones', () => {
        assert.equal(isStockMarketSymbol('AAPL\u2666'), true);
        assert.equal(isStockMarketSymbol('AAPL'), false);
        assert.equal(isStockMarketSymbol('  AAPL\u2666  '), true);
    });

    it('strips the marker and uppercases', () => {
        assert.equal(stripStockMarketMarker('AAPL\u2666'), 'AAPL');
        assert.equal(stripStockMarketMarker('aapl\u2666'), 'AAPL');
        // Bare symbol passes through uppercased.
        assert.equal(stripStockMarketMarker('aapl'), 'AAPL');
    });

    it('flags only the four stock-market dataset keys', () => {
        assert.equal(isStockMarketDatasetKey('forbes2000-stock'), true);
        assert.equal(isStockMarketDatasetKey('nasdaq-stock'), true);
        assert.equal(isStockMarketDatasetKey('nyse-stock'), true);
        assert.equal(isStockMarketDatasetKey('sp500-stock'), true);
        // The existing CSV-backed sp500 dataset must NOT be treated as
        // stock-market — that would break the ISO-date CSV path.
        assert.equal(isStockMarketDatasetKey('sp500'), false);
        assert.equal(isStockMarketDatasetKey('indonesian-stock'), false);
    });
});

describe('ibkr bullet marker helpers', () => {
    it('marks a bare ticker and is idempotent', () => {
        assert.equal(markIbkrSymbol('NVDA'), 'NVDA\u2022');
        assert.equal(markIbkrSymbol('nvda'), 'NVDA\u2022');
        assert.equal(markIbkrSymbol('NVDA\u2022'), 'NVDA\u2022');
    });

    it('detects and strips bullet-marked symbols without changing diamond behavior', () => {
        assert.equal(isIbkrSymbol('NVDA\u2022'), true);
        assert.equal(isIbkrSymbol('NVDA\u2666'), false);
        assert.equal(stripIbkrMarker('nvda\u2022'), 'NVDA');
        assert.equal(isMarkedLocalStockSymbol('NVDA\u2022'), true);
        assert.equal(isMarkedLocalStockSymbol('NVDA\u2666'), true);
        assert.equal(stripMarkedLocalStockSymbol('nvda\u2022'), 'NVDA');
        assert.equal(stripMarkedLocalStockSymbol('nvda\u2666'), 'NVDA');
    });
});

describe('parseStockMarketCsvDate (DD-MM-YYYY)', () => {
    it('parses unambiguous day-first dates', () => {
        // 15-12-1980 = Dec 15 1980 — would be rejected by MM-DD-YYYY Date.parse.
        assert.equal(
            parseStockMarketCsvDate('15-12-1980'),
            Math.floor(Date.UTC(1980, 11, 15) / 1000),
        );
        assert.equal(
            parseStockMarketCsvDate('31-01-2023'),
            Math.floor(Date.UTC(2023, 0, 31) / 1000),
        );
    });

    it('parses ambiguous day/month consistently as day-first', () => {
        // 12-12-1980 is ambiguous; assert it is Dec 12 (day=month, no
        // observable difference) but more importantly stays day-first.
        const expected = Math.floor(Date.UTC(1980, 11, 12) / 1000);
        assert.equal(parseStockMarketCsvDate('12-12-1980'), expected);
        // 02-05-2021 = May 2 2021 under DD-MM, NOT Feb 5 under MM-DD.
        assert.equal(
            parseStockMarketCsvDate('02-05-2021'),
            Math.floor(Date.UTC(2021, 4, 2) / 1000),
        );
    });

    it('rejects out-of-range day/month and wrong shapes', () => {
        assert.equal(parseStockMarketCsvDate('32-13-1980'), null);
        assert.equal(parseStockMarketCsvDate('31-13-1980'), null);
        assert.equal(parseStockMarketCsvDate('00-01-1980'), null);
        assert.equal(parseStockMarketCsvDate('1980-12-15'), null);
        assert.equal(parseStockMarketCsvDate(''), null);
        assert.equal(parseStockMarketCsvDate('not-a-date'), null);
    });
});

describe('extractCandlesFromStockMarketCsvPayload', () => {
    const CSV_HEADER = 'Date,Low,Open,Volume,High,Close,Adjusted Close';

    it('parses Yahoo column order with unadjusted OHLC', () => {
        const payload = [
            CSV_HEADER,
            // DD-MM-YYYY, low, open, vol, high, close, adj-close
            '15-12-1980,0.12,0.13,469033600,0.129,0.128,0.099',
            '16-12-1980,0.112,0.113,105728000,0.113,0.112,0.087',
        ].join('\n');
        const candles = extractCandlesFromStockMarketCsvPayload(payload);
        assert.equal(candles.length, 2);
        // Open comes from column 3 (not adjusted close).
        assert.equal(candles[0].open, 0.13);
        assert.equal(candles[0].close, 0.128);
        assert.equal(candles[0].volume, 469033600);
        assert.equal(
            Number(candles[0].time),
            Math.floor(Date.UTC(1980, 11, 15) / 1000),
        );
        // Sorted ascending.
        assert.ok(Number(candles[0].time) < Number(candles[1].time));
    });

    it('drops rows with invalid dates instead of misinterpreting them', () => {
        const payload = [
            CSV_HEADER,
            '15-12-1980,0.12,0.13,1,0.129,0.128,0.099',
            'not-a-date,0.12,0.13,1,0.129,0.128,0.099',
            '16-12-1980,0.112,0.113,1,0.113,0.112,0.087',
        ].join('\n');
        const candles = extractCandlesFromStockMarketCsvPayload(payload);
        assert.equal(candles.length, 2);
        assert.equal(
            Number(candles[0].time),
            Math.floor(Date.UTC(1980, 11, 15) / 1000),
        );
    });

    it('returns empty when required OHLC columns are missing', () => {
        const payload = 'Date,Volume\n15-12-1980,1000';
        const candles = extractCandlesFromStockMarketCsvPayload(payload);
        assert.deepEqual(candles, []);
    });
});

describe('deriveSyntheticSymbol with stock-market legs', () => {
    it('joins marked legs with a plus instead of stripping the shared marker', () => {
        assert.equal(
            deriveSyntheticSymbol('NVDA\u2666', 'AAPL\u2666'),
            'NVDA\u2666+AAPL\u2666',
        );
    });

    it('joins when only one leg carries the marker', () => {
        assert.equal(
            deriveSyntheticSymbol('NVDA\u2666', 'MSFT'),
            'NVDA\u2666+MSFT',
        );
    });

    it('joins IBKR bullet-marked legs with a plus', () => {
        assert.equal(
            deriveSyntheticSymbol('NVDA\u2022', 'AAPL\u2022'),
            'NVDA\u2022+AAPL\u2022',
        );
    });

    it('preserves the legacy common-suffix collapse for unmarked crypto legs', () => {
        // Regression guard: BNBUSDT + PAXGUSDT must still collapse to BNBPAXG.
        assert.equal(deriveSyntheticSymbol('BNBUSDT', 'PAXGUSDT'), 'BNBPAXG');
    });

    it('preserves the plain concat fallback for unmarked legs with no common suffix', () => {
        assert.equal(deriveSyntheticSymbol('AAPL', 'MSFT'), 'AAPLMSFT');
    });
});

describe('synthetic pair token parsing preserves marked legs', () => {
    // Regression: parseSyntheticPairToken previously appended `USDT` to every
    // bare leg, so `SMMYY♦+OC♦` became `SMMYY♦USDT+OCUSDT`, the marker no
    // longer self-resolved to local-daily, and the Finder fetched from Binance.
    it('keeps both marked legs intact instead of appending USDT', () => {
        const parsed = parseSyntheticPairToken('SMMYY\u2666+OC\u2666');
        assert.deepEqual(parsed, {
            baseSymbol: 'SMMYY\u2666',
            quoteSymbol: 'OC\u2666',
        });
    });

    it('keeps a marked leg intact when paired with an unmarked Binance leg', () => {
        const parsed = parseSyntheticPairToken('AAPL\u2666+BTCUSDT');
        assert.deepEqual(parsed, {
            baseSymbol: 'AAPL\u2666',
            quoteSymbol: 'BTCUSDT',
        });
    });

    it('keeps IBKR bullet-marked legs intact instead of appending USDT', () => {
        const parsed = parseSyntheticPairToken('NVDA\u2022+AAPL\u2022');
        assert.deepEqual(parsed, {
            baseSymbol: 'NVDA\u2022',
            quoteSymbol: 'AAPL\u2022',
        });
    });

    it('still resolves unmarked bare tokens to Binance symbols', () => {
        const parsed = parseSyntheticPairToken('BNB+PAXG');
        assert.deepEqual(parsed, {
            baseSymbol: 'BNBUSDT',
            quoteSymbol: 'PAXGUSDT',
        });
    });

    it('returns null for malformed tokens', () => {
        assert.equal(parseSyntheticPairToken('+OC'), null);
        assert.equal(parseSyntheticPairToken('OC+'), null);
        assert.equal(parseSyntheticPairToken('OC'), null);
    });
});

describe('portfolio synthetic pair parser preserves marked legs', () => {
    // Regression: portfolio-lab had its own resolveToBinanceSymbol that
    // stripped non-alphanumerics, deleting the marker entirely.
    it('keeps marked legs intact and exposes the bare ticker as baseAsset', () => {
        const parsed = parsePortfolioSyntheticPairSymbol('NVDA\u2666+AAPL\u2666');
        assert.equal(parsed?.baseSymbol, 'NVDA\u2666');
        assert.equal(parsed?.quoteSymbol, 'AAPL\u2666');
        assert.equal(parsed?.baseAsset, 'NVDA');
        assert.equal(parsed?.quoteAsset, 'AAPL');
        assert.equal(parsed?.syntheticSymbol, 'NVDA\u2666+AAPL\u2666');
    });

    it('still resolves unmarked legs through the legacy Binance path', () => {
        const parsed = parsePortfolioSyntheticPairSymbol('BNBUSDT+PAXGUSDT');
        assert.equal(parsed?.baseSymbol, 'BNBUSDT');
        assert.equal(parsed?.quoteSymbol, 'PAXGUSDT');
        assert.equal(parsed?.baseAsset, 'BNB');
    });

    it('keeps IBKR bullet-marked legs intact and exposes bare assets', () => {
        const parsed = parsePortfolioSyntheticPairSymbol('NVDA\u2022+AAPL\u2022');
        assert.equal(parsed?.baseSymbol, 'NVDA\u2022');
        assert.equal(parsed?.quoteSymbol, 'AAPL\u2022');
        assert.equal(parsed?.baseAsset, 'NVDA');
        assert.equal(parsed?.quoteAsset, 'AAPL');
        assert.equal(parsed?.syntheticSymbol, 'NVDA\u2022+AAPL\u2022');
    });
});

describe('resolveEffectiveIntervalForSynthetic', () => {
    // Regression: stock_market_data only has `1d` bars. Without coercion a
    // Finder run at `1h` returned empty for every marked pair, producing
    // "No universe symbols could be loaded".
    it('coerces to 1d when a marked symbol is the lookup target', () => {
        assert.equal(resolveEffectiveIntervalForSynthetic('AAPL\u2666', null, null, '1h'), '1d');
        assert.equal(resolveEffectiveIntervalForSynthetic('AAPL\u2666', null, null, '15m'), '1d');
    });

    it('coerces to 1d when either synthetic leg is marked', () => {
        assert.equal(
            resolveEffectiveIntervalForSynthetic('SCBFF\u2666+EONGY\u2666', 'SCBFF\u2666', 'EONGY\u2666', '1h'),
            '1d',
        );
        // Mixed pair: one Binance leg + one marked leg still coerces.
        assert.equal(
            resolveEffectiveIntervalForSynthetic('BTCUSDT+AAPL\u2666', 'BTCUSDT', 'AAPL\u2666', '1h'),
            '1d',
        );
    });

    it('leaves the interval untouched when no marked symbol or leg is involved', () => {
        assert.equal(
            resolveEffectiveIntervalForSynthetic('BNBUSDT+PAXGUSDT', 'BNBUSDT', 'PAXGUSDT', '1h'),
            '1h',
        );
        assert.equal(resolveEffectiveIntervalForSynthetic('BTCUSDT', null, null, '15m'), '15m');
    });

    it('does not coerce IBKR bullet symbols to 1d', () => {
        assert.equal(resolveEffectiveIntervalForSynthetic('NVDA\u2022', null, null, '1h'), '1h');
        assert.equal(
            resolveEffectiveIntervalForSynthetic('NVDA\u2022+AAPL\u2022', 'NVDA\u2022', 'AAPL\u2022', '15m'),
            '15m',
        );
    });

    it('keeps 1d as 1d (idempotent for daily Finder runs)', () => {
        assert.equal(
            resolveEffectiveIntervalForSynthetic('AAPL\u2666', null, null, '1d'),
            '1d',
        );
    });
});

describe('buildSyntheticPairFromLegs skips source subdivision for marked legs', () => {
    // Regression: pickSourceInterval('1d') returns '2h', so a daily synthetic
    // pair fetched legs at 2h. Stock-market data has no 2h bars, so the quote
    // leg returned empty and every pair failed with "Quote bars must contain
    // at least one aligned candle."
    it('fetches marked legs at the target interval (no 2h subdivision)', async () => {
        const requestedIntervals: Array<{ symbol: string; interval: string }> = [];
        const fetchLeg = async (symbol: string, interval: string, _bars: number): Promise<OHLCVData[]> => {
            requestedIntervals.push({ symbol, interval });
            // Return one bar at 1d; only honored when interval is '1d'.
            if (interval !== '1d') return [];
            const day = Math.floor(Date.UTC(2020, 0, 2) / 1000);
            return [
                { time: day as OHLCVData['time'], open: 100, high: 110, low: 90, close: 105, volume: 1 },
                { time: (day + 86400) as OHLCVData['time'], open: 105, high: 115, low: 100, close: 110, volume: 1 },
            ];
        };

        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'AAPL\u2666',
            quoteSymbol: 'MSFT\u2666',
            interval: '1d',
            targetBars: 1000,
            fetchLeg,
        });

        // Both legs requested at the target interval (1d), not at 2h.
        assert.deepEqual(
            requestedIntervals.map((r) => r.interval),
            ['1d', '1d'],
        );
        // Synthetic bars produced.
        assert.ok(result.bars.length > 0, `expected bars, got ${result.bars.length}`);
    });

    it('still uses source subdivision for unmarked Binance legs', async () => {
        // Sanity guard: the source-subdivision path must still fire for crypto.
        // pickSourceInterval('1d') => 2h with ratio 12.
        const requestedIntervals: string[] = [];
        const fetchLeg = async (_symbol: string, interval: string, _bars: number): Promise<OHLCVData[]> => {
            requestedIntervals.push(interval);
            return [];
        };

        await buildSyntheticPairFromLegs({
            baseSymbol: 'BTCUSDT',
            quoteSymbol: 'ETHUSDT',
            interval: '1d',
            targetBars: 1000,
            fetchLeg,
            allowEmptyLegs: true,
        });

        assert.deepEqual(requestedIntervals, ['2h', '2h']);
    });
});
