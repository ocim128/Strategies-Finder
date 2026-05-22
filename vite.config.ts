import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { backtestEndpointPlugin } from './lib/backtest-endpoint-plugin';
import { strategyLibraryAdminPlugin } from './lib/strategy-library-admin-plugin';
import { strategyLibraryAuditPlugin } from './lib/strategy-library-audit-plugin';
import { executionLabVitePlugin } from './lib/execution-lab/execution-lab-vite-plugin';
import { localSqlitePlugin } from './lib/local-sqlite-vite-plugin';
import { secondMarketApiPlugin } from './lib/second-market-vite-plugin';
import { sendCaughtErrorJson, sendJson } from './lib/vite-http-utils';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const POLYMARKET_GAMMA_EVENT_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const POLYMARKET_PROXY_TIMEOUT_MS = 8000;
const INDONESIAN_STOCK_PRICE_DATA_DIR = resolve(process.cwd(), 'price-data', 'indonesian-stock');
const WATCH_STRATEGIES = process.env.WATCH_STRATEGIES === '1';
const WATCH_IGNORED_GLOBS = [
    // Generated artifacts are rewritten in place and can trip Vite's watcher on Windows.
    '**/artifacts/**',
    // Strategy authoring often happens during long Finder/Hunt runs. Require a manual refresh
    // instead of interrupting the current browser session on every change under lib/strategies.
    ...(WATCH_STRATEGIES ? [] : ['**/lib/strategies/**']),
];

function parseLimit(raw: string | null): number {
    const parsed = Number(raw || '500');
    if (!Number.isFinite(parsed)) return 500;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function readIndonesianStockCatalog(): Array<{ symbol: string; name: string }> {
    return readdirSync(INDONESIAN_STOCK_PRICE_DATA_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .map((entry) => {
            const symbol = entry.name.slice(0, -4).trim().toUpperCase();
            return symbol !== 'CATALOG' && /^[A-Z0-9._-]+$/.test(symbol)
                ? { symbol, name: symbol }
                : null;
        })
        .filter((entry): entry is { symbol: string; name: string } => entry !== null)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function createPolymarketProxyTimeoutSignal(): AbortSignal | undefined {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(POLYMARKET_PROXY_TIMEOUT_MS)
        : undefined;
}

function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function tradFiKlineProxyPlugin(): Plugin {
    return {
        name: 'tradfi-kline-proxy',
        configureServer(server) {
            server.middlewares.use('/api/tradfi-kline', async (req, res) => {
                if (req.method !== 'GET') {
                    sendJson(res, 405, { ret_code: 10003, ret_msg: 'Method not allowed' });
                    return;
                }

                try {
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

                    const upstream = await fetch(`${BYBIT_TRADFI_KLINE_URL}?${upstreamParams.toString()}`, {
                        headers: { Accept: 'application/json' },
                    });

                    const body = await upstream.text();
                    res.statusCode = upstream.status;
                    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(body);
                } catch {
                    sendJson(res, 500, { ret_code: 10002, ret_msg: 'TradFi proxy request failed' });
                }
            });
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

            try {
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const slug = (requestUrl.searchParams.get('slug') || '').trim().toLowerCase();
                if (!slug) {
                    sendJson(res, 400, { ok: false, error: 'slug is required' });
                    return;
                }

                const upstream = await fetch(`${POLYMARKET_GAMMA_EVENT_SLUG_URL}/${encodeURIComponent(slug)}`, {
                    headers: { Accept: 'application/json' },
                    signal: createPolymarketProxyTimeoutSignal(),
                });
                const body = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                res.end(body);
            } catch (error) {
                const timedOut = isAbortLikeError(error);
                sendJson(res, timedOut ? 504 : 500, {
                    ok: false,
                    error: timedOut
                        ? 'Polymarket event proxy request timed out'
                        : 'Polymarket event proxy request failed',
                });
            }
        });

        middlewares.use('/api/polymarket-history', async (req: any, res: any) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            try {
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

                const upstream = await fetch(`${POLYMARKET_CLOB_HISTORY_URL}?${upstreamParams.toString()}`, {
                    headers: { Accept: 'application/json' },
                    signal: createPolymarketProxyTimeoutSignal(),
                });
                const body = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                res.end(body);
            } catch (error) {
                const timedOut = isAbortLikeError(error);
                sendJson(res, timedOut ? 504 : 500, {
                    ok: false,
                    error: timedOut
                        ? 'Polymarket history proxy request timed out'
                        : 'Polymarket history proxy request failed',
                });
            }
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
        localPriceDataCatalogPlugin(),
        secondMarketApiPlugin(),
        executionLabVitePlugin(),
        localSqlitePlugin(),
        strategyLibraryAuditPlugin(),
        strategyLibraryAdminPlugin(),
        backtestEndpointPlugin(),
    ],
    server: {
        fs: {
            allow: ['../../..']
        },
        watch: {
            ignored: WATCH_IGNORED_GLOBS,
        },
    }
});
