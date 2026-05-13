import type { DatabaseSync } from "node:sqlite";
import type { BinanceMarketType } from "../binance-market";
import { upsertBinance1sCandles, writeSecondDataSyncState } from "./db";
import type { Binance1sCandleRow, SecondMarketSymbol } from "./types";

const BINANCE_BASES: Record<BinanceMarketType, string> = {
    spot: "https://api.binance.com",
    futures: "https://fapi.binance.com",
};
const BINANCE_KLINE_PATHS: Record<BinanceMarketType, string> = {
    spot: "/api/v3/klines",
    futures: "/fapi/v1/klines",
};
const BINANCE_1S_LIMIT = 1000;

type RawBinanceKline = unknown[];

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
    const startTs = Math.max(0, Math.floor(args.startTs));
    const closedEndTs = Math.min(Math.floor(args.endTs), nowSec() - 2);
    if (closedEndTs < startTs) return [];

    const rows: Binance1sCandleRow[] = [];
    let cursorMs = startTs * 1000;
    const endMs = closedEndTs * 1000;
    let requestCount = 0;

    while (cursorMs <= endMs) {
        if (args.signal?.aborted) break;
        const url = new URL(`${BINANCE_BASES[marketType]}${BINANCE_KLINE_PATHS[marketType]}`);
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
    writeSecondDataSyncState(db, {
        source: "binance_1s",
        symbol: args.symbol,
        series_id: marketType,
        cursor_ts: lastTs,
        cursor_id: "",
        status: "ok",
        updated_at: nowSec(),
    });
    return {
        fetched: candles.length,
        upserted,
        firstTs,
        lastTs,
    };
}

