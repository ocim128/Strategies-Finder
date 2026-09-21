import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Plugin } from "vite";
import { parseTimeToUnixSeconds } from "./time-normalization";
import {
    readBodyBuffer,
    readJsonBody,
    sendBinary,
    sendCaughtErrorJson,
    sendJson,
} from "./vite-http-utils";
import { decodeBinaryOhlcvRows, encodeBinaryOhlcvRows } from "./ohlcv-binary";
const SQLITE_DB_PATH = resolve(process.cwd(), 'price-data', 'market-data.sqlite');
let sqliteDb: DatabaseSync | null = null;
// Prepared statements are reused across requests. Keyed by the literal SQL
// string, which is stable per query shape (dynamic `IN (?,?,?)` placeholder
// counts produce distinct keys but still cache when the same count recurs).
// `node:sqlite` parses/compiles SQL on every `prepare()` call; caching the
// compiled statement removes that work from hot read/write paths.
const preparedStatements = new Map<string, StatementSync>();

function getPreparedStatement(sql: string): StatementSync {
    const db = getSqliteDb();
    let stmt = preparedStatements.get(sql);
    if (!stmt) {
        stmt = db.prepare(sql);
        preparedStatements.set(sql, stmt);
    }
    return stmt;
}

type SqliteCandleRow = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

function parseSqliteLimit(raw: string | null): number {
    const parsed = Number(raw || '100000');
    if (!Number.isFinite(parsed)) return 100000;
    return Math.max(1, Math.min(500000, Math.floor(parsed)));
}

export function isTrustedLocalRequest(req: { headers?: Record<string, unknown> }): boolean {
    const origin = (req.headers?.origin || '').toString();
    const referer = (req.headers?.referer || '').toString();
    return origin.startsWith('http://localhost')
        || origin.startsWith('http://127.0.0.1')
        || referer.startsWith('http://localhost')
        || referer.startsWith('http://127.0.0.1');
}

