import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Plugin } from "vite";
import { encodeBinaryOhlcvRows, type BinaryOhlcvRow } from "./ohlcv-binary";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { sendBinary, sendCaughtErrorJson, sendJson } from "./vite-http-utils";

const SECOND_MARKET_DB_PATH = resolve(process.cwd(), "price-data", "1second-chart", "second-market-data.sqlite");
const SECOND_MARKET_SYMBOLS = new Set(["BTCUSDT", "XRPUSDT"]);
const SECOND_MARKET_CLOB_QUOTE_LIMIT = 250000;

type SecondMarketBinanceDbRow = {
    symbol: string;
    market_type: string;
    // The SQL selects `ts AS time` (see /candles handler) so rows satisfy the
    // binary encoder's `BinaryOhlcvRow` shape without a per-row remap. The
    // JSON branch projects `time` back to `ts` to preserve the wire contract.
    time: number;
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
    condition_id: string;
    market_slug: string;
    yes_token_id: string;
    no_token_id: string;
    sample_ts: number;
    yes_bid: number | null;
    yes_ask: number | null;
    yes_mid: number | null;
    yes_last: number | null;
    no_bid: number | null;
    no_ask: number | null;
    no_mid: number | null;
    no_last: number | null;
    source_ts_ms: number | null;
    quote_age_ms: number | null;
    quality_flags: string;
    updated_at: number;
};

function parseSecondMarketLimit(raw: string | null): number {
    const parsed = Number(raw || "50000");
    if (!Number.isFinite(parsed)) return 50000;
    return Math.max(1, Math.min(200000, Math.floor(parsed)));
}

function parseSecondMarketSymbol(raw: string | null): string {
    const symbol = String(raw || "BTCUSDT").trim().toUpperCase();
    return SECOND_MARKET_SYMBOLS.has(symbol) ? symbol : "BTCUSDT";
}

function distinctCount(values: readonly number[]): number {
    return new Set(values.filter(Number.isFinite)).size;
}

function maxFinite(values: readonly (number | null | undefined)[]): number | null {
    let max: number | null = null;
    for (const value of values) {
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        max = max === null ? value : Math.max(max, value);
    }
    return max;
}

function toUnixSeconds(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
}

