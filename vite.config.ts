import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { defineConfig, type Plugin } from 'vite';
import { backtestEndpointPlugin } from './lib/backtest-endpoint-plugin';
import { strategyLibraryAdminPlugin } from './lib/strategy-library-admin-plugin';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const POLYMARKET_GAMMA_EVENT_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const SQLITE_DB_PATH = resolve(process.cwd(), 'price-data', 'market-data.sqlite');
const SECOND_MARKET_DB_PATH = resolve(process.cwd(), 'price-data', '1second-chart', 'second-market-data.sqlite');
const INDONESIAN_STOCK_PRICE_DATA_DIR = resolve(process.cwd(), 'price-data', 'indonesian-stock');
const SQLITE_MAX_BODY_BYTES = 80 * 1024 * 1024;
const WATCH_STRATEGIES = process.env.WATCH_STRATEGIES === '1';
const WATCH_IGNORED_GLOBS = [
    // Generated artifacts are rewritten in place and can trip Vite's watcher on Windows.
    '**/artifacts/**',
    // Strategy authoring often happens during long Finder/Hunt runs. Require a manual refresh
    // instead of interrupting the current browser session on every change under lib/strategies.
    ...(WATCH_STRATEGIES ? [] : ['**/lib/strategies/**']),
];

let sqliteDb: DatabaseSync | null = null;
const SECOND_MARKET_SYMBOLS = new Set(['BTCUSDT', 'XRPUSDT']);

type SqliteCandleRow = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

