import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { defineConfig, type Plugin } from 'vite';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const POLYMARKET_GAMMA_EVENT_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const SQLITE_DB_PATH = resolve(process.cwd(), 'price-data', 'market-data.sqlite');
const SQLITE_MAX_BODY_BYTES = 80 * 1024 * 1024;
const WATCH_IGNORED_GLOBS = [
    // Generated artifacts are rewritten in place and can trip Vite's watcher on Windows.
    '**/artifacts/**',
];

let sqliteDb: DatabaseSync | null = null;

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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
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
                    const payload = await readJsonBody(req as IncomingMessage);
                    const symbol = String(payload.symbol || '').trim().toUpperCase();
                    const interval = String(payload.interval || '').trim().toLowerCase();
                    const provider = String(payload.provider || 'unknown');
                    const source = String(payload.source || 'manual');
                    const rawCandles = Array.isArray(payload.candles) ? payload.candles : [];

                    if (!symbol || !interval) {
                        sendJson(res, 400, { ok: false, error: 'symbol and interval are required' });
                        return;
                    }
                    if (rawCandles.length === 0) {
                        sendJson(res, 400, { ok: false, error: 'candles array is required' });
                        return;
                    }

                    const candles = rawCandles
                        .map(normalizeSqliteCandle)
                        .filter((row): row is SqliteCandleRow => !!row);
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

import { backtestEndpointPlugin } from './lib/backtest-endpoint-plugin';

export default defineConfig({
    plugins: [tradFiKlineProxyPlugin(), polymarketProxyPlugin(), localSqlitePlugin(), backtestEndpointPlugin()],
    server: {
        fs: {
            allow: ['../../..']
        },
        watch: {
            ignored: WATCH_IGNORED_GLOBS,
        },
    }
});
