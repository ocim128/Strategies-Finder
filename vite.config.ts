import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { defineConfig, type Plugin } from 'vite';

const BYBIT_TRADFI_KLINE_URL = 'https://www.bybit.com/x-api/fapi/copymt5/kline';
const SQLITE_DB_PATH = resolve(process.cwd(), 'price-data', 'market-data.sqlite');
const SQLITE_MAX_BODY_BYTES = 80 * 1024 * 1024;

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
    const parsed = Number(raw || '200');
    if (!Number.isFinite(parsed)) return 200;
    return Math.max(1, Math.min(200, Math.floor(parsed)));
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
    plugins: [tradFiKlineProxyPlugin(), localSqlitePlugin()],
    server: {
        fs: {
            allow: ['../../..']
        }
    }
});