function parseLimit(raw: string | null): number {
    const parsed = Number(raw || '500');
    if (!Number.isFinite(parsed)) return 500;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function parseSqliteLimit(raw: string | null): number {
    const parsed = Number(raw || '50000');
    if (!Number.isFinite(parsed)) return 50000;
    return Math.max(1, Math.min(500000, Math.floor(parsed)));
}

function parseSecondMarketWindowSec(raw: string | null): number {
    const parsed = Number(raw || '900');
    if (!Number.isFinite(parsed)) return 900;
    return Math.max(60, Math.min(7200, Math.floor(parsed)));
}

function parseSecondMarketSymbol(raw: string | null): string {
    const symbol = String(raw || 'BTCUSDT').trim().toUpperCase();
    return SECOND_MARKET_SYMBOLS.has(symbol) ? symbol : 'BTCUSDT';
}

function distinctCount(values: readonly number[]): number {
    return new Set(values.filter(Number.isFinite)).size;
}

function countMissingSeconds(values: readonly number[], startTs: number, endTs: number): number {
    if (endTs < startTs) return 0;
    const available = new Set(values.filter(Number.isFinite).map((value) => Math.floor(value)));
    let missing = 0;
    for (let ts = startTs; ts <= endTs; ts += 1) {
        if (!available.has(ts)) missing += 1;
    }
    return missing;
}

function maxFinite(values: readonly (number | null | undefined)[]): number | null {
    let max: number | null = null;
    for (const value of values) {
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        max = max === null ? value : Math.max(max, value);
    }
    return max;
}

function minFinite(values: readonly (number | null | undefined)[]): number | null {
    let min: number | null = null;
    for (const value of values) {
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        min = min === null ? value : Math.min(min, value);
    }
    return min;
}

function toUnixSeconds(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        if (value > 1e12) return Math.floor(value / 1000);
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return toUnixSeconds(numeric);
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
}

function normalizeSqliteCandle(raw: unknown): SqliteCandleRow | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const time = toUnixSeconds(value.time ?? value.timestamp ?? value.t ?? value.openTime);
    const open = Number(value.open ?? value.o);
    const high = Number(value.high ?? value.h);
    const low = Number(value.low ?? value.l);
    const close = Number(value.close ?? value.c);
    const volume = Number(value.volume ?? value.v ?? 0);

    if (!Number.isFinite(time) || time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;

    return {
        time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
    };
}

type PolymarketOutcomeDbRow = {
    series_id: string;
    event_slug: string;
    market_slug: string;
    interval: string;
    event_start_ts: number;
    event_end_ts: number;
    yes_token_id: string;
    no_token_id: string;
    yes_open_price: number | null;
    yes_entry_minute_1_price: number | null;
    yes_entry_minute_2_price: number | null;
    yes_entry_minute_3_price: number | null;
    yes_entry_minute_4_price: number | null;
    resolved_outcome_up: number;
    resolution_source: string;
    updated_at: number;
};

type PolymarketPricePointDbRow = {
    series_id: string;
    event_start_ts: number;
    event_end_ts: number;
    market_slug: string;
    yes_token_id: string;
    no_token_id: string;
    ts: number;
    yes_price: number | null;
    no_price: number | null;
    updated_at: number;
};

type SecondMarketBinanceDbRow = {
    symbol: string;
    market_type: string;
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trade_count: number | null;
    updated_at: number;
};

type SecondMarketClobDbRow = {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    event_start_ts: number;
    event_end_ts: number;
    market_slug: string;
    sample_ts: number;
    yes_bid: number | null;
    yes_ask: number | null;
    yes_mid: number | null;
    no_bid: number | null;
    no_ask: number | null;
    no_mid: number | null;
    source_ts_ms: number | null;
    quote_age_ms: number | null;
    quality_flags: string;
    updated_at: number;
};

type SecondMarketReferenceDbRow = {
    symbol: string;
    reference_source: string;
    source_symbol: string;
    ts: number;
    source_ts_ms: number;
    received_ts_ms: number | null;
    reference_price: number;
    is_carried_forward: number;
    quality_flags: string;
    updated_at: number;
};

type SecondMarketGammaDbRow = {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    market_id: string;
    market_slug: string;
    event_start_ts: number;
    event_end_ts: number;
    snapshot_ts: number;
    gamma_yes_price: number | null;
    gamma_no_price: number | null;
    last_trade_price: number | null;
    liquidity: number | null;
    volume: number | null;
    open_interest: number | null;
    active: number;
    closed: number;
    updated_at: number;
};

type PolymarketHistoryResponse = {
    history?: Array<{ t?: unknown; p?: unknown }>;
};

type PolymarketHistoryPoint = {
    t: number;
    p: number;
};

const POLYMARKET_PRICE_HISTORY_TIMEOUT_MS = 8000;
// First-run signal-exit scoring can touch many distinct 5m events. Fetch in a
// wider batch so server-side ensure can populate the local cache in one pass.
const POLYMARKET_PRICE_POINT_BATCH_SIZE = 24;

function normalizePolymarketHistoryPoints(response: PolymarketHistoryResponse | null): PolymarketHistoryPoint[] {
    const rows = Array.isArray(response?.history) ? response.history : [];
    const dedup = new Map<number, number>();

    for (const row of rows) {
        const t = Math.floor(Number(row?.t));
        const p = Number(row?.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }

    return Array.from(dedup.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([t, p]) => ({ t, p }));
}

async function fetchPolymarketHistory(url: string): Promise<PolymarketHistoryResponse> {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(POLYMARKET_PRICE_HISTORY_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json() as PolymarketHistoryResponse;
}

async function fetchPolymarketYesHistory(outcome: PolymarketOutcomeDbRow): Promise<PolymarketHistoryPoint[]> {
    if (!outcome.yes_token_id) {
        return [];
    }

    const nearParams = new URLSearchParams({
        market: outcome.yes_token_id,
        startTs: String(Math.max(0, outcome.event_start_ts - 15)),
        endTs: String(outcome.event_end_ts),
    });
    const nearPoints = normalizePolymarketHistoryPoints(
        await fetchPolymarketHistory(`${POLYMARKET_CLOB_HISTORY_URL}?${nearParams.toString()}`)
    );
    if (nearPoints.length > 0) {
        return nearPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: outcome.yes_token_id,
        interval: 'max',
    });
    return normalizePolymarketHistoryPoints(
        await fetchPolymarketHistory(`${POLYMARKET_CLOB_HISTORY_URL}?${fallbackParams.toString()}`)
    ).filter((point) => (
        point.t >= outcome.event_start_ts
        && point.t <= outcome.event_end_ts
    ));
}

async function fetchPolymarketPricePointsForOutcome(
    outcome: PolymarketOutcomeDbRow,
    seriesId: string
): Promise<PolymarketPricePointDbRow[]> {
    if (!outcome.yes_token_id) {
        return [];
    }

    const yesHistory = await fetchPolymarketYesHistory(outcome);
    return yesHistory.map((point) => ({
        series_id: seriesId,
        event_start_ts: outcome.event_start_ts,
        event_end_ts: outcome.event_end_ts,
        market_slug: outcome.market_slug || outcome.event_slug,
        yes_token_id: outcome.yes_token_id,
        no_token_id: outcome.no_token_id || '',
        ts: point.t,
        yes_price: point.p,
        no_price: Math.round((1 - point.p) * 10000) / 10000,
        updated_at: Math.floor(Date.now() / 1000),
    }));
}

function loadStoredPolymarketPricePoints(
    db: DatabaseSync,
    seriesId: string,
    eventStartTs: readonly number[],
): PolymarketPricePointDbRow[] {
    if (eventStartTs.length === 0) {
        return [];
    }

    const placeholders = eventStartTs.map(() => '?').join(',');
    return db.prepare(`
        SELECT series_id, event_start_ts, event_end_ts, market_slug,
               yes_token_id, no_token_id, ts, yes_price, no_price, updated_at
        FROM polymarket_price_points
        WHERE series_id = ? AND event_start_ts IN (${placeholders})
        ORDER BY ts ASC
    `).all(seriesId, ...eventStartTs) as PolymarketPricePointDbRow[];
}

function storePolymarketPricePointsInDb(
    db: DatabaseSync,
    rows: readonly PolymarketPricePointDbRow[],
): number {
    if (rows.length === 0) {
        return 0;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const upsert = db.prepare(`
        INSERT INTO polymarket_price_points (
            series_id, event_start_ts, event_end_ts, market_slug,
            yes_token_id, no_token_id, ts, yes_price, no_price, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(series_id, event_start_ts, ts) DO UPDATE SET
            event_end_ts = excluded.event_end_ts,
            market_slug = excluded.market_slug,
            yes_token_id = excluded.yes_token_id,
            no_token_id = excluded.no_token_id,
            yes_price = excluded.yes_price,
            no_price = excluded.no_price,
            updated_at = excluded.updated_at
    `);

    let upserted = 0;
    db.exec('BEGIN');
    try {
        for (const row of rows) {
            upsert.run(
                String(row.series_id),
                Number(row.event_start_ts),
                Number(row.event_end_ts),
                String(row.market_slug ?? ''),
                String(row.yes_token_id ?? ''),
                String(row.no_token_id ?? ''),
                Number(row.ts),
                row.yes_price != null ? Number(row.yes_price) : null,
                row.no_price != null ? Number(row.no_price) : null,
                nowSec,
            );
            upserted++;
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }

    return upserted;
}

async function ensurePolymarketPricePointsInDb(args: {
    db: DatabaseSync;
    seriesId: string;
    outcomes: readonly PolymarketOutcomeDbRow[];
}): Promise<{ rows: PolymarketPricePointDbRow[]; upserted: number; fetchedEvents: number; }> {
    const eventStartTs = Array.from(new Set(
        args.outcomes
            .map((outcome) => Number(outcome.event_start_ts))
            .filter((value) => Number.isFinite(value))
    )).sort((left, right) => left - right);

    if (eventStartTs.length === 0) {
        return { rows: [], upserted: 0, fetchedEvents: 0 };
    }

    const existingRows = loadStoredPolymarketPricePoints(args.db, args.seriesId, eventStartTs);
    const coverageByEvent = new Map<number, { timestamps: Set<number>; latestTs: number }>();
    for (const row of existingRows) {
        let coverage = coverageByEvent.get(row.event_start_ts);
        if (!coverage) {
            coverage = {
                timestamps: new Set<number>(),
                latestTs: Number.NEGATIVE_INFINITY,
            };
            coverageByEvent.set(row.event_start_ts, coverage);
        }
        coverage.timestamps.add(row.ts);
        coverage.latestTs = Math.max(coverage.latestTs, row.ts);
    }

    const coveredEventStarts = new Set<number>();
    for (const outcome of args.outcomes) {
        const coverage = coverageByEvent.get(outcome.event_start_ts);
        if (
            coverage
            && coverage.timestamps.size >= 2
            && coverage.latestTs >= outcome.event_end_ts - 60
        ) {
            coveredEventStarts.add(outcome.event_start_ts);
        }
    }
    const uncoveredOutcomes = args.outcomes.filter((outcome) => !coveredEventStarts.has(outcome.event_start_ts));

    if (uncoveredOutcomes.length === 0) {
        return { rows: existingRows, upserted: 0, fetchedEvents: 0 };
    }

    const newRows: PolymarketPricePointDbRow[] = [];
    for (let index = 0; index < uncoveredOutcomes.length; index += POLYMARKET_PRICE_POINT_BATCH_SIZE) {
        const batch = uncoveredOutcomes.slice(index, index + POLYMARKET_PRICE_POINT_BATCH_SIZE);
        const batchRows = await Promise.all(batch.map(async (outcome) => {
            try {
                return await fetchPolymarketPricePointsForOutcome(outcome, args.seriesId);
            } catch {
                return [];
            }
        }));
        for (const rows of batchRows) {
            newRows.push(...rows);
        }
    }

    const upserted = storePolymarketPricePointsInDb(args.db, newRows);
    return {
        rows: loadStoredPolymarketPricePoints(args.db, args.seriesId, eventStartTs),
        upserted,
        fetchedEvents: uncoveredOutcomes.length,
    };
}

function getSqliteDb(): DatabaseSync {
    if (sqliteDb) return sqliteDb;

    mkdirSync(dirname(SQLITE_DB_PATH), { recursive: true });
    const db = new DatabaseSync(SQLITE_DB_PATH);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS candles (
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL DEFAULT 0,
            provider TEXT,
            source TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(symbol, interval, time)
        );
        CREATE TABLE IF NOT EXISTS series_meta (
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            provider TEXT,
            bars_count INTEGER NOT NULL DEFAULT 0,
            first_time INTEGER,
            last_time INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(symbol, interval)
        );
        CREATE TABLE IF NOT EXISTS polymarket_outcomes (
            series_id TEXT NOT NULL,
            event_slug TEXT NOT NULL,
            market_slug TEXT NOT NULL DEFAULT '',
            interval TEXT NOT NULL DEFAULT '5m',
            event_start_ts INTEGER NOT NULL,
            event_end_ts INTEGER NOT NULL,
            yes_token_id TEXT NOT NULL,
            no_token_id TEXT NOT NULL DEFAULT '',
            yes_open_price REAL,
            yes_entry_minute_1_price REAL,
            yes_entry_minute_2_price REAL,
            yes_entry_minute_3_price REAL,
            yes_entry_minute_4_price REAL,
            resolved_outcome_up INTEGER NOT NULL,
            resolution_source TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(series_id, event_slug)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_outcomes_series_start
            ON polymarket_outcomes(series_id, event_start_ts);
        CREATE INDEX IF NOT EXISTS idx_pm_outcomes_interval_start
            ON polymarket_outcomes(interval, event_start_ts);
        CREATE TABLE IF NOT EXISTS polymarket_price_points (
            series_id TEXT NOT NULL,
            event_start_ts INTEGER NOT NULL,
            event_end_ts INTEGER NOT NULL,
            market_slug TEXT NOT NULL DEFAULT '',
            yes_token_id TEXT NOT NULL,
            no_token_id TEXT NOT NULL DEFAULT '',
            ts INTEGER NOT NULL,
            yes_price REAL,
            no_price REAL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(series_id, event_start_ts, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_price_points_event_time
            ON polymarket_price_points(series_id, event_start_ts, ts);
        CREATE INDEX IF NOT EXISTS idx_pm_price_points_series_time
            ON polymarket_price_points(series_id, ts);
    `);
    sqliteDb = db;
    return db;
}

function sendJson(res: any, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}

function sendBinary(res: any, status: number, payload: Buffer): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(payload);
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of req) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > SQLITE_MAX_BODY_BYTES) {
            throw new Error('Request body too large');
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const buffer = await readBodyBuffer(req);
    const text = buffer.toString('utf8').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
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
                });
                const body = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                res.end(body);
            } catch {
                sendJson(res, 500, { ok: false, error: 'Polymarket event proxy request failed' });
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
                });
                const body = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                res.end(body);
            } catch {
                sendJson(res, 500, { ok: false, error: 'Polymarket history proxy request failed' });
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
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { ok: false, error: message });
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

function secondMarketVisualizerPlugin(): Plugin {
    const openReadOnlyDb = (): DatabaseSync | null => {
        if (!existsSync(SECOND_MARKET_DB_PATH)) return null;
        return new DatabaseSync(SECOND_MARKET_DB_PATH, { readOnly: true });
    };

    const loadLatestTs = (db: DatabaseSync, symbol: string, marketType: string): number | null => {
        const row = db.prepare(`
            SELECT MAX(latest_ts) AS latestTs
            FROM (
                SELECT MAX(ts) AS latest_ts
                FROM binance_1s_candles
                WHERE symbol = ? AND market_type = ?
                UNION ALL
                SELECT MAX(sample_ts) AS latest_ts
                FROM polymarket_clob_1s_quotes
                WHERE symbol = ? AND event_start_ts <= sample_ts AND event_end_ts > sample_ts
                UNION ALL
                SELECT MAX(ts) AS latest_ts
                FROM polymarket_reference_1s_prices
                WHERE symbol = ?
            )
        `).get(symbol, marketType, symbol, symbol) as { latestTs?: number | null } | undefined;
        const latestTs = Number(row?.latestTs);
        return Number.isFinite(latestTs) ? Math.floor(latestTs) : null;
    };

    const register = (middlewares: any) => {
        middlewares.use('/api/second-market', async (req: any, res: any) => {
            const method = req.method || 'GET';
            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const path = requestUrl.pathname;

            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'Method not allowed' });
                return;
            }

            try {
                if (path === '/status') {
                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 200, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: 'Second-market SQLite DB not found.',
                        });
                        return;
                    }

                    try {
                        const counts = {
                            binance: Number((db.prepare('SELECT COUNT(*) AS count FROM binance_1s_candles').get() as { count?: number }).count) || 0,
                            clob: Number((db.prepare('SELECT COUNT(*) AS count FROM polymarket_clob_1s_quotes').get() as { count?: number }).count) || 0,
                            reference: Number((db.prepare('SELECT COUNT(*) AS count FROM polymarket_reference_1s_prices').get() as { count?: number }).count) || 0,
                            gamma: Number((db.prepare('SELECT COUNT(*) AS count FROM polymarket_gamma_snapshots').get() as { count?: number }).count) || 0,
                        };
                        sendJson(res, 200, {
                            ok: true,
                            dbPath: SECOND_MARKET_DB_PATH,
                            counts,
                        });
                    } finally {
                        db.close();
                    }
                    return;
                }

                if (path === '/window') {
                    const symbol = parseSecondMarketSymbol(requestUrl.searchParams.get('symbol'));
                    const marketType = requestUrl.searchParams.get('marketType') === 'futures' ? 'futures' : 'spot';
                    const referenceSource = (requestUrl.searchParams.get('referenceSource') || 'crypto_prices').trim();
                    const windowSec = parseSecondMarketWindowSec(requestUrl.searchParams.get('windowSec'));
                    const explicitEndTs = toUnixSeconds(requestUrl.searchParams.get('endTs'));
                    const explicitStartTs = toUnixSeconds(requestUrl.searchParams.get('startTs'));

                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 404, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: 'Second-market SQLite DB not found.',
                        });
                        return;
                    }

                    try {
                        const latestTs = explicitEndTs ?? loadLatestTs(db, symbol, marketType) ?? Math.floor(Date.now() / 1000);
                        const endTs = Math.floor(latestTs);
                        const startTs = Math.floor(explicitStartTs ?? (endTs - windowSec + 1));

                        const candles = db.prepare(`
                            SELECT symbol, market_type, ts, open, high, low, close, volume, trade_count, updated_at
                            FROM binance_1s_candles
                            WHERE symbol = ? AND market_type = ? AND ts >= ? AND ts <= ?
                            ORDER BY ts ASC
                        `).all(symbol, marketType, startTs, endTs) as SecondMarketBinanceDbRow[];

                        const clobRows = db.prepare(`
                            SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts, market_slug,
                                   sample_ts, yes_bid, yes_ask, yes_mid, no_bid, no_ask, no_mid,
                                   source_ts_ms, quote_age_ms, quality_flags, updated_at
                            FROM polymarket_clob_1s_quotes
                            WHERE symbol = ?
                              AND sample_ts >= ?
                              AND sample_ts <= ?
                              AND event_start_ts <= sample_ts
                              AND event_end_ts > sample_ts
                            ORDER BY sample_ts ASC, updated_at ASC
                        `).all(symbol, startTs, endTs) as SecondMarketClobDbRow[];

                        const referenceRows = db.prepare(`
                            SELECT symbol, reference_source, source_symbol, ts, source_ts_ms, received_ts_ms,
                                   reference_price, is_carried_forward, quality_flags, updated_at
                            FROM polymarket_reference_1s_prices
                            WHERE symbol = ? AND reference_source = ? AND ts >= ? AND ts <= ?
                            ORDER BY ts ASC, source_ts_ms ASC
                        `).all(symbol, referenceSource, startTs, endTs) as SecondMarketReferenceDbRow[];

                        const gammaRows = db.prepare(`
                            SELECT series_id, symbol, outcome_interval, market_id, market_slug,
                                   event_start_ts, event_end_ts, snapshot_ts, gamma_yes_price, gamma_no_price,
                                   last_trade_price, liquidity, volume, open_interest, active, closed, updated_at
                            FROM polymarket_gamma_snapshots
                            WHERE symbol = ?
                              AND event_start_ts <= ?
                              AND event_end_ts > ?
                              AND snapshot_ts <= ?
                            ORDER BY snapshot_ts DESC
                            LIMIT 20
                        `).all(symbol, endTs, endTs, endTs) as SecondMarketGammaDbRow[];
                        const gammaSnapshots = gammaRows.slice().reverse();
                        const latestGamma = gammaRows[0] ?? null;

                        const binanceTimes = candles.map((row) => row.ts);
                        const clobTimes = clobRows.map((row) => row.sample_ts);
                        const referenceTimes = referenceRows.map((row) => row.ts);
                        const firstOverlap = maxFinite([
                            minFinite(binanceTimes),
                            minFinite(clobTimes),
                        ]);
                        const lastOverlap = minFinite([
                            maxFinite(binanceTimes),
                            maxFinite(clobTimes),
                        ]);
                        const overlapStartTs = firstOverlap === null ? null : Math.floor(firstOverlap);
                        const overlapEndTs = lastOverlap === null ? null : Math.floor(lastOverlap);
                        const overlapSeconds = overlapStartTs !== null && overlapEndTs !== null && overlapEndTs >= overlapStartTs
                            ? overlapEndTs - overlapStartTs + 1
                            : 0;
                        const exactClobSeconds = overlapStartTs !== null && overlapEndTs !== null
                            ? distinctCount(clobTimes.filter((ts) => ts >= overlapStartTs && ts <= overlapEndTs))
                            : 0;
                        const latestQuoteAgeMs = maxFinite(clobRows.map((row) => row.quote_age_ms));
                        const latestDataTs = maxFinite([
                            maxFinite(binanceTimes),
                            maxFinite(clobTimes),
                            maxFinite(referenceTimes),
                        ]);
                        const latestClob = clobRows[clobRows.length - 1] ?? null;

                        sendJson(res, 200, {
                            ok: true,
                            dbPath: SECOND_MARKET_DB_PATH,
                            symbol,
                            marketType,
                            referenceSource,
                            startTs,
                            endTs,
                            candles,
                            clobQuotes: clobRows,
                            referencePrices: referenceRows,
                            gammaSnapshots,
                            stats: {
                                binanceSeconds: distinctCount(binanceTimes),
                                clobSeconds: distinctCount(clobTimes),
                                referenceSeconds: distinctCount(referenceTimes),
                                gammaSnapshots: gammaRows.length,
                                missingBinanceSeconds: countMissingSeconds(binanceTimes, startTs, endTs),
                                missingClobSeconds: countMissingSeconds(clobTimes, startTs, endTs),
                                missingReferenceSeconds: countMissingSeconds(referenceTimes, startTs, endTs),
                                overlapStartTs,
                                overlapEndTs,
                                overlapSeconds,
                                exactSampleCoveragePct: overlapSeconds > 0 ? (exactClobSeconds / overlapSeconds) * 100 : 0,
                                maxQuoteAgeSec: latestQuoteAgeMs === null ? null : Math.ceil(latestQuoteAgeMs / 1000),
                                latestDataTs,
                                latestLagSec: latestDataTs === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - latestDataTs),
                                activeMarketSlug: latestClob?.market_slug ?? latestGamma?.market_slug ?? null,
                                activeEventStartTs: latestClob?.event_start_ts ?? latestGamma?.event_start_ts ?? null,
                                activeEventEndTs: latestClob?.event_end_ts ?? latestGamma?.event_end_ts ?? null,
                            },
                        });
                    } finally {
                        db.close();
                    }
                    return;
                }

                sendJson(res, 404, { ok: false, error: 'Not found' });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { ok: false, error: message });
            }
        });
    };

    return {
        name: 'second-market-visualizer-api',
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

function localSqlitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use('/api/sqlite', async (req: any, res: any) => {
            const method = req.method || 'GET';
            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const path = requestUrl.pathname;

            try {
                if (method === 'GET' && path === '/status') {
                    const db = getSqliteDb();
                    const total = db.prepare('SELECT COUNT(*) AS count FROM candles').get() as { count?: number };
                    sendJson(res, 200, {
                        ok: true,
                        dbPath: SQLITE_DB_PATH,
                        totalCandles: Number(total.count) || 0,
                    });
                    return;
                }

                if (method === 'GET' && path === '/load-ohlcv') {
                    const symbol = (requestUrl.searchParams.get('symbol') || '').trim().toUpperCase();
                    const interval = (requestUrl.searchParams.get('interval') || '').trim().toLowerCase();
                    const limit = parseSqliteLimit(requestUrl.searchParams.get('limit'));
                    if (!symbol || !interval) {
                        sendJson(res, 400, { ok: false, error: 'symbol and interval are required' });
                        return;
                    }

                    const db = getSqliteDb();
                    const rows = db.prepare(`
                        SELECT time, open, high, low, close, volume
                        FROM candles
                        WHERE symbol = ? AND interval = ?
                        ORDER BY time DESC
                        LIMIT ?
                    `).all(symbol, interval, limit) as SqliteCandleRow[];

                    const accept = req.headers.accept || '';
                    if (accept.includes('application/octet-stream')) {
                        const N = rows.length;
                        const F = 6;
                        const buffer = Buffer.alloc(16 + F * N * 8);
                        
                        buffer.writeUInt32LE(0x4F484C56, 0);
                        buffer.writeUInt32LE(1, 4);
                        buffer.writeUInt32LE(N, 8);
                        buffer.writeUInt32LE(F, 12);
                        
                        for (let i = 0; i < N; i++) {
                            const row = rows[N - 1 - i];
                            buffer.writeDoubleLE(row.time, 16 + i * 8);
                            buffer.writeDoubleLE(row.open, 16 + N * 8 + i * 8);
                            buffer.writeDoubleLE(row.high, 16 + 2 * N * 8 + i * 8);
                            buffer.writeDoubleLE(row.low, 16 + 3 * N * 8 + i * 8);
                            buffer.writeDoubleLE(row.close, 16 + 4 * N * 8 + i * 8);
                            buffer.writeDoubleLE(row.volume, 16 + 5 * N * 8 + i * 8);
                        }
                        
                        sendBinary(res, 200, buffer);
                        return;
                    }

                    rows.reverse();

                    sendJson(res, 200, {
                        ok: true,
                        symbol,
                        interval,
                        candles: rows,
                    });
                    return;
                }

                if (method === 'POST' && path === '/store-ohlcv') {
                    const contentType = req.headers['content-type'] || '';
                    const isBinary = contentType.includes('application/octet-stream');
                    
                    let symbol = '';
                    let interval = '';
                    let provider = 'unknown';
                    let source = 'manual';
                    let candles: SqliteCandleRow[] = [];

                    if (isBinary) {
                        symbol = (requestUrl.searchParams.get('symbol') || '').trim().toUpperCase();
                        interval = (requestUrl.searchParams.get('interval') || '').trim().toLowerCase();
                        provider = requestUrl.searchParams.get('provider') || 'unknown';
                        source = requestUrl.searchParams.get('source') || 'manual';

                        const buffer = await readBodyBuffer(req as IncomingMessage);
                        if (buffer.length >= 16) {
                            const magic = buffer.readUInt32LE(0);
                            const version = buffer.readUInt32LE(4);
                            const N = buffer.readUInt32LE(8);
                            const F = buffer.readUInt32LE(12);
                            
                            if (magic === 0x4F484C56 && version === 1 && F === 6 && buffer.length >= 16 + N * F * 8) {
                                for (let i = 0; i < N; i++) {
                                    candles.push({
                                        time: buffer.readDoubleLE(16 + i * 8),
                                        open: buffer.readDoubleLE(16 + N * 8 + i * 8),
                                        high: buffer.readDoubleLE(16 + 2 * N * 8 + i * 8),
                                        low: buffer.readDoubleLE(16 + 3 * N * 8 + i * 8),
                                        close: buffer.readDoubleLE(16 + 4 * N * 8 + i * 8),
                                        volume: buffer.readDoubleLE(16 + 5 * N * 8 + i * 8)
                                    });
                                }
                            } else {
                                sendJson(res, 400, { ok: false, error: 'Invalid binary payload' });
                                return;
                            }
                        } else {
                            sendJson(res, 400, { ok: false, error: 'Binary payload too small' });
                            return;
                        }
                    } else {
                        const payload = await readJsonBody(req as IncomingMessage);
                        symbol = String(payload.symbol || '').trim().toUpperCase();
                        interval = String(payload.interval || '').trim().toLowerCase();
                        provider = String(payload.provider || 'unknown');
                        source = String(payload.source || 'manual');
                        const rawCandles = Array.isArray(payload.candles) ? payload.candles : [];

                        candles = rawCandles
                            .map(normalizeSqliteCandle)
                            .filter((row): row is SqliteCandleRow => !!row);
                    }

                    if (!symbol || !interval) {
                        sendJson(res, 400, { ok: false, error: 'symbol and interval are required' });
                        return;
                    }
                    if (candles.length === 0) {
                        sendJson(res, 400, { ok: false, error: 'No valid candles found in request.' });
                        return;
                    }

                    const db = getSqliteDb();
                    const nowSec = Math.floor(Date.now() / 1000);
                    const upsert = db.prepare(`
                        INSERT INTO candles (
                            symbol, interval, time, open, high, low, close, volume, provider, source, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(symbol, interval, time) DO UPDATE SET
                            open = excluded.open,
                            high = excluded.high,
                            low = excluded.low,
                            close = excluded.close,
                            volume = excluded.volume,
                            provider = excluded.provider,
                            source = excluded.source,
                            updated_at = excluded.updated_at
                    `);

                    db.exec('BEGIN');
                    try {
                        for (const item of candles) {
                            upsert.run(
                                symbol,
                                interval,
                                item.time,
                                item.open,
                                item.high,
                                item.low,
                                item.close,
                                item.volume,
                                provider,
                                source,
                                nowSec
                            );
                        }
                        db.exec('COMMIT');
                    } catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }

                    const summary = db.prepare(`
                        SELECT
                            COUNT(*) AS count,
                            MIN(time) AS firstTime,
                            MAX(time) AS lastTime
                        FROM candles
                        WHERE symbol = ? AND interval = ?
                    `).get(symbol, interval) as { count?: number; firstTime?: number; lastTime?: number };

                    db.prepare(`
                        INSERT INTO series_meta (symbol, interval, provider, bars_count, first_time, last_time, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(symbol, interval) DO UPDATE SET
                            provider = excluded.provider,
                            bars_count = excluded.bars_count,
                            first_time = excluded.first_time,
                            last_time = excluded.last_time,
                            updated_at = excluded.updated_at
                    `).run(
                        symbol,
                        interval,
                        provider,
                        Number(summary.count) || 0,
                        Number(summary.firstTime) || null,
                        Number(summary.lastTime) || null,
                        nowSec
                    );

                    sendJson(res, 200, {
                        ok: true,
                        symbol,
                        interval,
                        upserted: candles.length,
                        totalBars: Number(summary.count) || 0,
                        firstTime: Number(summary.firstTime) || null,
                        lastTime: Number(summary.lastTime) || null,
                        dbPath: SQLITE_DB_PATH,
                    });
                    return;
                }

                if (method === 'GET' && path === '/load-polymarket-outcomes') {
                    const seriesId = (requestUrl.searchParams.get('seriesId') || '').trim();
                    const startTsRaw = requestUrl.searchParams.get('startTs');
                    const endTsRaw = requestUrl.searchParams.get('endTs');
                    const limitRaw = requestUrl.searchParams.get('limit');

                    const startTs = startTsRaw !== null ? Number(startTsRaw) : null;
                    const endTs = endTsRaw !== null ? Number(endTsRaw) : null;
                    const limit = limitRaw !== null ? Math.max(1, Math.min(100000, Math.floor(Number(limitRaw) || 10000))) : 10000;

                    if (startTs !== null && !Number.isFinite(startTs)) {
                        sendJson(res, 400, { ok: false, error: 'startTs must be a finite number' });
                        return;
                    }
                    if (endTs !== null && !Number.isFinite(endTs)) {
                        sendJson(res, 400, { ok: false, error: 'endTs must be a finite number' });
                        return;
                    }

                    const db = getSqliteDb();
                    const conditions: string[] = [];
                    const bindings: (string | number)[] = [];

                    if (seriesId) { conditions.push('series_id = ?'); bindings.push(seriesId); }
                    if (startTs !== null) { conditions.push('event_start_ts >= ?'); bindings.push(Math.floor(startTs)); }
                    if (endTs !== null) { conditions.push('event_start_ts <= ?'); bindings.push(Math.floor(endTs)); }

                    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
                    bindings.push(limit);

                    const rows = db.prepare(`
                        SELECT series_id, event_slug, market_slug, interval,
                               event_start_ts, event_end_ts, yes_token_id, no_token_id,
                               yes_open_price, yes_entry_minute_1_price, yes_entry_minute_2_price,
                               yes_entry_minute_3_price, yes_entry_minute_4_price,
                               resolved_outcome_up, resolution_source, updated_at
                        FROM polymarket_outcomes
                        ${where}
                        ORDER BY event_start_ts ASC
                        LIMIT ?
                    `).all(...bindings) as PolymarketOutcomeDbRow[];

                    sendJson(res, 200, { ok: true, rows, count: rows.length });
                    return;
                }

                if (method === 'POST' && path === '/store-polymarket-outcomes') {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
                    if (rawRows.length === 0) {
                        sendJson(res, 400, { ok: false, error: 'rows array is required and must not be empty' });
                        return;
                    }

                    const db = getSqliteDb();
                    const nowSec = Math.floor(Date.now() / 1000);

                    const upsert = db.prepare(`
                        INSERT INTO polymarket_outcomes (
                            series_id, event_slug, market_slug, interval,
                            event_start_ts, event_end_ts, yes_token_id, no_token_id,
                            yes_open_price, yes_entry_minute_1_price, yes_entry_minute_2_price,
                            yes_entry_minute_3_price, yes_entry_minute_4_price,
                            resolved_outcome_up, resolution_source, updated_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(series_id, event_slug) DO UPDATE SET
                            market_slug = excluded.market_slug,
                            interval = excluded.interval,
                            event_start_ts = excluded.event_start_ts,
                            event_end_ts = excluded.event_end_ts,
                            yes_token_id = excluded.yes_token_id,
                            no_token_id = excluded.no_token_id,
                            yes_open_price = excluded.yes_open_price,
                            yes_entry_minute_1_price = excluded.yes_entry_minute_1_price,
                            yes_entry_minute_2_price = excluded.yes_entry_minute_2_price,
                            yes_entry_minute_3_price = excluded.yes_entry_minute_3_price,
                            yes_entry_minute_4_price = excluded.yes_entry_minute_4_price,
                            resolved_outcome_up = excluded.resolved_outcome_up,
                            resolution_source = excluded.resolution_source,
                            updated_at = excluded.updated_at
                    `);

                    let upserted = 0;
                    db.exec('BEGIN');
                    try {
                        for (const r of rawRows as PolymarketOutcomeDbRow[]) {
                            if (!r.series_id || !r.event_slug) continue;
                            upsert.run(
                                String(r.series_id),
                                String(r.event_slug),
                                String(r.market_slug ?? ''),
                                String(r.interval ?? '5m'),
                                Number(r.event_start_ts),
                                Number(r.event_end_ts),
                                String(r.yes_token_id ?? ''),
                                String(r.no_token_id ?? ''),
                                r.yes_open_price != null ? Number(r.yes_open_price) : null,
                                r.yes_entry_minute_1_price != null ? Number(r.yes_entry_minute_1_price) : null,
                                r.yes_entry_minute_2_price != null ? Number(r.yes_entry_minute_2_price) : null,
                                r.yes_entry_minute_3_price != null ? Number(r.yes_entry_minute_3_price) : null,
                                r.yes_entry_minute_4_price != null ? Number(r.yes_entry_minute_4_price) : null,
                                Number(r.resolved_outcome_up),
                                String(r.resolution_source ?? ''),
                                nowSec,
                            );
                            upserted++;
                        }
                        db.exec('COMMIT');
                    } catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }

                    sendJson(res, 200, { ok: true, upserted });
                    return;
                }

                if (method === 'POST' && path === '/ensure-polymarket-price-points') {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId.trim() : '';
                    const rawOutcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];

                    if (!seriesId) {
                        sendJson(res, 400, { ok: false, error: 'seriesId is required' });
                        return;
                    }

                    if (rawOutcomes.length === 0) {
                        sendJson(res, 200, { ok: true, rows: [], upserted: 0, fetchedEvents: 0 });
                        return;
                    }

                    const outcomes = rawOutcomes
                        .filter((row): row is PolymarketOutcomeDbRow => Boolean(
                            row
                            && typeof row === 'object'
                            && typeof (row as PolymarketOutcomeDbRow).event_start_ts === 'number'
                            && typeof (row as PolymarketOutcomeDbRow).event_end_ts === 'number'
                            && typeof (row as PolymarketOutcomeDbRow).yes_token_id === 'string'
                        ))
                        .map((row) => ({
                            ...row,
                            series_id: typeof row.series_id === 'string' && row.series_id.trim().length > 0
                                ? row.series_id.trim()
                                : seriesId,
                        }));

                    const db = getSqliteDb();
                    const ensured = await ensurePolymarketPricePointsInDb({
                        db,
                        seriesId,
                        outcomes,
                    });

                    sendJson(res, 200, {
                        ok: true,
                        rows: ensured.rows,
                        upserted: ensured.upserted,
                        fetchedEvents: ensured.fetchedEvents,
                    });
                    return;
                }

                if (method === 'GET' && path === '/load-polymarket-price-points') {
                    const seriesId = (requestUrl.searchParams.get('seriesId') || '').trim();
                    const eventStartTsRaw = requestUrl.searchParams.get('eventStartTs');
                    const startTsRaw = requestUrl.searchParams.get('startTs');
                    const endTsRaw = requestUrl.searchParams.get('endTs');
                    const limitRaw = requestUrl.searchParams.get('limit');

                    const startTs = startTsRaw !== null ? Number(startTsRaw) : null;
                    const endTs = endTsRaw !== null ? Number(endTsRaw) : null;
                    const limit = limitRaw !== null ? Math.max(1, Math.min(500000, Math.floor(Number(limitRaw) || 100000))) : 100000;

                    if (!seriesId) {
                        sendJson(res, 400, { ok: false, error: 'seriesId is required' });
                        return;
                    }

                    const db = getSqliteDb();
                    const conditions: string[] = ['series_id = ?'];
                    const bindings: (string | number)[] = [seriesId];

                    if (eventStartTsRaw !== null) {
                        const parts = eventStartTsRaw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
                        if (parts.length > 0) {
                            const placeholders = parts.map(() => '?').join(',');
                            conditions.push(`event_start_ts IN (${placeholders})`);
                            bindings.push(...parts);
                        }
                    }
                    if (startTs !== null && Number.isFinite(startTs)) {
                        conditions.push('ts >= ?');
                        bindings.push(Math.floor(startTs));
                    }
                    if (endTs !== null && Number.isFinite(endTs)) {
                        conditions.push('ts <= ?');
                        bindings.push(Math.floor(endTs));
                    }

                    const where = `WHERE ${conditions.join(' AND ')}`;
                    bindings.push(limit);

                    const rows = db.prepare(`
                        SELECT series_id, event_start_ts, event_end_ts, market_slug,
                               yes_token_id, no_token_id, ts, yes_price, no_price, updated_at
                        FROM polymarket_price_points
                        ${where}
                        ORDER BY ts ASC
                        LIMIT ?
                    `).all(...bindings) as any[];

                    sendJson(res, 200, { ok: true, rows, count: rows.length });
                    return;
                }

                if (method === 'POST' && path === '/store-polymarket-price-points') {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
                    if (rawRows.length === 0) {
                        sendJson(res, 400, { ok: false, error: 'rows array is required and must not be empty' });
                        return;
                    }

                    const db = getSqliteDb();
                    const nowSec = Math.floor(Date.now() / 1000);

                    const upsert = db.prepare(`
                        INSERT INTO polymarket_price_points (
                            series_id, event_start_ts, event_end_ts, market_slug,
                            yes_token_id, no_token_id, ts, yes_price, no_price, updated_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(series_id, event_start_ts, ts) DO UPDATE SET
                            event_end_ts = excluded.event_end_ts,
                            market_slug = excluded.market_slug,
                            yes_token_id = excluded.yes_token_id,
                            no_token_id = excluded.no_token_id,
                            yes_price = excluded.yes_price,
                            no_price = excluded.no_price,
                            updated_at = excluded.updated_at
                    `);

                    let upserted = 0;
                    db.exec('BEGIN');
                    try {
                        for (const r of rawRows as any[]) {
                            if (!r.series_id || r.event_start_ts == null || r.ts == null) continue;
                            upsert.run(
                                String(r.series_id),
                                Number(r.event_start_ts),
                                Number(r.event_end_ts),
                                String(r.market_slug ?? ''),
                                String(r.yes_token_id ?? ''),
                                String(r.no_token_id ?? ''),
                                Number(r.ts),
                                r.yes_price != null ? Number(r.yes_price) : null,
                                r.no_price != null ? Number(r.no_price) : null,
                                nowSec,
                            );
                            upserted++;
                        }
                        db.exec('COMMIT');
                    } catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }

                    sendJson(res, 200, { ok: true, upserted });
                    return;
                }

                if (method === 'POST' && path === '/write-seed-log') {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const seedRaw = Number(payload.seed);
                    const seed = Number.isFinite(seedRaw) ? Math.trunc(seedRaw) : NaN;
                    const content = typeof payload.content === 'string' ? payload.content : '';

                    if (!Number.isFinite(seed)) {
                        sendJson(res, 400, { ok: false, error: 'seed must be a finite number' });
                        return;
                    }
                    if (!content.trim()) {
                        sendJson(res, 400, { ok: false, error: 'content must be a non-empty string' });
                        return;
                    }

                    const filePath = resolve(process.cwd(), `run-seed-${seed}.txt`);
                    const normalized = content.endsWith('\n') ? content : `${content}\n`;
                    writeFileSync(filePath, normalized, 'utf8');

                    sendJson(res, 200, {
                        ok: true,
                        seed,
                        filePath,
                        bytes: Buffer.byteLength(normalized, 'utf8'),
                    });
                    return;
                }

                sendJson(res, 404, { ok: false, error: 'Not found' });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { ok: false, error: message });
            }
        });
    };

    return {
        name: 'local-sqlite-api',
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
        secondMarketVisualizerPlugin(),
        localSqlitePlugin(),
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