export function secondMarketApiPlugin(): Plugin {
    let readDb: DatabaseSync | null = null;
    // Audit Finding (avoidable work in candle reads): `node:sqlite` parses and
    // compiles SQL on every `prepare()` call. The /candles, /clob-quotes, and
    // /gamma-snapshots routes used to recompile their statements per request.
    // Cache them per opened connection and clear the cache when the connection
    // is reset (matching the established local-sqlite-vite-plugin pattern).
    const preparedStatements = new Map<string, StatementSync>();

    const resetReadDb = (): void => {
        preparedStatements.clear();
        readDb?.close();
        readDb = null;
    };

    const openReadOnlyDb = (): DatabaseSync | null => {
        if (!existsSync(SECOND_MARKET_DB_PATH)) {
            resetReadDb();
            return null;
        }
        if (readDb) return readDb;
        try {
            readDb = new DatabaseSync(SECOND_MARKET_DB_PATH, { readOnly: true });
            readDb.exec("PRAGMA busy_timeout = 5000");
            return readDb;
        } catch {
            resetReadDb();
            return null;
        }
    };

    /**
     * Return (and cache) a prepared statement tied to the current read-only
     * connection. The cache is cleared in `resetReadDb` so we never hand out a
     * statement whose connection has been closed.
     */
    function getPreparedStatement(db: DatabaseSync, sql: string): StatementSync {
        let stmt = preparedStatements.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            preparedStatements.set(sql, stmt);
        }
        return stmt;
    }

    const register = (middlewares: any) => {
        middlewares.use("/api/second-market", async (req: any, res: any) => {
            const method = req.method || "GET";
            const requestUrl = new URL(req.url || "/", "http://localhost");
            const path = requestUrl.pathname;

            if (method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }

            try {
                if (path === "/status") {
                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 200, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: "Second-market SQLite DB not found.",
                        });
                        return;
                    }

                    const payload: { ok: true; dbPath: string; counts?: Record<string, number> } = {
                        ok: true,
                        dbPath: SECOND_MARKET_DB_PATH,
                    };
                    if (requestUrl.searchParams.get("includeCount") === "1") {
                        payload.counts = {
                            binance: Number((getPreparedStatement(db, "SELECT COUNT(*) AS count FROM binance_1s_candles").get() as { count?: number }).count) || 0,
                            clob: Number((getPreparedStatement(db, "SELECT COUNT(*) AS count FROM polymarket_clob_1s_quotes").get() as { count?: number }).count) || 0,
                            reference: Number((getPreparedStatement(db, "SELECT COUNT(*) AS count FROM polymarket_reference_1s_prices").get() as { count?: number }).count) || 0,
                            gamma: Number((getPreparedStatement(db, "SELECT COUNT(*) AS count FROM polymarket_gamma_snapshots").get() as { count?: number }).count) || 0,
                        };
                    }
                    sendJson(res, 200, payload);
                    return;
                }

                if (path === "/candles") {
                    const symbol = parseSecondMarketSymbol(requestUrl.searchParams.get("symbol"));
                    const marketType = requestUrl.searchParams.get("marketType") === "futures" ? "futures" : "spot";
                    const limit = parseSecondMarketLimit(requestUrl.searchParams.get("limit"));
                    const explicitStartTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const explicitEndTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    const latestClosedTs = Math.floor(Date.now() / 1000) - 2;
                    const endTs = Math.min(explicitEndTs ?? latestClosedTs, latestClosedTs);

                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 404, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: "Second-market SQLite DB not found.",
                        });
                        return;
                    }

                    // Audit Finding (avoidable work in candle reads): select
                    // `ts AS time` so the binary wire path can hand the rows
                    // straight to `encodeBinaryOhlcvRows` without a per-row
                    // { time, ... } remap (eliminates up to 200,000 short-lived
                    // objects on a max-size request). The JSON wire format
                    // still exposes `ts` (the second-market client maps
                    // `row.ts` → `time`) — that projection happens only in the
                    // JSON branch below.
                    const candles = explicitStartTs !== null
                        ? getPreparedStatement(db, `
                                SELECT symbol, market_type, ts AS time, open, high, low, close, volume, trade_count, updated_at
                                FROM binance_1s_candles
                                WHERE symbol = ? AND market_type = ? AND ts >= ? AND ts <= ?
                                ORDER BY ts ASC
                                LIMIT ?
                            `).all(symbol, marketType, explicitStartTs, endTs, limit) as SecondMarketBinanceDbRow[]
                        : (getPreparedStatement(db, `
                                SELECT symbol, market_type, ts AS time, open, high, low, close, volume, trade_count, updated_at
                                FROM binance_1s_candles
                                WHERE symbol = ? AND market_type = ? AND ts <= ?
                                ORDER BY ts DESC
                                LIMIT ?
                            `).all(symbol, marketType, endTs, limit) as SecondMarketBinanceDbRow[]).reverse();
                    const accept = String(req.headers.accept || "");
                    if (accept.includes("application/octet-stream")) {
                        sendBinary(res, 200, Buffer.from(encodeBinaryOhlcvRows(candles as readonly BinaryOhlcvRow[])));
                        return;
                    }
                    const latestDataTs = maxFinite(candles.map((row) => row.time));
                    sendJson(res, 200, {
                        ok: true,
                        dbPath: SECOND_MARKET_DB_PATH,
                        symbol,
                        marketType,
                        endTs,
                        candles: candles.map((row) => ({ ...row, ts: row.time })),
                        stats: {
                            latestDataTs,
                            latestLagSec: latestDataTs === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - latestDataTs),
                        },
                    });
                    return;
                }

                if (path === "/clob-quotes") {
                    const symbol = parseSecondMarketSymbol(requestUrl.searchParams.get("symbol"));
                    const seriesId = String(requestUrl.searchParams.get("seriesId") || "").trim();
                    const startTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const endTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    if (startTs === null || endTs === null || endTs < startTs) {
                        sendJson(res, 400, { ok: false, error: "Valid startTs and endTs are required." });
                        return;
                    }

                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 404, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: "Second-market SQLite DB not found.",
                        });
                        return;
                    }

                    const bindings: Array<string | number> = [symbol, startTs, endTs];
                    const seriesFilter = seriesId ? "AND series_id = ?" : "";
                    if (seriesId) bindings.push(seriesId);
                    const queryLimit = SECOND_MARKET_CLOB_QUOTE_LIMIT + 1;
                    bindings.push(queryLimit);
                    // The seriesFilter branch produces two distinct SQL strings
                    // (with/without series_id); each is cached on first use.
                    const queryRows = getPreparedStatement(db, `
                            SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts,
                                   condition_id, market_slug, yes_token_id, no_token_id,
                                   sample_ts, yes_bid, yes_ask, yes_mid, yes_last,
                                   no_bid, no_ask, no_mid, no_last,
                                   source, source_ts_ms, quote_age_ms, quality_flags, updated_at
                            FROM polymarket_clob_1s_quotes
                            WHERE symbol = ?
                              AND sample_ts >= ?
                              AND sample_ts <= ?
                              AND event_start_ts <= sample_ts
                              AND event_end_ts > sample_ts
                              ${seriesFilter}
                            ORDER BY sample_ts ASC, updated_at ASC
                            LIMIT ?
                        `).all(...bindings) as SecondMarketClobDbRow[];
                    const truncated = queryRows.length > SECOND_MARKET_CLOB_QUOTE_LIMIT;
                    const quotes = truncated ? queryRows.slice(0, SECOND_MARKET_CLOB_QUOTE_LIMIT) : queryRows;
                    const quoteTimes = quotes.map((row) => row.sample_ts);
                    const requestedSeconds = endTs - startTs + 1;
                    const distinctSeconds = distinctCount(quoteTimes);
                    sendJson(res, 200, {
                        ok: true,
                        dbPath: SECOND_MARKET_DB_PATH,
                        symbol,
                        seriesId: seriesId || null,
                        startTs,
                        endTs,
                        quotes,
                        stats: {
                            distinctSeconds,
                            missingSeconds: Math.max(0, requestedSeconds - distinctSeconds),
                            exactSampleCoveragePct: requestedSeconds > 0 ? (distinctSeconds / requestedSeconds) * 100 : 0,
                            limit: SECOND_MARKET_CLOB_QUOTE_LIMIT,
                            truncated,
                        },
                    });
                    return;
                }

                if (path === "/gamma-snapshots") {
                    const symbol = parseSecondMarketSymbol(requestUrl.searchParams.get("symbol"));
                    const seriesId = String(requestUrl.searchParams.get("seriesId") || "").trim();
                    const startTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const endTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    if (startTs === null || endTs === null || endTs < startTs) {
                        sendJson(res, 400, { ok: false, error: "Valid startTs and endTs are required." });
                        return;
                    }

                    const db = openReadOnlyDb();
                    if (!db) {
                        sendJson(res, 404, {
                            ok: false,
                            dbPath: SECOND_MARKET_DB_PATH,
                            error: "Second-market SQLite DB not found.",
                        });
                        return;
                    }

                    const bindings: Array<string | number> = [symbol, startTs, endTs];
                    const seriesFilter = seriesId ? "AND series_id = ?" : "";
                    if (seriesId) bindings.push(seriesId);
                    const gammaSnapshots = getPreparedStatement(db, `
                            SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts,
                                   snapshot_ts, gamma_yes_price, gamma_no_price
                            FROM polymarket_gamma_snapshots
                            WHERE symbol = ?
                              AND snapshot_ts >= ?
                              AND snapshot_ts <= ?
                              AND event_start_ts <= snapshot_ts
                              AND event_end_ts > snapshot_ts
                              ${seriesFilter}
                            ORDER BY snapshot_ts ASC
                            LIMIT 50000
                        `).all(...bindings);
                    sendJson(res, 200, {
                        ok: true,
                        dbPath: SECOND_MARKET_DB_PATH,
                        symbol,
                        seriesId: seriesId || null,
                        startTs,
                        endTs,
                        gammaSnapshots,
                    });
                    return;
                }

                sendJson(res, 404, { ok: false, error: "Not found" });
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });
    };

    return {
        name: "second-market-api",
        configureServer(server) {
            register(server.middlewares);
            // Audit Finding (avoidable work in candle reads): close the
            // read-only SQLite handle and release cached prepared statements
            // when the dev server shuts down so the process does not hold an
            // open file handle until exit.
            server.httpServer?.on("close", () => {
                resetReadDb();
            });
        },
        configurePreviewServer(server) {
            register(server.middlewares);
            server.httpServer?.on("close", () => {
                resetReadDb();
            });
        },
    };
}
