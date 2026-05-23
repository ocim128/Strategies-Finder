import type { DatabaseSync } from "node:sqlite";
import type { BinanceMarketType } from "../binance-market";
import { upsertBinance1sCandles, writeSecondDataSyncState } from "./db";
import type { Binance1sCandleRow, SecondMarketSymbol } from "./types";

const BINANCE_BASES: Record<BinanceMarketType, string> = {
    spot: "https://api.binance.com",
    futures: "https://fapi.binance.com",
};
const BINANCE_SPOT_KLINE_PATH = "/api/v3/klines";
const BINANCE_FUTURES_AGG_TRADES_PATH = "/fapi/v1/aggTrades";
const BINANCE_1S_LIMIT = 1000;

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
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<Binance1sCandleRow[]> {
    const startTs = Math.max(0, Math.floor(args.startTs));
    const closedEndTs = Math.min(Math.floor(args.endTs), nowSec() - 2);
    if (closedEndTs < startTs) return [];

    const trades: NormalizedFuturesAggTrade[] = [];
    let cursorMs = startTs * 1000;
    const endMs = (closedEndTs * 1000) + 999;
    let fromId: number | null = null;
    let requestCount = 0;

    while (cursorMs <= endMs) {
        if (args.signal?.aborted) break;
        const url = new URL(`${BINANCE_BASES.futures}${BINANCE_FUTURES_AGG_TRADES_PATH}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("limit", String(BINANCE_1S_LIMIT));
        if (fromId === null) {
            url.searchParams.set("startTime", String(cursorMs));
            url.searchParams.set("endTime", String(endMs));
        } else {
            url.searchParams.set("fromId", String(fromId));
        }

        const response = await fetch(url, { signal: args.signal });
        if (!response.ok) {
            throw new Error(`Binance futures aggTrades fetch failed for ${args.symbol}: HTTP ${response.status}`);
        }

        const payload = await response.json() as unknown;
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
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<Binance1sCandleRow[]> {
    const marketType = args.marketType ?? "spot";
    if (marketType === "futures") {
        return fetchBinanceFutures1sCandlesFromAggTrades(args);
    }

    const startTs = Math.max(0, Math.floor(args.startTs));
    const closedEndTs = Math.min(Math.floor(args.endTs), nowSec() - 2);
    if (closedEndTs < startTs) return [];

    const rows: Binance1sCandleRow[] = [];
    let cursorMs = startTs * 1000;
    const endMs = closedEndTs * 1000;
    let requestCount = 0;

    while (cursorMs <= endMs) {
        if (args.signal?.aborted) break;
        const url = new URL(`${BINANCE_BASES.spot}${BINANCE_SPOT_KLINE_PATH}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("interval", "1s");
        url.searchParams.set("startTime", String(cursorMs));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", String(BINANCE_1S_LIMIT));

        const response = await fetch(url, { signal: args.signal });
        if (!response.ok) {
            throw new Error(`Binance 1s fetch failed for ${args.symbol}: HTTP ${response.status}`);
        }

        const payload = await response.json() as unknown;
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

export async function syncBinance1sRange(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType?: BinanceMarketType;
    startTs: number;
    endTs: number;
    requestDelayMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: { fetched: number; cursorTs: number; requestCount: number }) => void;
}): Promise<{ fetched: number; upserted: number; firstTs: number | null; lastTs: number | null }> {
    const marketType = args.marketType ?? "spot";
    const candles = await fetchBinance1sCandles({
        ...args,
        marketType,
    });
    const upserted = upsertBinance1sCandles(db, candles);
    const firstTs = candles[0]?.ts ?? null;
    const lastTs = candles[candles.length - 1]?.ts ?? null;
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
