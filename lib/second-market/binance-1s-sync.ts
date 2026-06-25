import type { DatabaseSync } from "node:sqlite";
import type { BinanceMarketType } from "../binance-market";
import { resolveBinanceApiBases } from "../binance-api-bases";
import { fetchWithTimeoutAndRetry, isAbortError } from "../dataProviders/fetch-helpers";
import { upsertBinance1sCandles, writeSecondDataSyncState } from "./db";
import type { Binance1sCandleRow, SecondMarketSymbol } from "./types";

const BINANCE_SPOT_KLINE_PATH = "/api/v3/klines";
const BINANCE_FUTURES_AGG_TRADES_PATH = "/fapi/v1/aggTrades";
const BINANCE_1S_LIMIT = 1000;
const BINANCE_1S_FETCH_TIMEOUT_MS = 15_000;
const BINANCE_1S_MAX_ATTEMPTS = 3;
const BINANCE_1S_RETRY_DELAY_MS = 250;
const MAX_MISSING_SEGMENTS_BEFORE_FULL_FETCH = 25;

type RawBinanceKline = unknown[];
type RawFuturesAggTrade = Record<string, unknown>;
type NormalizedFuturesAggTrade = {
    aggregateId: number;
    tsMs: number;
    price: number;
    quantity: number;
    tradeCount: number;
};

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function normalizeClosedLagSec(value: number | undefined): number {
    const numeric = Number(value ?? 2);
    return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : 2;
}

function getBinanceApiBase(marketType: BinanceMarketType): string {
    return resolveBinanceApiBases(marketType)[0] ?? (
        marketType === "futures" ? "https://fapi.binance.com" : "https://api.binance.com"
    );
}

