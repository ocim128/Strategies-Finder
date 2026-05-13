import type { DatabaseSync } from "node:sqlite";
import type { OHLCVData } from "../types/strategies";
import { DEFAULT_POLYMARKET_OUTCOME_INTERVAL } from "../polymarket-outcome-interval";
import { getSecondMarketSeriesId } from "./symbols";
import type {
    Binance1sCandleRow,
    PolymarketClob1sQuoteRow,
    PolymarketGammaSnapshotRow,
    PolymarketReference1sPriceRow,
    SecondMarketReferenceSource,
    SecondMarketSymbol,
    SecondMarketWindow,
} from "./types";

export function loadBinance1sCandles(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType?: "spot" | "futures";
    startTs: number;
    endTs: number;
}): Binance1sCandleRow[] {
    const marketType = args.marketType ?? "spot";
    return db.prepare(`
        SELECT symbol, market_type, ts, open, high, low, close, volume, trade_count, source, updated_at
        FROM binance_1s_candles
        WHERE symbol = ? AND market_type = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
    `).all(args.symbol, marketType, Math.floor(args.startTs), Math.floor(args.endTs)) as unknown as Binance1sCandleRow[];
}

export function loadBinance1sOhlcv(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType?: "spot" | "futures";
    startTs: number;
    endTs: number;
}): OHLCVData[] {
    return loadBinance1sCandles(db, args).map((row) => ({
        time: row.ts as OHLCVData["time"],
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
    }));
}

export function loadPolymarketClob1sQuotes(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    seriesId?: string;
    startTs: number;
    endTs: number;
}): PolymarketClob1sQuoteRow[] {
    const bindings: (string | number)[] = [args.symbol, Math.floor(args.startTs), Math.floor(args.endTs)];
    const seriesFilter = args.seriesId ? "AND series_id = ?" : "";
    if (args.seriesId) bindings.push(args.seriesId);
    return db.prepare(`
        SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts, condition_id, market_slug,
               yes_token_id, no_token_id, sample_ts, yes_bid, yes_ask, yes_mid, yes_last,
               no_bid, no_ask, no_mid, no_last, source, source_ts_ms, quote_age_ms, quality_flags, updated_at
        FROM polymarket_clob_1s_quotes
        WHERE symbol = ? AND sample_ts >= ? AND sample_ts <= ?
        ${seriesFilter}
        ORDER BY sample_ts ASC, source_ts_ms ASC
    `).all(...bindings) as unknown as PolymarketClob1sQuoteRow[];
}

export function loadPolymarketReference1sPrices(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    referenceSource?: SecondMarketReferenceSource;
    startTs: number;
    endTs: number;
}): PolymarketReference1sPriceRow[] {
    const bindings: (string | number)[] = [args.symbol, Math.floor(args.startTs), Math.floor(args.endTs)];
    const sourceFilter = args.referenceSource ? "AND reference_source = ?" : "";
    if (args.referenceSource) bindings.push(args.referenceSource);
    return db.prepare(`
        SELECT symbol, reference_source, source_symbol, ts, source_ts_ms, received_ts_ms, reference_price,
               full_accuracy_value, is_carried_forward, quality_flags, updated_at
        FROM polymarket_reference_1s_prices
        WHERE symbol = ? AND ts >= ? AND ts <= ?
        ${sourceFilter}
        ORDER BY ts ASC, source_ts_ms ASC
    `).all(...bindings) as unknown as PolymarketReference1sPriceRow[];
}

export function loadPolymarketGammaSnapshots(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    seriesId?: string;
    startTs: number;
    endTs: number;
}): PolymarketGammaSnapshotRow[] {
    const bindings: (string | number)[] = [args.symbol, Math.floor(args.startTs), Math.floor(args.endTs)];
    const seriesFilter = args.seriesId ? "AND series_id = ?" : "";
    if (args.seriesId) bindings.push(args.seriesId);
    return db.prepare(`
        SELECT series_id, symbol, outcome_interval, market_id, condition_id, market_slug,
               event_start_ts, event_end_ts, snapshot_ts, gamma_yes_price, gamma_no_price,
               last_trade_price, liquidity, volume, open_interest, active, closed,
               remote_updated_at, raw_json_hash, raw_json, updated_at
        FROM polymarket_gamma_snapshots
        WHERE symbol = ? AND snapshot_ts >= ? AND snapshot_ts <= ?
        ${seriesFilter}
        ORDER BY snapshot_ts ASC
    `).all(...bindings) as unknown as PolymarketGammaSnapshotRow[];
}

export function loadSecondMarketWindow(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    marketType?: "spot" | "futures";
    startTs: number;
    endTs: number;
    referenceSource?: SecondMarketReferenceSource;
    seriesId?: string;
}): SecondMarketWindow {
    const startTs = Math.floor(args.startTs);
    const endTs = Math.floor(args.endTs);
    const seriesId = args.seriesId ?? getSecondMarketSeriesId(args.symbol, DEFAULT_POLYMARKET_OUTCOME_INTERVAL);
    return {
        symbol: args.symbol,
        startTs,
        endTs,
        candles: loadBinance1sOhlcv(db, {
            symbol: args.symbol,
            marketType: args.marketType,
            startTs,
            endTs,
        }),
        clobQuotes: loadPolymarketClob1sQuotes(db, {
            symbol: args.symbol,
            seriesId,
            startTs,
            endTs,
        }),
        referencePrices: loadPolymarketReference1sPrices(db, {
            symbol: args.symbol,
            referenceSource: args.referenceSource,
            startTs,
            endTs,
        }),
        gammaSnapshots: loadPolymarketGammaSnapshots(db, {
            symbol: args.symbol,
            seriesId,
            startTs,
            endTs,
        }),
    };
}
