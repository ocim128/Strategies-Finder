import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { backtestEndpointPlugin } from './lib/backtest-endpoint-plugin';
import { strategyLibraryAdminPlugin } from './lib/strategy-library-admin-plugin';
import { executionLabVitePlugin } from './lib/execution-lab/execution-lab-vite-plugin';
import { ibkrDataVitePlugin } from './lib/ibkr-data/ibkr-data-vite-plugin';
import { cryptoDataVitePlugin } from './lib/crypto-data/crypto-data-vite-plugin';
import { localSqlitePlugin } from './lib/local-sqlite-vite-plugin';
import { secondMarketApiPlugin } from './lib/second-market-vite-plugin';
import { batchBacktestVitePlugin } from './lib/batch-backtest/batch-backtest-vite-plugin';
import { finderVitePlugin } from './lib/finder/server/finder-vite-plugin';
import { rankPairsVitePlugin } from './lib/rank-pairs/server/rank-pairs-vite-plugin';
import { sendCaughtErrorJson, sendJson, proxyUpstreamJson } from './lib/vite-http-utils';
import { debugLogger } from './lib/debug-logger';
import { configurePolymarketNodeDns } from './lib/polymarket-node-dns';
import { STOCK_MARKET_SYMBOL_SUFFIX } from './lib/local-daily-datasets';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const POLYMARKET_GAMMA_EVENT_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const BYBIT_TRADFI_PROXY_TIMEOUT_MS = 8000;
const POLYMARKET_PROXY_TIMEOUT_MS = 8000;
const APP_ROOT = process.cwd();
const LIGHTWEIGHT_CHARTS_ROOT = resolve(APP_ROOT, '..', '..', '..');
const LIGHTWEIGHT_CHARTS_DIST_DIR = resolve(LIGHTWEIGHT_CHARTS_ROOT, 'dist');
const LIGHTWEIGHT_CHARTS_NODE_MODULES_DIR = resolve(LIGHTWEIGHT_CHARTS_ROOT, 'node_modules');
const INDONESIAN_STOCK_PRICE_DATA_DIR = resolve(APP_ROOT, 'price-data', 'indonesian-stock');
const INDONESIAN_STOCK_CATALOG_CACHE_TTL_MS = 30_000;
const STOCK_MARKET_DATA_DIR = resolve(APP_ROOT, 'price-data', 'stock_market_data');
const STOCK_MARKET_CATALOG_CACHE_TTL_MS = 30_000;
const STOCK_MARKET_DATASETS = ['forbes2000', 'nasdaq', 'nyse', 'sp500'] as const;
const WATCH_STRATEGIES = process.env.WATCH_STRATEGIES === '1';
const WATCH_IGNORED_GLOBS = [
    // Generated artifacts are rewritten in place and can trip Vite's watcher on Windows.
    '**/artifacts/**',
    // Strategy authoring often happens during long Finder/Hunt runs. Require a manual refresh
    // instead of interrupting the current browser session on every change under lib/strategies.
    ...(WATCH_STRATEGIES ? [] : ['**/lib/strategies/**']),
];

configurePolymarketNodeDns('adguard-doh');

type LocalPriceDataCatalogAsset = { symbol: string; name: string };

let indonesianStockCatalogCache: {
    loadedAtMs: number;
    assets: LocalPriceDataCatalogAsset[];
} | null = null;

