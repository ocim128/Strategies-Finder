import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assetSearchService } from '../lib/asset-search-service';
import { clearLocalDailyAssetCaches } from '../lib/local-daily-datasets';

const originalFetch = globalThis.fetch;
beforeEach(() => {
    clearLocalDailyAssetCaches();
    globalThis.fetch = async input => {
        const url = String(input);
        if (url === '/api/local-price-data/ibkr/catalog') {
            return Response.json({ assets: [
                { symbol: 'AAPL', name: 'Apple' }, { symbol: 'NVDA', name: 'Nvidia' },
            ] });
        }
        if (url.includes('exchangeInfo')) {
            return Response.json({ symbols: ['BTC', 'ETH'].map(baseAsset => ({
                symbol: `${baseAsset}USDT`, status: 'TRADING', baseAsset, quoteAsset: 'USDT',
            })) });
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };
});
afterEach(() => { globalThis.fetch = originalFetch; clearLocalDailyAssetCaches(); });

describe('Asset search synthetic pairs', () => {
    it('returns an exact IBKR ratio with both bullet markers preserved', async () => {
        assert.deepEqual(await assetSearchService.searchAssets('AAPL•+NVDA•', 20), [{
            symbol: 'AAPL•+NVDA•', displayName: 'AAPL• / NVDA•', type: 'stock',
            provider: 'ibkr-local', baseAsset: 'AAPL•', quoteAsset: 'NVDA•',
        }]);
    });

    it('normalizes case, spaces, and a bare stock leg beside an IBKR leg', async () => {
        const [pair] = await assetSearchService.searchAssets(' aapl• + nvda ', 20);
        assert.equal(pair?.symbol, 'AAPL•+NVDA•');
        assert.equal(pair?.provider, 'ibkr-local');
    });

    it('resolves crypto shorthand using the selected Binance market', async () => {
        for (const binanceMarketType of ['spot', 'futures'] as const) {
            const [pair] = await assetSearchService.searchAssets('btc+eth', 20, { binanceMarketType });
            assert.equal(pair?.symbol, 'BTCUSDT+ETHUSDT');
            assert.equal(pair?.provider, binanceMarketType === 'spot' ? 'binance' : 'binance-futures');
        }
    });

    it('does not offer incomplete, invalid, identical, or unknown legs', async () => {
        for (const query of ['AAPL•+', '+NVDA•', 'AAPL•+NVDA•+BTC', 'AAPL•+<NVDA>', 'AAPL•+AAPL•', 'AAPL•+UNKNOWN•']) {
            assert.deepEqual(await assetSearchService.searchAssets(query, 20), [], query);
        }
    });

    it('keeps single-stock and native TradFi plus symbols searchable', async () => {
        const [stock] = await assetSearchService.searchAssets('AAPL•', 20);
        assert.equal(stock?.symbol, 'AAPL•');
        const results = await assetSearchService.searchAssets('EURUSD+', 20);
        assert.ok(results.some(asset => asset.symbol === 'EURUSD+' && asset.provider === 'bybit-tradfi'));
    });
});
