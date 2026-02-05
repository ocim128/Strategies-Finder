import { defineConfig, type Plugin } from 'vite';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';

function parseLimit(raw: string | null): number {
    const parsed = Number(raw || '200');
    if (!Number.isFinite(parsed)) return 200;
    return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function tradFiKlineProxyPlugin(): Plugin {
    return {
        name: 'tradfi-kline-proxy',
        configureServer(server) {
            server.middlewares.use('/api/tradfi-kline', async (req, res) => {
                if (req.method !== 'GET') {
                    res.statusCode = 405;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ret_code: 10003, ret_msg: 'Method not allowed' }));
                    return;
                }

                try {
                    const requestUrl = new URL(req.url || '/', 'http://localhost');
                    const symbol = requestUrl.searchParams.get('symbol');
                    const interval = requestUrl.searchParams.get('interval');
                    const limit = parseLimit(requestUrl.searchParams.get('limit'));
                    const to = requestUrl.searchParams.get('to');

                    if (!symbol || !interval) {
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ret_code: 10001, ret_msg: 'symbol and interval are required' }));
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
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ret_code: 10002, ret_msg: 'TradFi proxy request failed' }));
                }
            });
        },
    };
}

export default defineConfig({
    plugins: [tradFiKlineProxyPlugin()],
    server: {
        fs: {
            // Allow serving files from the project root
            allow: ['../../..']
        }
    }
});