async function fetchBinanceJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchWithTimeoutAndRetry(url, {}, {
        signal,
        timeoutMs: BINANCE_1S_FETCH_TIMEOUT_MS,
        maxAttempts: BINANCE_1S_MAX_ATTEMPTS,
        baseDelayMs: BINANCE_1S_RETRY_DELAY_MS,
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
}

function toFiniteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeKline(
    symbol: SecondMarketSymbol,
    marketType: BinanceMarketType,
    row: RawBinanceKline,
    updatedAt: number
): Binance1sCandleRow | null {
    if (!Array.isArray(row) || row.length < 6) return null;
    const openMs = toFiniteNumber(row[0]);
    const open = toFiniteNumber(row[1]);
    const high = toFiniteNumber(row[2]);
    const low = toFiniteNumber(row[3]);
    const close = toFiniteNumber(row[4]);
    const volume = toFiniteNumber(row[5]);
    if (
        openMs === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        volume === null ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0 ||
        low > high
    ) {
        return null;
    }

    const tradeCount = toFiniteNumber(row[8]);
    return {
        symbol,
        market_type: marketType,
        ts: Math.floor(openMs / 1000),
        open,
        high,
        low,
        close,
        volume,
        trade_count: tradeCount === null ? null : Math.floor(tradeCount),
        source: "binance_1s",
        updated_at: updatedAt,
    };
}

function normalizeFuturesAggTrade(row: unknown): NormalizedFuturesAggTrade | null {
    if (!row || typeof row !== "object") return null;
    const raw = row as RawFuturesAggTrade;
    const aggregateId = toFiniteNumber(raw.a);
    const tsMs = toFiniteNumber(raw.T);
    const price = toFiniteNumber(raw.p);
    const quantity = toFiniteNumber(raw.q);
    if (
        aggregateId === null ||
        tsMs === null ||
        price === null ||
        quantity === null ||
        price <= 0 ||
        quantity < 0
    ) {
        return null;
    }

    const firstTradeId = toFiniteNumber(raw.f);
    const lastTradeId = toFiniteNumber(raw.l);
    const tradeCount = firstTradeId !== null && lastTradeId !== null && lastTradeId >= firstTradeId
        ? Math.max(1, Math.floor(lastTradeId - firstTradeId + 1))
        : 1;

    return {
        aggregateId: Math.floor(aggregateId),
        tsMs,
        price,
        quantity,
        tradeCount,
    };
}

function buildFuturesCandlesFromAggTrades(args: {
    symbol: SecondMarketSymbol;
    trades: readonly NormalizedFuturesAggTrade[];
    startTs: number;
    endTs: number;
    updatedAt: number;
}): Binance1sCandleRow[] {
    const bySecond = new Map<number, {
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        tradeCount: number;
    }>();

    for (const trade of [...args.trades].sort((left, right) => left.tsMs - right.tsMs || left.aggregateId - right.aggregateId)) {
        const ts = Math.floor(trade.tsMs / 1000);
        if (ts < args.startTs || ts > args.endTs) continue;
        const bucket = bySecond.get(ts);
        if (!bucket) {
            bySecond.set(ts, {
                open: trade.price,
                high: trade.price,
                low: trade.price,
                close: trade.price,
                volume: trade.quantity,
                tradeCount: trade.tradeCount,
            });
            continue;
        }
        bucket.high = Math.max(bucket.high, trade.price);
        bucket.low = Math.min(bucket.low, trade.price);
        bucket.close = trade.price;
        bucket.volume += trade.quantity;
        bucket.tradeCount += trade.tradeCount;
    }

    const observedSeconds = [...bySecond.keys()].sort((left, right) => left - right);
    const firstObservedTs = observedSeconds[0] ?? null;
    const lastObservedTs = observedSeconds[observedSeconds.length - 1] ?? null;
    if (firstObservedTs === null || lastObservedTs === null) return [];

    const rows: Binance1sCandleRow[] = [];
    let lastClose: number | null = null;
    for (let ts = Math.max(args.startTs, firstObservedTs); ts <= Math.min(args.endTs, lastObservedTs); ts += 1) {
        const bucket = bySecond.get(ts);
        if (bucket) {
            lastClose = bucket.close;
            rows.push({
                symbol: args.symbol,
                market_type: "futures",
                ts,
                open: bucket.open,
                high: bucket.high,
                low: bucket.low,
                close: bucket.close,
                volume: bucket.volume,
                trade_count: bucket.tradeCount,
                source: "binance_1s",
                updated_at: args.updatedAt,
            });
            continue;
        }

        if (lastClose === null) continue;
        rows.push({
            symbol: args.symbol,
            market_type: "futures",
            ts,
            open: lastClose,
            high: lastClose,
            low: lastClose,
            close: lastClose,
            volume: 0,
            trade_count: 0,
            source: "binance_1s_fill",
            updated_at: args.updatedAt,
        });
    }

    return rows;
}

async function fetchBinanceFutures1sCandlesFromAggTrades(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    closedLagSec?: number;
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<Binance1sCandleRow[]> {
    const startTs = Math.max(0, Math.floor(args.startTs));
    const closedLagSec = normalizeClosedLagSec(args.closedLagSec);
    const closedEndTs = Math.min(Math.floor(args.endTs), nowSec() - closedLagSec);
    if (closedEndTs < startTs) return [];

    const trades: NormalizedFuturesAggTrade[] = [];
    let cursorMs = startTs * 1000;
    const endMs = (closedEndTs * 1000) + 999;
    let fromId: number | null = null;
    let requestCount = 0;

    while (cursorMs <= endMs) {
        if (args.signal?.aborted) break;
        const url = new URL(`${getBinanceApiBase("futures")}${BINANCE_FUTURES_AGG_TRADES_PATH}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("limit", String(BINANCE_1S_LIMIT));
        if (fromId === null) {
            url.searchParams.set("startTime", String(cursorMs));
            url.searchParams.set("endTime", String(endMs));
        } else {
            url.searchParams.set("fromId", String(fromId));
        }

        const payload = await fetchBinanceJson(url, args.signal).catch((error) => {
            if (isAbortError(error)) throw error;
            throw new Error(`Binance futures aggTrades fetch failed for ${args.symbol}: ${error instanceof Error ? error.message : String(error)}`);
        });
        const rawRows = Array.isArray(payload) ? payload : [];
        if (rawRows.length === 0) break;

        const batch = rawRows
            .map(normalizeFuturesAggTrade)
            .filter((row): row is NormalizedFuturesAggTrade => row !== null);
        for (const trade of batch) {
            if (trade.tsMs >= startTs * 1000 && trade.tsMs <= endMs) {
                trades.push(trade);
            }
        }

        const lastTrade = batch[batch.length - 1];
        if (!lastTrade) break;
        requestCount += 1;
        cursorMs = lastTrade.tsMs + 1;
        fromId = lastTrade.aggregateId + 1;
        const firstInRangeTrade = trades[0] ?? null;
        const lastInRangeTrade = trades[trades.length - 1] ?? null;
        const fetchedCandles = firstInRangeTrade && lastInRangeTrade
            ? Math.max(
                0,
                Math.min(closedEndTs, Math.floor(lastInRangeTrade.tsMs / 1000)) - Math.floor(firstInRangeTrade.tsMs / 1000) + 1
            )
            : 0;
        args.onProgress?.({
            fetched: fetchedCandles,
            cursorTs: Math.floor(cursorMs / 1000),
            requestCount,
        });
        if (lastTrade.tsMs > endMs || rawRows.length < BINANCE_1S_LIMIT) break;
        if (args.requestDelayMs && args.requestDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, args.requestDelayMs));
        }
    }

    return buildFuturesCandlesFromAggTrades({
        symbol: args.symbol,
        trades,
        startTs,
        endTs: closedEndTs,
        updatedAt: nowSec(),
    });
}

export async function fetchBinance1sCandles(args: {
    symbol: SecondMarketSymbol;
    marketType?: BinanceMarketType;
    startTs: number;
    endTs: number;
    closedLagSec?: number;
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<Binance1sCandleRow[]> {
    const marketType = args.marketType ?? "spot";
    if (marketType === "futures") {
        return fetchBinanceFutures1sCandlesFromAggTrades(args);
    }

    const startTs = Math.max(0, Math.floor(args.startTs));
    const closedLagSec = normalizeClosedLagSec(args.closedLagSec);
    const closedEndTs = Math.min(Math.floor(args.endTs), nowSec() - closedLagSec);
    if (closedEndTs < startTs) return [];

    const rows: Binance1sCandleRow[] = [];
    let cursorMs = startTs * 1000;
    const endMs = closedEndTs * 1000;
    let requestCount = 0;

    while (cursorMs <= endMs) {
        if (args.signal?.aborted) break;
        const url = new URL(`${getBinanceApiBase("spot")}${BINANCE_SPOT_KLINE_PATH}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("interval", "1s");
        url.searchParams.set("startTime", String(cursorMs));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", String(BINANCE_1S_LIMIT));

        const payload = await fetchBinanceJson(url, args.signal).catch((error) => {
            if (isAbortError(error)) throw error;
            throw new Error(`Binance 1s fetch failed for ${args.symbol}: ${error instanceof Error ? error.message : String(error)}`);
        });
        const rawRows = Array.isArray(payload) ? payload as RawBinanceKline[] : [];
        if (rawRows.length === 0) break;

        const updatedAt = nowSec();
        const batch = rawRows
            .map((row) => normalizeKline(args.symbol, marketType, row, updatedAt))
            .filter((row): row is Binance1sCandleRow => row !== null)
            .filter((row) => row.ts >= startTs && row.ts <= closedEndTs);
        rows.push(...batch);

        const lastOpenMs = toFiniteNumber(rawRows[rawRows.length - 1]?.[0]);
        if (lastOpenMs === null) break;
        const nextCursorMs = lastOpenMs + 1000;
        requestCount += 1;
        args.onProgress?.({
            fetched: rows.length,
            cursorTs: Math.floor(nextCursorMs / 1000),
            requestCount,
        });
        if (nextCursorMs <= cursorMs || rawRows.length < BINANCE_1S_LIMIT) break;
        cursorMs = nextCursorMs;
        if (args.requestDelayMs && args.requestDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, args.requestDelayMs));
        }
    }

    return rows.sort((left, right) => left.ts - right.ts);
}

function findMissingBinance1sRanges(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType: BinanceMarketType;
    startTs: number;
    endTs: number;
}): Array<{ startTs: number; endTs: number }> {
    const startTs = Math.max(0, Math.floor(args.startTs));
    const endTs = Math.max(startTs, Math.floor(args.endTs));
    const expectedCount = endTs - startTs + 1;
    const summary = db.prepare(`
        SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs
        FROM binance_1s_candles
        WHERE symbol = ? AND market_type = ? AND ts BETWEEN ? AND ?
    `).get(args.symbol, args.marketType, startTs, endTs) as {
        count?: number;
        firstTs?: number | null;
        lastTs?: number | null;
    };
    if (
        Number(summary.count) === expectedCount &&
        Number(summary.firstTs) === startTs &&
        Number(summary.lastTs) === endTs
    ) {
        return [];
    }

    const rows = db.prepare(`
        SELECT ts
        FROM binance_1s_candles
        WHERE symbol = ? AND market_type = ? AND ts BETWEEN ? AND ?
        ORDER BY ts ASC
    `).all(args.symbol, args.marketType, startTs, endTs) as Array<{ ts?: number }>;

    const ranges: Array<{ startTs: number; endTs: number }> = [];
    let cursor = startTs;
    for (const row of rows) {
        const ts = Number(row.ts);
        if (!Number.isFinite(ts) || ts < cursor) continue;
        if (ts > cursor) {
            ranges.push({ startTs: cursor, endTs: ts - 1 });
        }
        cursor = ts + 1;
    }
    if (cursor <= endTs) {
        ranges.push({ startTs: cursor, endTs });
    }
    return ranges;
}