function parseLimit(raw: string | null): number {
    const parsed = Number(raw || '500');
    if (!Number.isFinite(parsed)) return 500;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function readIndonesianStockCatalog(): LocalPriceDataCatalogAsset[] {
    const now = Date.now();
    if (
        indonesianStockCatalogCache
        && now - indonesianStockCatalogCache.loadedAtMs < INDONESIAN_STOCK_CATALOG_CACHE_TTL_MS
    ) {
        return indonesianStockCatalogCache.assets;
    }

    if (!existsSync(INDONESIAN_STOCK_PRICE_DATA_DIR)) {
        indonesianStockCatalogCache = { loadedAtMs: now, assets: [] };
        return indonesianStockCatalogCache.assets;
    }

    const assets = readdirSync(INDONESIAN_STOCK_PRICE_DATA_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .map((entry) => {
            const symbol = entry.name.slice(0, -4).trim().toUpperCase();
            return symbol !== 'CATALOG' && /^[A-Z0-9._-]+$/.test(symbol)
                ? { symbol, name: symbol }
                : null;
        })
        .filter((entry): entry is { symbol: string; name: string } => entry !== null)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    indonesianStockCatalogCache = { loadedAtMs: now, assets };
    return assets;
}

// Stock Market Data ships 4 exchange subfolders, each with one CSV per
// ticker under csv/. Symbols are returned to the client already marked with
// the diamond suffix so callers never need to know about the convention.
const stockMarketCatalogCache = new Map<string, { loadedAtMs: number; assets: LocalPriceDataCatalogAsset[] }>();

function readStockMarketCatalog(dataset: string): LocalPriceDataCatalogAsset[] {
    const now = Date.now();
    const cached = stockMarketCatalogCache.get(dataset);
    if (cached && now - cached.loadedAtMs < STOCK_MARKET_CATALOG_CACHE_TTL_MS) {
        return cached.assets;
    }

    const datasetDir = resolve(STOCK_MARKET_DATA_DIR, dataset, 'csv');
    if (!existsSync(datasetDir)) {
        const empty: LocalPriceDataCatalogAsset[] = [];
        stockMarketCatalogCache.set(dataset, { loadedAtMs: now, assets: empty });
        return empty;
    }

    const assets = readdirSync(datasetDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .map((entry) => {
            const ticker = entry.name.slice(0, -4).trim().toUpperCase();
            if (!ticker || !/^[A-Z0-9._-]+$/.test(ticker)) return null;
            const symbol = `${ticker}${STOCK_MARKET_SYMBOL_SUFFIX}`;
            return { symbol, name: symbol };
        })
        .filter((entry): entry is { symbol: string; name: string } => entry !== null)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    stockMarketCatalogCache.set(dataset, { loadedAtMs: now, assets });
    return assets;
}

function manualChunks(id: string): string | undefined {
    const normalized = id.replace(/\\/g, '/');
    if (
        normalized.includes('/node_modules/fancy-canvas/')
        || normalized.includes('/dist/lightweight-charts.')
    ) {
        return 'vendor-charts';
    }
    return undefined;
}

function tradFiKlineProxyPlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use('/api/tradfi-kline', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ret_code: 10003, ret_msg: 'Method not allowed' });
                return;
            }

            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const symbol = requestUrl.searchParams.get('symbol');
            const interval = requestUrl.searchParams.get('interval');
            const limit = parseLimit(requestUrl.searchParams.get('limit'));
            const to = requestUrl.searchParams.get('to');

            if (!symbol || !interval) {
                sendJson(res, 400, { ret_code: 10001, ret_msg: 'symbol and interval are required' });
                return;
            }

            const upstreamParams = new URLSearchParams({
                timeStamp: Date.now().toString(),
                symbol,
                interval,
                limit: limit.toString(),
            });
            if (to) {
                upstreamParams.set('to', to);
            }

            await proxyUpstreamJson(
                res,
                `${BYBIT_TRADFI_KLINE_URL}?${upstreamParams.toString()}`,
                BYBIT_TRADFI_PROXY_TIMEOUT_MS,
                'tradfi-kline',
                {
                    onTimeout: () => sendJson(res, 504, {
                        ret_code: 10002,
                        ret_msg: 'TradFi proxy request timed out',
                    }),
                    onError: () => sendJson(res, 500, {
                        ret_code: 10002,
                        ret_msg: 'TradFi proxy request failed',
                    }),
                },
                debugLogger
            );
        });
    };

    return {
        name: 'tradfi-kline-proxy',
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

function polymarketProxyPlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use('/api/polymarket-event', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const slug = (requestUrl.searchParams.get('slug') || '').trim().toLowerCase();
            if (!slug) {
                sendJson(res, 400, { ok: false, error: 'slug is required' });
                return;
            }

            await proxyUpstreamJson(
                res,
                `${POLYMARKET_GAMMA_EVENT_SLUG_URL}/${encodeURIComponent(slug)}`,
                POLYMARKET_PROXY_TIMEOUT_MS,
                'polymarket-event',
                {
                    onTimeout: () => sendJson(res, 504, {
                        ok: false,
                        error: 'Polymarket event proxy request timed out',
                    }),
                    onError: () => sendJson(res, 500, {
                        ok: false,
                        error: 'Polymarket event proxy request failed',
                    }),
                },
                debugLogger
            );
        });

        middlewares.use('/api/polymarket-history', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const market = (requestUrl.searchParams.get('market') || '').trim();
            const interval = (requestUrl.searchParams.get('interval') || '').trim();
            const startTs = (requestUrl.searchParams.get('startTs') || '').trim();
            const endTs = (requestUrl.searchParams.get('endTs') || '').trim();
            const fidelity = (requestUrl.searchParams.get('fidelity') || '').trim();

            if (!market) {
                sendJson(res, 400, { ok: false, error: 'market is required' });
                return;
            }

            const upstreamParams = new URLSearchParams({ market });
            if (interval) upstreamParams.set('interval', interval);
            if (startTs) upstreamParams.set('startTs', startTs);
            if (endTs) upstreamParams.set('endTs', endTs);
            if (fidelity) upstreamParams.set('fidelity', fidelity);

            await proxyUpstreamJson(
                res,
                `${POLYMARKET_CLOB_HISTORY_URL}?${upstreamParams.toString()}`,
                POLYMARKET_PROXY_TIMEOUT_MS,
                'polymarket-history',
                {
                    onTimeout: () => sendJson(res, 504, {
                        ok: false,
                        error: 'Polymarket history proxy request timed out',
                    }),
                    onError: () => sendJson(res, 500, {
                        ok: false,
                        error: 'Polymarket history proxy request failed',
                    }),
                },
                debugLogger
            );
        });
    };

    return {
        name: 'polymarket-proxy',
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

function localPriceDataCatalogPlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use('/api/local-price-data/indonesian-stock/catalog', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            try {
                const assets = readIndonesianStockCatalog();
                sendJson(res, 200, {
                    ok: true,
                    dataset: 'indonesian-stock',
                    count: assets.length,
                    assets,
                });
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use('/api/local-price-data/stock-market/catalog', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            try {
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const datasetParam = (requestUrl.searchParams.get('dataset') || '').trim().toLowerCase();
                const datasets = STOCK_MARKET_DATASETS.filter((d) => !datasetParam || d === datasetParam);
                if (datasetParam && datasets.length === 0) {
                    sendJson(res, 400, { ok: false, error: `Unknown dataset: ${datasetParam}` });
                    return;
                }

                const bySymbol = new Map<string, LocalPriceDataCatalogAsset>();
                for (const dataset of datasets) {
                    for (const asset of readStockMarketCatalog(dataset)) {
                        if (!bySymbol.has(asset.symbol)) {
                            bySymbol.set(asset.symbol, asset);
                        }
                    }
                }
                const assets = Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
                sendJson(res, 200, {
                    ok: true,
                    dataset: datasetParam || 'stock-market',
                    count: assets.length,
                    assets,
                });
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });
    };

    return {
        name: 'local-price-data-catalog',
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

export default defineConfig({
    plugins: [
        tradFiKlineProxyPlugin(),
        polymarketProxyPlugin(),
        ibkrDataVitePlugin(),
        cryptoDataVitePlugin(),
        localPriceDataCatalogPlugin(),
        secondMarketApiPlugin(),
        executionLabVitePlugin(),
        localSqlitePlugin(),
        strategyLibraryAdminPlugin(),
        backtestEndpointPlugin(),
        batchBacktestVitePlugin(),
        finderVitePlugin(),
        rankPairsVitePlugin(),
    ],
    server: {
        fs: {
            allow: [
                APP_ROOT,
                LIGHTWEIGHT_CHARTS_DIST_DIR,
                LIGHTWEIGHT_CHARTS_NODE_MODULES_DIR,
            ],
        },
        watch: {
            ignored: WATCH_IGNORED_GLOBS,
        },
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks,
            },
        },
    },
});
