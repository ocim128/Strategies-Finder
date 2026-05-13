import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSecondMarketSchema } from "./schema";
import {
    SECOND_MARKET_DB_RELATIVE_PATH,
    type Binance1sCandleRow,
    type PolymarketClob1sQuoteRow,
    type PolymarketGammaSnapshotRow,
    type PolymarketReference1sPriceRow,
    type SecondDataQualityRunRow,
    type SecondDataSyncStateRow,
    type SecondMarketSourceName,
    type SecondMarketSymbol,
} from "./types";

export function resolveSecondMarketDbPath(dbPath?: string): string {
    return resolve(dbPath ?? SECOND_MARKET_DB_RELATIVE_PATH);
}

export function openSecondMarketDb(dbPath?: string): DatabaseSync {
    const resolvedPath = resolveSecondMarketDbPath(dbPath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    const db = new DatabaseSync(resolvedPath);
    ensureSecondMarketSchema(db);
    return db;
}

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec("BEGIN");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

export function upsertBinance1sCandles(db: DatabaseSync, rows: readonly Binance1sCandleRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = db.prepare(`
        INSERT INTO binance_1s_candles (
            symbol, market_type, ts, open, high, low, close, volume, trade_count, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, market_type, ts) DO UPDATE SET
            open = excluded.open,
            high = excluded.high,
            low = excluded.low,
            close = excluded.close,
            volume = excluded.volume,
            trade_count = excluded.trade_count,
            source = excluded.source,
            updated_at = excluded.updated_at
    `);

    return runTransaction(db, () => {
        let count = 0;
        for (const row of rows) {
            stmt.run(
                row.symbol,
                row.market_type,
                row.ts,
                row.open,
                row.high,
                row.low,
                row.close,
                row.volume,
                row.trade_count,
                row.source,
                row.updated_at,
            );
            count += 1;
        }
        return count;
    });
}

export function upsertPolymarketClob1sQuotes(
    db: DatabaseSync,
    rows: readonly PolymarketClob1sQuoteRow[]
): number {
    if (rows.length === 0) return 0;
    const stmt = db.prepare(`
        INSERT INTO polymarket_clob_1s_quotes (
            series_id, symbol, outcome_interval, event_start_ts, event_end_ts, condition_id, market_slug,
            yes_token_id, no_token_id, sample_ts, yes_bid, yes_ask, yes_mid, yes_last,
            no_bid, no_ask, no_mid, no_last, source, source_ts_ms, quote_age_ms, quality_flags, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_id, event_start_ts, yes_token_id, sample_ts) DO UPDATE SET
            outcome_interval = excluded.outcome_interval,
            event_end_ts = excluded.event_end_ts,
            condition_id = excluded.condition_id,
            market_slug = excluded.market_slug,
            no_token_id = excluded.no_token_id,
            yes_bid = excluded.yes_bid,
            yes_ask = excluded.yes_ask,
            yes_mid = excluded.yes_mid,
            yes_last = excluded.yes_last,
            no_bid = excluded.no_bid,
            no_ask = excluded.no_ask,
            no_mid = excluded.no_mid,
            no_last = excluded.no_last,
            source = excluded.source,
            source_ts_ms = excluded.source_ts_ms,
            quote_age_ms = excluded.quote_age_ms,
            quality_flags = excluded.quality_flags,
            updated_at = excluded.updated_at
    `);

    return runTransaction(db, () => {
        let count = 0;
        for (const row of rows) {
            stmt.run(
                row.series_id,
                row.symbol,
                row.outcome_interval,
                row.event_start_ts,
                row.event_end_ts,
                row.condition_id,
                row.market_slug,
                row.yes_token_id,
                row.no_token_id,
                row.sample_ts,
                row.yes_bid,
                row.yes_ask,
                row.yes_mid,
                row.yes_last,
                row.no_bid,
                row.no_ask,
                row.no_mid,
                row.no_last,
                row.source,
                row.source_ts_ms,
                row.quote_age_ms,
                row.quality_flags,
                row.updated_at,
            );
            count += 1;
        }
        return count;
    });
}

export function upsertPolymarketReference1sPrices(
    db: DatabaseSync,
    rows: readonly PolymarketReference1sPriceRow[]
): number {
    if (rows.length === 0) return 0;
    const stmt = db.prepare(`
        INSERT INTO polymarket_reference_1s_prices (
            symbol, reference_source, source_symbol, ts, source_ts_ms, received_ts_ms, reference_price,
            full_accuracy_value, is_carried_forward, quality_flags, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, reference_source, source_ts_ms) DO UPDATE SET
            source_symbol = excluded.source_symbol,
            ts = excluded.ts,
            received_ts_ms = excluded.received_ts_ms,
            reference_price = excluded.reference_price,
            full_accuracy_value = excluded.full_accuracy_value,
            is_carried_forward = excluded.is_carried_forward,
            quality_flags = excluded.quality_flags,
            updated_at = excluded.updated_at
    `);

    return runTransaction(db, () => {
        let count = 0;
        for (const row of rows) {
            stmt.run(
                row.symbol,
                row.reference_source,
                row.source_symbol,
                row.ts,
                row.source_ts_ms,
                row.received_ts_ms,
                row.reference_price,
                row.full_accuracy_value,
                row.is_carried_forward,
                row.quality_flags,
                row.updated_at,
            );
            count += 1;
        }
        return count;
    });
}

export function upsertPolymarketGammaSnapshots(
    db: DatabaseSync,
    rows: readonly PolymarketGammaSnapshotRow[]
): number {
    if (rows.length === 0) return 0;
    const stmt = db.prepare(`
        INSERT INTO polymarket_gamma_snapshots (
            series_id, symbol, outcome_interval, market_id, condition_id, market_slug, event_start_ts, event_end_ts,
            snapshot_ts, gamma_yes_price, gamma_no_price, last_trade_price, liquidity, volume, open_interest,
            active, closed, remote_updated_at, raw_json_hash, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_id, market_id, snapshot_ts) DO UPDATE SET
            outcome_interval = excluded.outcome_interval,
            condition_id = excluded.condition_id,
            market_slug = excluded.market_slug,
            event_start_ts = excluded.event_start_ts,
            event_end_ts = excluded.event_end_ts,
            gamma_yes_price = excluded.gamma_yes_price,
            gamma_no_price = excluded.gamma_no_price,
            last_trade_price = excluded.last_trade_price,
            liquidity = excluded.liquidity,
            volume = excluded.volume,
            open_interest = excluded.open_interest,
            active = excluded.active,
            closed = excluded.closed,
            remote_updated_at = excluded.remote_updated_at,
            raw_json_hash = excluded.raw_json_hash,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
    `);

    return runTransaction(db, () => {
        let count = 0;
        for (const row of rows) {
            stmt.run(
                row.series_id,
                row.symbol,
                row.outcome_interval,
                row.market_id,
                row.condition_id,
                row.market_slug,
                row.event_start_ts,
                row.event_end_ts,
                row.snapshot_ts,
                row.gamma_yes_price,
                row.gamma_no_price,
                row.last_trade_price,
                row.liquidity,
                row.volume,
                row.open_interest,
                row.active,
                row.closed,
                row.remote_updated_at,
                row.raw_json_hash,
                row.raw_json,
                row.updated_at,
            );
            count += 1;
        }
        return count;
    });
}

export function upsertSecondDataQualityRun(db: DatabaseSync, row: SecondDataQualityRunRow): void {
    db.prepare(`
        INSERT INTO second_data_quality_runs (
            id, symbol, start_ts, end_ts, binance_seconds, clob_quote_seconds, reference_price_seconds,
            gamma_snapshot_count, binance_gap_count, clob_gap_count, reference_gap_count,
            exact_quote_coverage_pct, max_quote_age_sec, max_reference_age_sec, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            symbol = excluded.symbol,
            start_ts = excluded.start_ts,
            end_ts = excluded.end_ts,
            binance_seconds = excluded.binance_seconds,
            clob_quote_seconds = excluded.clob_quote_seconds,
            reference_price_seconds = excluded.reference_price_seconds,
            gamma_snapshot_count = excluded.gamma_snapshot_count,
            binance_gap_count = excluded.binance_gap_count,
            clob_gap_count = excluded.clob_gap_count,
            reference_gap_count = excluded.reference_gap_count,
            exact_quote_coverage_pct = excluded.exact_quote_coverage_pct,
            max_quote_age_sec = excluded.max_quote_age_sec,
            max_reference_age_sec = excluded.max_reference_age_sec,
            created_at = excluded.created_at
    `).run(
        row.id,
        row.symbol,
        row.start_ts,
        row.end_ts,
        row.binance_seconds,
        row.clob_quote_seconds,
        row.reference_price_seconds,
        row.gamma_snapshot_count,
        row.binance_gap_count,
        row.clob_gap_count,
        row.reference_gap_count,
        row.exact_quote_coverage_pct,
        row.max_quote_age_sec,
        row.max_reference_age_sec,
        row.created_at,
    );
}

export function loadSecondDataSyncState(
    db: DatabaseSync,
    source: SecondMarketSourceName | string,
    symbol: SecondMarketSymbol,
    seriesId = ""
): SecondDataSyncStateRow | null {
    const row = db.prepare(`
        SELECT source, symbol, series_id, cursor_ts, cursor_id, status, updated_at
        FROM second_data_sync_state
        WHERE source = ? AND symbol = ? AND series_id = ?
    `).get(source, symbol, seriesId) as SecondDataSyncStateRow | undefined;
    return row ?? null;
}

export function writeSecondDataSyncState(db: DatabaseSync, row: SecondDataSyncStateRow): void {
    db.prepare(`
        INSERT INTO second_data_sync_state(source, symbol, series_id, cursor_ts, cursor_id, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, symbol, series_id) DO UPDATE SET
            cursor_ts = excluded.cursor_ts,
            cursor_id = excluded.cursor_id,
            status = excluded.status,
            updated_at = excluded.updated_at
    `).run(
        row.source,
        row.symbol,
        row.series_id,
        row.cursor_ts,
        row.cursor_id,
        row.status,
        row.updated_at,
    );
}