function loadAvailableBinance1sBounds(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType: BinanceMarketType;
    startTs: number;
    endTs: number;
}): { firstTs: number | null; lastTs: number | null } {
    const row = db.prepare(`
        SELECT MIN(ts) AS firstTs, MAX(ts) AS lastTs
        FROM binance_1s_candles
        WHERE symbol = ? AND market_type = ? AND ts BETWEEN ? AND ?
    `).get(args.symbol, args.marketType, Math.floor(args.startTs), Math.floor(args.endTs)) as {
        firstTs?: number | null;
        lastTs?: number | null;
    };
    const firstTs = row.firstTs === null || row.firstTs === undefined ? Number.NaN : Number(row.firstTs);
    const lastTs = row.lastTs === null || row.lastTs === undefined ? Number.NaN : Number(row.lastTs);
    return {
        firstTs: Number.isFinite(firstTs) ? firstTs : null,
        lastTs: Number.isFinite(lastTs) ? lastTs : null,
    };
}

export async function syncBinance1sRange(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType?: BinanceMarketType;
    startTs: number;
    endTs: number;
    closedLagSec?: number;
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<{ fetched: number; upserted: number; firstTs: number | null; lastTs: number | null }> {
    const marketType = args.marketType ?? "spot";
    const startTs = Math.max(0, Math.floor(args.startTs));
    const endTs = Math.max(startTs, Math.floor(args.endTs));
    const missingRanges = findMissingBinance1sRanges(db, {
        symbol: args.symbol,
        marketType,
        startTs,
        endTs,
    });
    if (missingRanges.length === 0) {
        const bounds = loadAvailableBinance1sBounds(db, {
            symbol: args.symbol,
            marketType,
            startTs,
            endTs,
        });
        if (bounds.lastTs !== null) {
            writeSecondDataSyncState(db, {
                source: "binance_1s",
                symbol: args.symbol,
                series_id: marketType,
                cursor_ts: bounds.lastTs,
                cursor_id: "",
                status: "ok",
                updated_at: nowSec(),
            });
        }
        return {
            fetched: 0,
            upserted: 0,
            firstTs: bounds.firstTs,
            lastTs: bounds.lastTs,
        };
    }

    const rangesToFetch = missingRanges.length <= MAX_MISSING_SEGMENTS_BEFORE_FULL_FETCH
        ? missingRanges
        : [{ startTs, endTs }];
    const candles: Binance1sCandleRow[] = [];
    let fetchedSoFar = 0;
    for (const range of rangesToFetch) {
        const rangeCandles = await fetchBinance1sCandles({
            ...args,
            marketType,
            startTs: range.startTs,
            endTs: range.endTs,
            onProgress: args.onProgress
                ? (progress) => {
                    args.onProgress?.({
                        fetched: fetchedSoFar + progress.fetched,
                        cursorTs: progress.cursorTs,
                        requestCount: progress.requestCount,
                    });
                }
                : undefined,
        });
        fetchedSoFar += rangeCandles.length;
        candles.push(...rangeCandles);
    }
    const upserted = upsertBinance1sCandles(db, candles);
    const bounds = loadAvailableBinance1sBounds(db, {
        symbol: args.symbol,
        marketType,
        startTs,
        endTs,
    });
    const firstTs = candles[0]?.ts ?? bounds.firstTs;
    const lastTs = bounds.lastTs;
    if (lastTs !== null) {
        writeSecondDataSyncState(db, {
            source: "binance_1s",
            symbol: args.symbol,
            series_id: marketType,
            cursor_ts: lastTs,
            cursor_id: "",
            status: "ok",
            updated_at: nowSec(),
        });
    }
    return {
        fetched: candles.length,
        upserted,
        firstTs,
        lastTs,
    };
}
