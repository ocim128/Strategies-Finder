import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Plugin } from "vite";
import {
    fetchPolymarketHistoryWithFallback,
    normalizePolymarketHistoryPoints,
    type PolymarketHistoryPoint,
} from "./polymarket-history-client";
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
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
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

const POLYMARKET_PRICE_HISTORY_TIMEOUT_MS = 8000;
// First-run signal-exit scoring can touch many distinct 5m events. Fetch in a
// wider batch so server-side ensure can populate the local cache in one pass.
const POLYMARKET_PRICE_POINT_BATCH_SIZE = 24;
const MAX_POLYMARKET_PRICE_POINT_ENSURE_OUTCOMES = 100;

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
        await fetchPolymarketHistoryWithFallback([`${POLYMARKET_CLOB_HISTORY_URL}?${nearParams.toString()}`], {
            timeoutMs: POLYMARKET_PRICE_HISTORY_TIMEOUT_MS,
        })
    );
    if (nearPoints.length > 0) {
        return nearPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: outcome.yes_token_id,
        interval: 'max',
    });
    return normalizePolymarketHistoryPoints(
        await fetchPolymarketHistoryWithFallback([`${POLYMARKET_CLOB_HISTORY_URL}?${fallbackParams.toString()}`], {
            timeoutMs: POLYMARKET_PRICE_HISTORY_TIMEOUT_MS,
        })
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
    seriesId: string,
    eventStartTs: readonly number[],
): PolymarketPricePointDbRow[] {
    if (eventStartTs.length === 0) {
        return [];
    }

    const placeholders = eventStartTs.map(() => '?').join(',');
    return getPreparedStatement(`
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
    const upsert = getPreparedStatement(`
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
}): Promise<{
    rows: PolymarketPricePointDbRow[];
    upserted: number;
    fetchedEvents: number;
    failedEvents: number;
    missingTokenEvents: number;
}> {
    const eventStartTs = Array.from(new Set(
        args.outcomes
            .map((outcome) => Number(outcome.event_start_ts))
            .filter((value) => Number.isFinite(value))
    )).sort((left, right) => left - right);

    if (eventStartTs.length === 0) {
        return { rows: [], upserted: 0, fetchedEvents: 0, failedEvents: 0, missingTokenEvents: 0 };
    }

    const existingRows = loadStoredPolymarketPricePoints(args.seriesId, eventStartTs);
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
        return { rows: existingRows, upserted: 0, fetchedEvents: 0, failedEvents: 0, missingTokenEvents: 0 };
    }

    const newRows: PolymarketPricePointDbRow[] = [];
    let failedEvents = 0;
    let missingTokenEvents = 0;
    for (let index = 0; index < uncoveredOutcomes.length; index += POLYMARKET_PRICE_POINT_BATCH_SIZE) {
        const batch = uncoveredOutcomes.slice(index, index + POLYMARKET_PRICE_POINT_BATCH_SIZE);
        const batchRows = await Promise.all(batch.map(async (outcome) => {
            if (!outcome.yes_token_id) {
                missingTokenEvents++;
                return [];
            }
            try {
                return await fetchPolymarketPricePointsForOutcome(outcome, args.seriesId);
            } catch {
                failedEvents++;
                return [];
            }
        }));
        for (const rows of batchRows) {
            newRows.push(...rows);
        }
    }

    const upserted = storePolymarketPricePointsInDb(args.db, newRows);
    return {
        rows: loadStoredPolymarketPricePoints(args.seriesId, eventStartTs),
        upserted,
        fetchedEvents: uncoveredOutcomes.length,
        failedEvents,
        missingTokenEvents,
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
        CREATE TABLE IF NOT EXISTS mine_timing_runs (
            run_id TEXT NOT NULL PRIMARY KEY,
            created_at INTEGER NOT NULL,
            interval TEXT NOT NULL,
            strategy_key TEXT NOT NULL,
            source TEXT NOT NULL,
            pair_count INTEGER NOT NULL,
            reruns INTEGER NOT NULL DEFAULT 0,
            subset_size INTEGER NOT NULL DEFAULT 0,
            seed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mine_timing_verdicts (
            run_id TEXT NOT NULL,
            run_created_at INTEGER NOT NULL,
            interval TEXT NOT NULL,
            asset TEXT NOT NULL,
            verdict TEXT NOT NULL,
            direction TEXT,
            confidence TEXT NOT NULL,
            timing_edge_score REAL NOT NULL DEFAULT 0,
            median_diversity REAL NOT NULL DEFAULT 0,
            dominant_pair TEXT,
            dominant_pair_share REAL NOT NULL DEFAULT 0,
            close REAL,
            median_bars_held REAL,
            agreement_transition REAL,
            as_of_time_key TEXT,
            horizon_bars INTEGER,
            longest_horizon_bars INTEGER,
            expected_forward_return_pct REAL,
            oos_lift_pct REAL,
            longest_oos_forward_return_pct REAL,
            expected_mfe_pct REAL,
            expected_mae_pct REAL,
            median_lift_pct REAL,
            median_rr REAL,
            median_hmax_lift_pct REAL,
            median_dist REAL,
            analog_count INTEGER,
            candidate_count INTEGER,
            pair_warnings INTEGER NOT NULL DEFAULT 0,
            hits INTEGER NOT NULL DEFAULT 0,
            high INTEGER NOT NULL DEFAULT 0,
            medium INTEGER NOT NULL DEFAULT 0,
            low INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(run_id, asset, verdict)
        );
        CREATE INDEX IF NOT EXISTS idx_mt_verdicts_asset_time
            ON mine_timing_verdicts(asset, run_created_at);
        CREATE INDEX IF NOT EXISTS idx_mt_runs_created
            ON mine_timing_runs(created_at);
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

                if (method === 'GET' && path === '/load-polymarket-outcomes') {
                    const seriesId = (requestUrl.searchParams.get('seriesId') || '').trim();
                    const startTsRaw = requestUrl.searchParams.get('startTs');
                    const endTsRaw = requestUrl.searchParams.get('endTs');
                    const limitRaw = requestUrl.searchParams.get('limit');
                    const afterStartTsRaw = requestUrl.searchParams.get('afterStartTs');
                    const afterEventSlug = (requestUrl.searchParams.get('afterEventSlug') || '').trim();

                    const startTs = startTsRaw !== null ? Number(startTsRaw) : null;
                    const endTs = endTsRaw !== null ? Number(endTsRaw) : null;
                    const limit = limitRaw !== null ? Math.max(1, Math.min(100000, Math.floor(Number(limitRaw) || 10000))) : 10000;
                    const afterStartTs = afterStartTsRaw !== null ? Number(afterStartTsRaw) : null;

                    if (startTs !== null && !Number.isFinite(startTs)) {
                        sendJson(res, 400, { ok: false, error: 'startTs must be a finite number' });
                        return;
                    }
                    if (endTs !== null && !Number.isFinite(endTs)) {
                        sendJson(res, 400, { ok: false, error: 'endTs must be a finite number' });
                        return;
                    }
                    if (afterStartTs !== null && !Number.isFinite(afterStartTs)) {
                        sendJson(res, 400, { ok: false, error: 'afterStartTs must be a finite number' });
                        return;
                    }
                    if (afterStartTs !== null && !seriesId) {
                        sendJson(res, 400, { ok: false, error: 'seriesId is required when using pagination cursor' });
                        return;
                    }

                    const conditions: string[] = [];
                    const bindings: (string | number)[] = [];

                    if (seriesId) { conditions.push('series_id = ?'); bindings.push(seriesId); }
                    if (startTs !== null) { conditions.push('event_start_ts >= ?'); bindings.push(Math.floor(startTs)); }
                    if (endTs !== null) { conditions.push('event_start_ts <= ?'); bindings.push(Math.floor(endTs)); }
                    if (afterStartTs !== null) {
                        conditions.push('(event_start_ts > ? OR (event_start_ts = ? AND event_slug > ?))');
                        bindings.push(Math.floor(afterStartTs), Math.floor(afterStartTs), afterEventSlug);
                    }

                    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
                    const queryLimit = limit + 1;
                    bindings.push(queryLimit);

                    const queryRows = getPreparedStatement(`
                        SELECT series_id, event_slug, market_slug, interval,
                               event_start_ts, event_end_ts, yes_token_id, no_token_id,
                               yes_open_price, yes_entry_minute_1_price, yes_entry_minute_2_price,
                               yes_entry_minute_3_price, yes_entry_minute_4_price,
                               resolved_outcome_up, resolution_source, updated_at
                        FROM polymarket_outcomes
                        ${where}
                        ORDER BY event_start_ts ASC, event_slug ASC
                        LIMIT ?
                    `).all(...bindings) as PolymarketOutcomeDbRow[];
                    const truncated = queryRows.length > limit;
                    const rows = truncated ? queryRows.slice(0, limit) : queryRows;
                    const lastRow = truncated ? rows[rows.length - 1] : null;

                    sendJson(res, 200, {
                        ok: true,
                        rows,
                        count: rows.length,
                        limit,
                        truncated,
                        nextAfterStartTs: lastRow?.event_start_ts,
                        nextAfterEventSlug: lastRow?.event_slug,
                    });
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

                    const upsert = getPreparedStatement(`
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
                    if (rawOutcomes.length > MAX_POLYMARKET_PRICE_POINT_ENSURE_OUTCOMES) {
                        sendJson(res, 413, {
                            ok: false,
                            error: `Too many outcomes. Maximum is ${MAX_POLYMARKET_PRICE_POINT_ENSURE_OUTCOMES} per request.`,
                        });
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
                        failedEvents: ensured.failedEvents,
                        missingTokenEvents: ensured.missingTokenEvents,
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
                    if (startTs !== null && !Number.isFinite(startTs)) {
                        sendJson(res, 400, { ok: false, error: 'startTs must be a finite number' });
                        return;
                    }
                    if (endTs !== null && !Number.isFinite(endTs)) {
                        sendJson(res, 400, { ok: false, error: 'endTs must be a finite number' });
                        return;
                    }
                    if (limitRaw !== null && !Number.isFinite(Number(limitRaw))) {
                        sendJson(res, 400, { ok: false, error: 'limit must be a finite number' });
                        return;
                    }

                    const conditions: string[] = ['series_id = ?'];
                    const bindings: (string | number)[] = [seriesId];

                    if (eventStartTsRaw !== null) {
                        const rawParts = eventStartTsRaw.split(',').map(s => s.trim()).filter(Boolean);
                        const parts = rawParts.map(s => Number(s));
                        if (rawParts.length === 0 || parts.some(n => !Number.isFinite(n))) {
                            sendJson(res, 400, { ok: false, error: 'eventStartTs must be comma-separated finite numbers' });
                            return;
                        }
                        if (parts.length > 0) {
                            const placeholders = parts.map(() => '?').join(',');
                            conditions.push(`event_start_ts IN (${placeholders})`);
                            bindings.push(...parts);
                        }
                    }
                    if (startTs !== null) {
                        conditions.push('ts >= ?');
                        bindings.push(Math.floor(startTs));
                    }
                    if (endTs !== null) {
                        conditions.push('ts <= ?');
                        bindings.push(Math.floor(endTs));
                    }

                    const where = `WHERE ${conditions.join(' AND ')}`;
                    bindings.push(limit);

                    const rows = getPreparedStatement(`
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

                    const upsert = getPreparedStatement(`
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

                if (method === 'POST' && path === '/store-mine-timing') {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const runId = String(payload?.runId || '').trim();
                    const createdAt = Number(payload?.createdAt) || 0;
                    const interval = String(payload?.interval || '').trim().toLowerCase();
                    const strategyKey = String(payload?.strategyKey || '').trim();
                    const sourceRaw = String(payload?.source || '').trim().toLowerCase();
                    const source = sourceRaw === 'stability' ? 'stability' : 'mine';
                    const pairCount = Math.max(0, Math.floor(Number(payload?.pairCount) || 0));
                    const reruns = Math.max(0, Math.floor(Number(payload?.reruns) || 0));
                    const subsetSize = Math.max(0, Math.floor(Number(payload?.subsetSize) || 0));
                    const seed = Math.max(0, Math.floor(Number(payload?.seed) || 0));
                    const verdicts = Array.isArray(payload?.verdicts) ? payload.verdicts : [];

                    if (!runId || !interval) {
                        sendJson(res, 400, { ok: false, error: 'runId and interval are required' });
                        return;
                    }

                    const db = getSqliteDb();

                    db.exec('BEGIN');
                    try {
                        getPreparedStatement(`
                            INSERT INTO mine_timing_runs (run_id, created_at, interval, strategy_key, source, pair_count, reruns, subset_size, seed)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(run_id) DO UPDATE SET
                                created_at = excluded.created_at,
                                interval = excluded.interval,
                                strategy_key = excluded.strategy_key,
                                source = excluded.source,
                                pair_count = excluded.pair_count,
                                reruns = excluded.reruns,
                                subset_size = excluded.subset_size,
                                seed = excluded.seed
                        `).run(runId, createdAt, interval, strategyKey, source, pairCount, reruns, subsetSize, seed);

                        const verdictUpsert = getPreparedStatement(`
                            INSERT INTO mine_timing_verdicts (
                                run_id, run_created_at, interval, asset, verdict, direction, confidence,
                                timing_edge_score, median_diversity, dominant_pair, dominant_pair_share,
                                close, median_bars_held, agreement_transition, as_of_time_key,
                                horizon_bars, longest_horizon_bars,
                                expected_forward_return_pct, oos_lift_pct, longest_oos_forward_return_pct,
                                expected_mfe_pct, expected_mae_pct,
                                median_lift_pct, median_rr, median_hmax_lift_pct, median_dist,
                                analog_count, candidate_count, pair_warnings, hits, high, medium, low
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(run_id, asset, verdict) DO UPDATE SET
                                run_created_at = excluded.run_created_at,
                                direction = excluded.direction,
                                confidence = excluded.confidence,
                                timing_edge_score = excluded.timing_edge_score,
                                median_diversity = excluded.median_diversity,
                                dominant_pair = excluded.dominant_pair,
                                dominant_pair_share = excluded.dominant_pair_share,
                                close = excluded.close,
                                median_bars_held = excluded.median_bars_held,
                                agreement_transition = excluded.agreement_transition,
                                as_of_time_key = excluded.as_of_time_key,
                                horizon_bars = excluded.horizon_bars,
                                longest_horizon_bars = excluded.longest_horizon_bars,
                                expected_forward_return_pct = excluded.expected_forward_return_pct,
                                oos_lift_pct = excluded.oos_lift_pct,
                                longest_oos_forward_return_pct = excluded.longest_oos_forward_return_pct,
                                expected_mfe_pct = excluded.expected_mfe_pct,
                                expected_mae_pct = excluded.expected_mae_pct,
                                median_lift_pct = excluded.median_lift_pct,
                                median_rr = excluded.median_rr,
                                median_hmax_lift_pct = excluded.median_hmax_lift_pct,
                                median_dist = excluded.median_dist,
                                analog_count = excluded.analog_count,
                                candidate_count = excluded.candidate_count,
                                pair_warnings = excluded.pair_warnings,
                                hits = excluded.hits,
                                high = excluded.high,
                                medium = excluded.medium,
                                low = excluded.low
                        `);

                        for (const v of verdicts) {
                            const direction = v?.direction === null ? null : String(v?.direction || '').trim().toLowerCase() || null;
                            verdictUpsert.run(
                                runId, createdAt, interval,
                                String(v?.asset || '').trim().toUpperCase(),
                                String(v?.verdict || '').trim().toUpperCase(),
                                direction,
                                String(v?.confidence || 'low').trim().toLowerCase(),
                                Number(v?.timingEdgeScore) || 0,
                                Number(v?.medianDiversity) || 0,
                                v?.dominantPair ? String(v.dominantPair).trim().toUpperCase() : null,
                                Number(v?.dominantPairShare) || 0,
                                v?.close === null || v?.close === undefined ? null : Number(v.close),
                                v?.medianBarsHeld === null || v?.medianBarsHeld === undefined ? null : Number(v.medianBarsHeld),
                                v?.agreementTransition === null || v?.agreementTransition === undefined ? null : Number(v.agreementTransition),
                                v?.asOfTimeKey ? String(v.asOfTimeKey) : null,
                                v?.horizonBars === null || v?.horizonBars === undefined ? null : Math.max(0, Math.floor(Number(v.horizonBars))),
                                v?.longestHorizonBars === null || v?.longestHorizonBars === undefined ? null : Math.max(0, Math.floor(Number(v.longestHorizonBars))),
                                v?.expectedForwardReturnPct === null || v?.expectedForwardReturnPct === undefined ? null : Number(v.expectedForwardReturnPct),
                                v?.oosLiftPct === null || v?.oosLiftPct === undefined ? null : Number(v.oosLiftPct),
                                v?.longestOosForwardReturnPct === null || v?.longestOosForwardReturnPct === undefined ? null : Number(v.longestOosForwardReturnPct),
                                v?.expectedMfePct === null || v?.expectedMfePct === undefined ? null : Number(v.expectedMfePct),
                                v?.expectedMaePct === null || v?.expectedMaePct === undefined ? null : Number(v.expectedMaePct),
                                v?.medianLiftPct === null || v?.medianLiftPct === undefined ? null : Number(v.medianLiftPct),
                                v?.medianRr === null || v?.medianRr === undefined ? null : Number(v.medianRr),
                                v?.medianHmaxLiftPct === null || v?.medianHmaxLiftPct === undefined ? null : Number(v.medianHmaxLiftPct),
                                v?.medianDist === null || v?.medianDist === undefined ? null : Number(v.medianDist),
                                v?.analogCount === null || v?.analogCount === undefined ? null : Math.max(0, Math.floor(Number(v.analogCount))),
                                v?.candidateCount === null || v?.candidateCount === undefined ? null : Math.max(0, Math.floor(Number(v.candidateCount))),
                                Math.max(0, Math.floor(Number(v?.pairWarnings) || 0)),
                                Math.max(0, Math.floor(Number(v?.hits) || 0)),
                                Math.max(0, Math.floor(Number(v?.high) || 0)),
                                Math.max(0, Math.floor(Number(v?.medium) || 0)),
                                Math.max(0, Math.floor(Number(v?.low) || 0)),
                            );
                        }

                        db.exec('COMMIT');
                    } catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }

                    sendJson(res, 200, { ok: true, runId, verdictsStored: verdicts.length });
                    return;
                }

                if (method === 'GET' && path === '/load-mine-timing') {
                    const limit = Math.max(1, Math.min(200, Math.floor(Number(requestUrl.searchParams.get('limit')) || 50)));
                    const runRows = getPreparedStatement(`
                        SELECT run_id, created_at, interval, strategy_key, source, pair_count, reruns, subset_size, seed
                        FROM mine_timing_runs
                        ORDER BY created_at DESC
                        LIMIT ?
                    `).all(limit) as Array<{
                        run_id: string;
                        created_at: number;
                        interval: string;
                        strategy_key: string;
                        source: string;
                        pair_count: number;
                        reruns: number;
                        subset_size: number;
                        seed: number;
                    }>;
                    const runIds = runRows.map((row) => row.run_id);
                    const verdictsByRun = new Map<string, unknown[]>();
                    if (runIds.length > 0) {
                        // node:sqlite's prepared statements do not accept arrays
                        // directly; use IN(...) with positional placeholders.
                        const placeholders = runIds.map(() => '?').join(',');
                        const verdictRows = getPreparedStatement(`
                            SELECT * FROM mine_timing_verdicts
                            WHERE run_id IN (${placeholders})
                        `).all(...runIds) as Array<Record<string, unknown>>;
                        for (const row of verdictRows) {
                            const list = verdictsByRun.get(String(row.run_id)) ?? [];
                            list.push(row);
                            verdictsByRun.set(String(row.run_id), list);
                        }
                    }
                    const runs = runRows
                        .map((row) => ({
                            runId: row.run_id,
                            createdAt: row.created_at,
                            interval: row.interval,
                            strategyKey: row.strategy_key,
                            source: row.source,
                            pairCount: row.pair_count,
                            reruns: row.reruns,
                            subsetSize: row.subset_size,
                            seed: row.seed,
                            verdicts: (verdictsByRun.get(row.run_id) ?? []).map((v) => normalizeMineTimingVerdictRow(v as Record<string, unknown>)),
                        }))
                        .reverse();

                    sendJson(res, 200, { ok: true, runs });
                    return;
                }

                if (method === 'POST' && path === '/clear-mine-timing') {
                    const db = getSqliteDb();
                    db.exec('BEGIN');
                    try {
                        db.exec('DELETE FROM mine_timing_verdicts');
                        db.exec('DELETE FROM mine_timing_runs');
                        db.exec('COMMIT');
                    } catch (error) {
                        db.exec('ROLLBACK');
                        throw error;
                    }
                    sendJson(res, 200, { ok: true });
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
 * Map a snake_case `mine_timing_verdicts` row to the camelCase shape the
 * browser-side `TimingEdgeVerdictSnapshot` expects. Lives here (next to the
 * route that produces the rows) instead of in a shared module so the plugin
 * stays self-contained and doesn't import from browser-bound code (per
 * AGENTS.md "Server-side import hygiene").
 */
function normalizeMineTimingVerdictRow(row: Record<string, unknown>) {
    const num = (key: string): number | null => {
        const value = row[key];
        // Guard NULL/undefined BEFORE Number(): `Number(null) === 0` (finite),
        // which would collapse a SQL NULL to 0 on the load path and silently
        // break the null-sentinel contract on `TimingEdgeVerdictSnapshot`
        // (downstream `??` fallbacks and `!== null` checks would mis-fire).
        if (value === null || value === undefined) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    const int = (key: string): number => Math.max(0, Math.floor(Number(row[key]) || 0));
    const str = (key: string): string | null => {
        const value = row[key];
        return typeof value === 'string' && value ? value : null;
    };
    return {
        asset: String(row.asset ?? '').trim().toUpperCase(),
        verdict: String(row.verdict ?? '').trim().toUpperCase(),
        direction: typeof row.direction === 'string' ? row.direction : null,
        confidence: String(row.confidence ?? 'low').toLowerCase(),
        close: num('close'),
        medianBarsHeld: num('median_bars_held'),
        agreementTransition: num('agreement_transition'),
        asOfTimeKey: str('as_of_time_key'),
        horizonBars: num('horizon_bars'),
        longestHorizonBars: num('longest_horizon_bars'),
        expectedForwardReturnPct: num('expected_forward_return_pct'),
        oosLiftPct: num('oos_lift_pct'),
        longestOosForwardReturnPct: num('longest_oos_forward_return_pct'),
        expectedMfePct: num('expected_mfe_pct'),
        expectedMaePct: num('expected_mae_pct'),
        analogCount: num('analog_count'),
        candidateCount: num('candidate_count'),
        pairWarnings: int('pair_warnings'),
        timingEdgeScore: num('timing_edge_score') ?? 0,
        medianDiversity: num('median_diversity') ?? 0,
        dominantPair: str('dominant_pair'),
        dominantPairShare: num('dominant_pair_share') ?? 0,
        hits: int('hits'),
        high: int('high'),
        medium: int('medium'),
        low: int('low'),
        medianLiftPct: num('median_lift_pct'),
        medianRr: num('median_rr'),
        medianHmaxLiftPct: num('median_hmax_lift_pct'),
        medianDist: num('median_dist'),
    };
}
