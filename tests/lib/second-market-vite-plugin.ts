import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Plugin } from "vite";
import { encodeBinaryOhlcvRows } from "./ohlcv-binary";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { sendBinary, sendCaughtErrorJson, sendJson } from "./vite-http-utils";

const SECOND_MARKET_DB_PATH = resolve(process.cwd(), "price-data", "1second-chart", "second-market-data.sqlite");
const SECOND_MARKET_SYMBOLS = new Set(["BTCUSDT", "XRPUSDT"]);

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
    const openReadOnlyDb = (): DatabaseSync | null => {
        if (!existsSync(SECOND_MARKET_DB_PATH)) return null;
        return new DatabaseSync(SECOND_MARKET_DB_PATH, { readOnly: true });
    };

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

                    try {
                        const counts = {
                            binance: Number((db.prepare("SELECT COUNT(*) AS count FROM binance_1s_candles").get() as { count?: number }).count) || 0,
                            clob: Number((db.prepare("SELECT COUNT(*) AS count FROM polymarket_clob_1s_quotes").get() as { count?: number }).count) || 0,
                            reference: Number((db.prepare("SELECT COUNT(*) AS count FROM polymarket_reference_1s_prices").get() as { count?: number }).count) || 0,
                            gamma: Number((db.prepare("SELECT COUNT(*) AS count FROM polymarket_gamma_snapshots").get() as { count?: number }).count) || 0,
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

                    try {
                        const candles = explicitStartTs !== null
                            ? db.prepare(`
                                SELECT symbol, market_type, ts, open, high, low, close, volume, trade_count, updated_at
                                FROM binance_1s_candles
                                WHERE symbol = ? AND market_type = ? AND ts >= ? AND ts <= ?
                                ORDER BY ts ASC
                                LIMIT ?
                            `).all(symbol, marketType, explicitStartTs, endTs, limit) as SecondMarketBinanceDbRow[]
                            : (db.prepare(`
                                SELECT symbol, market_type, ts, open, high, low, close, volume, trade_count, updated_at
                                FROM binance_1s_candles
                                WHERE symbol = ? AND market_type = ? AND ts <= ?
                                ORDER BY ts DESC
                                LIMIT ?
                            `).all(symbol, marketType, endTs, limit) as SecondMarketBinanceDbRow[]).reverse();
                        const accept = String(req.headers.accept || "");
                        if (accept.includes("application/octet-stream")) {
                            sendBinary(res, 200, Buffer.from(encodeBinaryOhlcvRows(candles.map((row) => ({
                                time: row.ts,
                                open: row.open,
                                high: row.high,
                                low: row.low,
                                close: row.close,
                                volume: row.volume,
                            })))));
                            return;
                        }
                        const latestDataTs = maxFinite(candles.map((row) => row.ts));
                        sendJson(res, 200, {
                            ok: true,
                            dbPath: SECOND_MARKET_DB_PATH,
                            symbol,
                            marketType,
                            endTs,
                            candles,
                            stats: {
                                latestDataTs,
                                latestLagSec: latestDataTs === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - latestDataTs),
                            },
                        });
                    } finally {
                        db.close();
                    }
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

                    try {
                        const bindings: Array<string | number> = [symbol, startTs, endTs];
                        const seriesFilter = seriesId ? "AND series_id = ?" : "";
                        if (seriesId) bindings.push(seriesId);
                        const quotes = db.prepare(`
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
                            LIMIT 250000
                        `).all(...bindings) as SecondMarketClobDbRow[];
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
                            },
                        });
                    } finally {
                        db.close();
                    }
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

                    try {
                        const bindings: Array<string | number> = [symbol, startTs, endTs];
                        const seriesFilter = seriesId ? "AND series_id = ?" : "";
                        if (seriesId) bindings.push(seriesId);
                        const gammaSnapshots = db.prepare(`
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
                    } finally {
                        db.close();
                    }
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
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
