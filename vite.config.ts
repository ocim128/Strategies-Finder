import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { backtestEndpointPlugin } from './lib/backtest-endpoint-plugin';
import { strategyLibraryAdminPlugin } from './lib/strategy-library-admin-plugin';
import { ibkrDataVitePlugin } from './lib/ibkr-data/ibkr-data-vite-plugin';
import { cryptoDataVitePlugin } from './lib/crypto-data/crypto-data-vite-plugin';
import { localSqlitePlugin } from './lib/local-sqlite-vite-plugin';
import { batchBacktestVitePlugin, createBatchOwnerLocksAdapter } from './lib/batch-backtest/batch-backtest-vite-plugin';
import { assetOpportunityExplorerVitePlugin } from './lib/asset-opportunity-explorer/server-vite-plugin';
import { finderVitePlugin } from './lib/finder/server/finder-vite-plugin';
import { monteCarloUniverseVitePlugin } from './lib/monte-carlo/universe/server';
import { rankPairsVitePlugin } from './lib/rank-pairs/server/rank-pairs-vite-plugin';
import { sendJson, proxyUpstreamJson } from './lib/vite-http-utils';
import { debugLogger } from './lib/debug-logger';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const BYBIT_TRADFI_PROXY_TIMEOUT_MS = 8000;
const APP_ROOT = process.cwd();
const LIGHTWEIGHT_CHARTS_ROOT = resolve(APP_ROOT, '..', '..', '..');
const LIGHTWEIGHT_CHARTS_DIST_DIR = resolve(LIGHTWEIGHT_CHARTS_ROOT, 'dist');
const LIGHTWEIGHT_CHARTS_NODE_MODULES_DIR = resolve(LIGHTWEIGHT_CHARTS_ROOT, 'node_modules');
const WATCH_STRATEGIES = process.env.WATCH_STRATEGIES === '1';
const APP_ROOT_POSIX = APP_ROOT.replace(/\\/g, '/');
// Picomatch treats these as syntax. Escape them so a checkout inside a folder
// like `repos/[wip]/` or `@scope/app` cannot turn the anchor into a bad pattern.
const escapeGlobSegment = (value: string): string => value.replace(/[()[\]{}!+@?#]/g, (ch) => `\\${ch}`);
/**
 * Ignore a tree rooted at THIS checkout only.
 *
 * A `**\/signals/**` style glob matches at ANY depth, so it would also swallow a
 * same-named source folder (e.g. a future `lib/signals/`) and silently stop its
 * hot reload. Root-relative anchors keep runtime output trees (ISIN signals,
 * aborted-spec temp trees, build output) out of the watcher without that risk.
 *
 * Returns the bare entry AND its subtree: `x/**` alone does not match `x`, so a
 * directory would still be crawled even though its children were ignored.
 */
const ignoreAtRoot = (entry: string): string[] => [
    `${escapeGlobSegment(APP_ROOT_POSIX)}/${entry}`,
    `${escapeGlobSegment(APP_ROOT_POSIX)}/${entry}/**`,
];
/** Same pair for a name that may appear at any depth under the checkout. */
const ignoreAnywhere = (entry: string): string[] => [`**/${entry}`, `**/${entry}/**`];
const WATCH_IGNORED_GLOBS = [
    // Generated artifacts are rewritten in place and can trip Vite's watcher on Windows.
    '**/artifacts/**',
    // Research archives can contain millions of feature-pack files. Watching
    // these data/build trees exhausts memory before the UI modules can load.
    '**/archive/**',
    '**/batch-runs/**',
    '**/price-data/**',
    '**/logs/**',
    '**/reports/**',
    '**/rust-engine/target/**',
    '**/.freebuff/**',
    ...ignoreAnywhere('screenshots'),
    // Aborted specs used to leave their temp trees in the repo root (the spec now
    // mkdtemps under the OS temp dir). They are gitignored but were still inside
    // the chokidar watch root, so a crashed run inflated the dev server's watch
    // descriptors until restart. Root-anchored: nothing else may match this name.
    ...ignoreAtRoot('asset-opportunity-analysis-*'),
    // ISIN/paper-execution signal output (`signals/`) is written per pass.
    // Root-anchored: a depth-agnostic `**/signals/**` would also match any
    // same-named source folder and quietly disable its hot reload.
    ...ignoreAtRoot('signals'),
    // Local build output of this app; never a hot-reload source.
    ...ignoreAtRoot('dist'),
    // Runtime state of local tooling that happens to live in the checkout.
    ...ignoreAnywhere('.kilo'),
    ...ignoreAnywhere('.zcode'),
    ...ignoreAnywhere('.workbuddy-ai'),
    ...ignoreAnywhere('.codegraph'),
    ...ignoreAnywhere('.hermes'),
    ...ignoreAnywhere('.wrangler'),
    // Copies of this project created by worktree tooling: watching them both
    // duplicates the whole tree and misses the point (edits happen elsewhere).
    ...ignoreAnywhere('.wt-tmp'),
    // Strategy authoring often happens during long Finder runs. Require a manual refresh
    // instead of interrupting the current browser session on every change under lib/strategies.
    ...(WATCH_STRATEGIES ? [] : ['**/lib/strategies/**']),
];


function parseLimit(raw: string | null): number {
    const parsed = Number(raw || '500');
    if (!Number.isFinite(parsed)) return 500;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
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


export default defineConfig({
    // Avoid crawling archived HTML reports during dependency discovery.
    optimizeDeps: {
        entries: ['index.html'],
    },
    plugins: [
        tradFiKlineProxyPlugin(),
        ibkrDataVitePlugin(),
        cryptoDataVitePlugin(),
        localSqlitePlugin(),
        strategyLibraryAdminPlugin(),
        backtestEndpointPlugin(),
        batchBacktestVitePlugin(),
        assetOpportunityExplorerVitePlugin(),
        finderVitePlugin({ batchOwnerLocks: createBatchOwnerLocksAdapter() }),
        monteCarloUniverseVitePlugin(createBatchOwnerLocksAdapter()),
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
        manifest: true,
        rollupOptions: {
            output: {
                manualChunks,
            },
        },
    },
});
