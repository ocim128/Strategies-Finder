import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { findAlpacaRefreshSymbols, getAlpacaMetadataRefreshReason } from '../lib/ibkr-data/alpaca-refresh-symbols';
import { resolveAlpacaPriceSettings } from '../lib/ibkr-data/alpaca-fetcher';
import { ibkrDataVitePlugin } from '../lib/ibkr-data/ibkr-data-vite-plugin';
import type { IbkrIntervalMeta } from '../lib/ibkr-data/ibkr-data-stream-types';

const settings = { feed: 'iex', adjustment: 'split' };
const healthy: IbkrIntervalMeta = {
    source: 'alpaca', bars: 100, firstTime: null, lastTime: null, lastSyncAt: '',
    alpacaFeed: 'iex', alpacaAdjustment: 'split', splitAdjustedThrough: '2026-10-01',
};
const legacy = { ...healthy, alpacaFeed: undefined, alpacaAdjustment: undefined, splitAdjustedThrough: undefined };

describe('Alpaca metadata refresh list', () => {
    it('finds LOVE/LPCN-style legacy entries, deduplicates symbols, and excludes unrelated histories', () => {
        const entries = [
            { symbol: 'LOVE', intervals: { '30m': legacy } },
            { symbol: 'lpcn\u2022', intervals: { '30m': legacy } },
            { symbol: 'LOVE\u2022', intervals: { '30m': legacy } },
            { symbol: 'HEALTHY', intervals: { '30m': healthy } },
            { symbol: 'IBKR', intervals: { '30m': { ...legacy, source: 'ibkr' as const } } },
            { symbol: 'UNKNOWN', intervals: { '30m': { ...legacy, source: undefined } } },
            { symbol: 'EMPTY', intervals: { '30m': { ...legacy, bars: 0 } } },
            { symbol: 'DAILY', intervals: { '1d': legacy } },
        ];
        assert.deepEqual(findAlpacaRefreshSymbols(entries, '30m', settings), [
            { symbol: 'LOVE', reason: 'missing_adjustment_history' },
            { symbol: 'LPCN', reason: 'missing_adjustment_history' },
        ]);
        assert.deepEqual(findAlpacaRefreshSymbols(entries, '1d', settings), [
            { symbol: 'DAILY', reason: 'missing_adjustment_history' },
        ]);
    });

    it('flags changed feed/adjustment and mixed Alpaca data', () => {
        assert.equal(getAlpacaMetadataRefreshReason({ ...healthy, alpacaFeed: 'sip' }, settings), 'price_settings_changed');
        assert.equal(getAlpacaMetadataRefreshReason({ ...healthy, alpacaAdjustment: 'all' }, settings), 'price_settings_changed');
        assert.equal(getAlpacaMetadataRefreshReason({ ...legacy, source: 'mixed' }, settings), 'missing_adjustment_history');
        assert.equal(getAlpacaMetadataRefreshReason({ ...legacy, bars: 0 }, settings), 'missing_adjustment_history', 'merge guard must not trust a stale catalog bar count');
    });

    it('does not flag split metadata when split adjustment is disabled', () => {
        assert.equal(getAlpacaMetadataRefreshReason(legacy, { ...settings, adjustment: 'raw' }), null);
        assert.equal(getAlpacaMetadataRefreshReason(legacy, { ...settings, adjustment: 'dividend' }), null);
        assert.equal(getAlpacaMetadataRefreshReason(legacy, { ...settings, adjustment: 'split,dividend' }), 'missing_adjustment_history');
    });

    it('reads only public settings and needs no credentials', () => {
        assert.deepEqual(resolveAlpacaPriceSettings({}), settings);
        assert.deepEqual(resolveAlpacaPriceSettings({ ALPACA_FEED: ' sip ', ALPACA_ADJUSTMENT: ' all ', ALPACA_API_KEY: 'secret' }), { feed: 'sip', adjustment: 'all' });
    });
});

describe('Alpaca refresh-list route', () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.LOCAL_PROXY_TOKEN;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.LOCAL_PROXY_TOKEN;
        else process.env.LOCAL_PROXY_TOKEN = originalToken;
    });

    async function request(method: string, interval: string, remoteAddress = '127.0.0.1') {
        let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw new Error('route missing'); };
        const plugin = ibkrDataVitePlugin();
        const register = plugin.configureServer as (server: unknown) => void;
        register({ middlewares: { use: (path: string, callback: typeof handler) => {
            if (path === '/api/ibkr/alpaca-refresh-symbols') handler = callback;
        } } });
        let body = '';
        const res = { statusCode: 0, setHeader: () => {}, end: (value: string) => { body = value; } };
        await handler({ method, url: `/?interval=${interval}`, socket: { remoteAddress }, headers: { host: 'localhost:5173' } }, res);
        return { status: res.statusCode, body, json: JSON.parse(body) as Record<string, unknown> };
    }

    it('returns catalog candidates without any remote price/split requests', async () => {
        globalThis.fetch = async () => { throw new Error('refresh-list scan must not call a provider'); };
        const result = await request('GET', '30m');
        assert.equal(result.status, 200);
        assert.equal(result.json.interval, '30m');
        assert.ok(Array.isArray(result.json.candidates));
        assert.doesNotMatch(result.body, /apiKey|apiSecret|APCA-API/i);
    });

    it('rejects unsupported intervals, methods, and unauthenticated remote callers', async () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        assert.equal((await request('GET', '4h')).status, 400);
        assert.equal((await request('POST', '30m')).status, 405);
        assert.equal((await request('GET', '30m', '192.0.2.1')).status, 401);
    });
});