function toUnixSeconds(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
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
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -65536;
        PRAGMA mmap_size = 268435456;
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

function closeSqliteDb(): void {
    // `db.close()` releases all prepared statements held by the connection.
    preparedStatements.clear();
    sqliteDb?.close();
    sqliteDb = null;
}

export function localSqlitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use('/api/sqlite', async (req: any, res: any) => {
            const method = req.method || 'GET';
            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const path = requestUrl.pathname;

            // Optional Bearer-token gate for tunnel exposure. When
            // LOCAL_PROXY_TOKEN is set in the server environment, cross-origin
            // requests (cloudflared tunnel from the Cloudflare Worker) must
            // present a matching Authorization header. Same-origin browser
            // calls from the dev server itself pass through without a token,
            // so the local UI is unaffected.
            const proxyToken = process.env.LOCAL_PROXY_TOKEN?.trim();
            if (proxyToken) {
                if (!isTrustedLocalRequest(req)) {
                    const auth = (req.headers.authorization || '').toString();
                    if (auth !== `Bearer ${proxyToken}`) {
                        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
                        return;
                    }
                }
            }

            try {
                if (method === 'GET' && path === '/status') {
                    getSqliteDb();
                    const payload: { ok: true; dbPath: string; totalCandles?: number } = {
                        ok: true,
                        dbPath: SQLITE_DB_PATH,
                    };
                    if (requestUrl.searchParams.get('includeCount') === '1') {
                        const total = getPreparedStatement('SELECT COUNT(*) AS count FROM candles').get() as { count?: number };
                        payload.totalCandles = Number(total.count) || 0;
                    }
                    sendJson(res, 200, payload);
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

                    const rows = getPreparedStatement(`
                        SELECT time, open, high, low, close, volume
                        FROM candles
                        WHERE symbol = ? AND interval = ?
                        ORDER BY time DESC
                        LIMIT ?
                    `).all(symbol, interval, limit) as SqliteCandleRow[];

                    const accept = req.headers.accept || '';
                    if (accept.includes('application/octet-stream')) {
                        const buffer = Buffer.from(encodeBinaryOhlcvRows(rows.reverse()));
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

                if (method === 'GET' && path === '/series-meta') {
                    // Per-series rollup used as a content fingerprint for
                    // disk-cached synthetic pairs. Returns the row from
                    // `series_meta` if present; `null` fields signal a cold
                    // cache (no data synced yet for this symbol+interval).
                    const symbol = (requestUrl.searchParams.get('symbol') || '').trim().toUpperCase();
                    const interval = (requestUrl.searchParams.get('interval') || '').trim().toLowerCase();
                    if (!symbol || !interval) {
                        sendJson(res, 400, { ok: false, error: 'symbol and interval are required' });
                        return;
                    }
                    getSqliteDb();
                    let row = getPreparedStatement(`
                        SELECT bars_count, first_time, last_time, updated_at
                        FROM series_meta
                        WHERE symbol = ? AND interval = ?
                    `).get(symbol, interval) as
                        | { bars_count?: number; first_time?: number; last_time?: number; updated_at?: number }
                        | undefined;
                    if (!row) {
                        const summary = getPreparedStatement(`
                            SELECT
                                COUNT(*) AS count,
                                MIN(time) AS firstTime,
                                MAX(time) AS lastTime,
                                MAX(updated_at) AS updatedAt,
                                MAX(provider) AS provider
                            FROM candles
                            WHERE symbol = ? AND interval = ?
                        `).get(symbol, interval) as
                            | { count?: number; firstTime?: number; lastTime?: number; updatedAt?: number; provider?: string | null }
                            | undefined;
                        const count = Number(summary?.count ?? 0);
                        if (count > 0) {
                            const nowSec = Math.floor(Date.now() / 1000);
                            getPreparedStatement(`
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
                                typeof summary?.provider === 'string' ? summary.provider : null,
                                count,
                                Number(summary?.firstTime) || null,
                                Number(summary?.lastTime) || null,
                                Number(summary?.updatedAt) || nowSec
                            );
                            row = {
                                bars_count: count,
                                first_time: Number(summary?.firstTime) || undefined,
                                last_time: Number(summary?.lastTime) || undefined,
                                updated_at: Number(summary?.updatedAt) || nowSec,
                            };
                        }
                    }
                    sendJson(res, 200, {
                        ok: true,
                        symbol,
                        interval,
                        barsCount: row?.bars_count != null ? Number(row.bars_count) : null,
                        firstTime: row?.first_time != null ? Number(row.first_time) : null,
                        lastTime: row?.last_time != null ? Number(row.last_time) : null,
                        updatedAt: row?.updated_at != null ? Number(row.updated_at) : null,
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
                    let includeSummary = requestUrl.searchParams.get('summary') === '1';

                    if (isBinary) {
                        symbol = (requestUrl.searchParams.get('symbol') || '').trim().toUpperCase();
                        interval = (requestUrl.searchParams.get('interval') || '').trim().toLowerCase();
                        provider = requestUrl.searchParams.get('provider') || 'unknown';
                        source = requestUrl.searchParams.get('source') || 'manual';

                        const buffer = await readBodyBuffer(req as IncomingMessage);
                        const decoded = decodeBinaryOhlcvRows(buffer);
                        if (!decoded) {
                            sendJson(res, 400, { ok: false, error: 'Invalid binary payload' });
                            return;
                        }
                        // The binary wire format stores unix-second numeric time values.
                        candles = decoded as unknown as SqliteCandleRow[];
                    } else {
                        const payload = await readJsonBody(req as IncomingMessage);
                        symbol = String(payload.symbol || '').trim().toUpperCase();
                        interval = String(payload.interval || '').trim().toLowerCase();
                        provider = String(payload.provider || 'unknown');
                        source = String(payload.source || 'manual');
                        includeSummary = includeSummary || payload.summary === true;
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
                    const upsert = getPreparedStatement(`
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

                    const payload: {
                        ok: true;
                        symbol: string;
                        interval: string;
                        upserted: number;
                        totalBars?: number;
                        firstTime?: number | null;
                        lastTime?: number | null;
                        dbPath: string;
                    } = {
                        ok: true,
                        symbol,
                        interval,
                        upserted: candles.length,
                        dbPath: SQLITE_DB_PATH,
                    };

                    if (includeSummary) {
                        const summary = getPreparedStatement(`
                            SELECT
                                COUNT(*) AS count,
                                MIN(time) AS firstTime,
                                MAX(time) AS lastTime
                            FROM candles
                            WHERE symbol = ? AND interval = ?
                        `).get(symbol, interval) as { count?: number; firstTime?: number; lastTime?: number };

                        getPreparedStatement(`
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

                        payload.totalBars = Number(summary.count) || 0;
                        payload.firstTime = Number(summary.firstTime) || null;
                        payload.lastTime = Number(summary.lastTime) || null;
                    }

                    sendJson(res, 200, payload);
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
                sendCaughtErrorJson(res, error);
            }
        });
    };

    return {
        name: 'local-sqlite-api',
        configureServer(server) {
            register(server.middlewares);
            server.httpServer?.once('close', closeSqliteDb);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
            server.httpServer?.once('close', closeSqliteDb);
        },
    };
}

/**
 * Test-only seam. The DB helpers resolve the DB through `getSqliteDb`, so a
 * test injects a temp DB here. Mirrors the `__testInternals` pattern in
 * `batch-backtest-vite-plugin.ts`.
 */
export const __testInternals = {
    setSqliteDbForTests(db: DatabaseSync): void {
        preparedStatements.clear();
        sqliteDb = db;
    },
    resetSqliteDbForTests(): void {
        preparedStatements.clear();
        sqliteDb = null;
    },
};

