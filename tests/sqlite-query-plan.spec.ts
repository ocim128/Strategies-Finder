/**
 * EXPLAIN QUERY PLAN regression tests for SQLite hot paths.
 *
 * These tests protect against accidental query/index decoupling that would
 * cause silent performance regressions. They create an in-memory/temp DB with
 * the production schema, run EXPLAIN QUERY PLAN on the hot queries, and verify
 * the optimizer selects the expected index.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { openSecondMarketDb } from "../lib/second-market/db";

let tempDirs: string[] = [];

function makeDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-query-plan-"));
    tempDirs.push(dir);
    return join(dir, "test.sqlite");
}

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
});

/** Extract index names from EXPLAIN QUERY PLAN output. */
function extractIndexNames(plan: Array<Record<string, unknown>>): string[] {
    return plan
        .map((row) => String(row.detail ?? ""))
        .filter((detail) => detail.includes("USING INDEX"))
        .map((detail) => {
            const match = detail.match(/USING INDEX (\S+)/);
            return match ? match[1] : "";
        })
        .filter(Boolean);
}

/** Check if the plan includes a temp sort B-tree (indicates missing order-covering index). */
function hasTempSort(plan: Array<Record<string, unknown>>): boolean {
    return plan.some((row) => String(row.detail ?? "").includes("USE TEMP B-TREE FOR ORDER BY"));
}

describe("SQLite EXPLAIN QUERY PLAN regression tests", () => {

    // -------------------------------------------------------------------------
    // Local SQLite: polymarket_price_points hot query
    // -------------------------------------------------------------------------
    describe("polymarket_price_points event/time load", () => {
        const SCHEMA_SQL = `
            CREATE TABLE IF NOT EXISTS polymarket_price_points (
                series_id TEXT NOT NULL,
                event_start_ts INTEGER NOT NULL,
                event_end_ts INTEGER NOT NULL,
                market_slug TEXT NOT NULL DEFAULT '',
                yes_token_id TEXT NOT NULL DEFAULT '',
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
        `;

        it("uses idx_pm_price_points_event_time for series + event_start_ts IN query", () => {
            const db = new DatabaseSync(makeDbPath());
            try {
                db.exec(SCHEMA_SQL);

                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT series_id, event_start_ts, ts, yes_price, no_price
                    FROM polymarket_price_points
                    WHERE series_id = ? AND event_start_ts IN (?, ?)
                    ORDER BY ts ASC
                    LIMIT ?
                `).all("btc-updown-5m", 1700000000, 1700000300, 100) as Array<Record<string, unknown>>;

                const indexes = extractIndexNames(plan);
                expect(indexes.some((name) => name.includes("idx_pm_price_points"))).to.equal(true);
            } finally {
                db.close();
            }
        });

        it("does not require a temp sort for ORDER BY ts when index includes ts", () => {
            const db = new DatabaseSync(makeDbPath());
            try {
                db.exec(SCHEMA_SQL);

                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT series_id, event_start_ts, ts
                    FROM polymarket_price_points
                    WHERE series_id = ? AND event_start_ts = ?
                    ORDER BY ts ASC
                    LIMIT ?
                `).all("btc-updown-5m", 1700000000, 100) as Array<Record<string, unknown>>;

                // The composite PK (series_id, event_start_ts, ts) should satisfy
                // both the WHERE and ORDER BY without a temp B-tree sort.
                expect(hasTempSort(plan)).to.equal(false);
            } finally {
                db.close();
            }
        });
    });

    // -------------------------------------------------------------------------
    // Local SQLite: polymarket_outcomes pagination query
    // -------------------------------------------------------------------------
    describe("polymarket_outcomes pagination", () => {
        const SCHEMA_SQL = `
            CREATE TABLE IF NOT EXISTS polymarket_outcomes (
                series_id TEXT NOT NULL,
                event_slug TEXT NOT NULL,
                market_slug TEXT NOT NULL DEFAULT '',
                interval TEXT NOT NULL DEFAULT '5m',
                event_start_ts INTEGER NOT NULL,
                event_end_ts INTEGER NOT NULL,
                yes_token_id TEXT NOT NULL DEFAULT '',
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
        `;

        it("uses idx_pm_outcomes_series_start for series + startTs filter", () => {
            const db = new DatabaseSync(makeDbPath());
            try {
                db.exec(SCHEMA_SQL);

                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT series_id, event_slug, event_start_ts, resolved_outcome_up
                    FROM polymarket_outcomes
                    WHERE series_id = ? AND event_start_ts >= ?
                    ORDER BY event_start_ts ASC, event_slug ASC
                    LIMIT ?
                `).all("btc-updown-5m", 1700000000, 500) as Array<Record<string, unknown>>;

                const indexes = extractIndexNames(plan);
                expect(indexes.some((name) => name.includes("idx_pm_outcomes_series_start"))).to.equal(true);
            } finally {
                db.close();
            }
        });
    });

    // -------------------------------------------------------------------------
    // Second-market: CLOB quote window query
    // -------------------------------------------------------------------------
    describe("polymarket_clob_1s_quotes window scan", () => {
        it("uses a symbol+time index and avoids temp sort for ORDER BY sample_ts, source_ts_ms", () => {
            const db = openSecondMarketDb(makeDbPath());
            try {
                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT symbol, sample_ts, yes_bid, yes_ask
                    FROM polymarket_clob_1s_quotes
                    WHERE symbol = ? AND sample_ts >= ? AND sample_ts <= ?
                    ORDER BY sample_ts ASC, source_ts_ms ASC
                    LIMIT ?
                `).all("BTCUSDT", 1700000000, 1700003600, 5000) as Array<Record<string, unknown>>;

                const planStr = JSON.stringify(plan);
                // Should use one of the symbol-time indexes (either with or without series_id).
                expect(planStr).to.match(/idx_clob_1s_symbol(?:_series)?_time/);
                // Should NOT need a temp sort since the _sts index covers the ORDER BY.
                expect(hasTempSort(plan)).to.equal(false);
            } finally {
                db.close();
            }
        });

        it("uses an index with symbol+time and avoids temp sort when series_id filter is present", () => {
            const db = openSecondMarketDb(makeDbPath());
            try {
                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT symbol, sample_ts, yes_bid, yes_ask
                    FROM polymarket_clob_1s_quotes
                    WHERE symbol = ? AND series_id = ? AND sample_ts >= ? AND sample_ts <= ?
                    ORDER BY sample_ts ASC, source_ts_ms ASC
                    LIMIT ?
                `).all("BTCUSDT", "btc-updown-5m", 1700000000, 1700003600, 5000) as Array<Record<string, unknown>>;

                const planStr = JSON.stringify(plan);
                // Optimizer may choose either the symbol+time or symbol+series+time index
                // depending on data distribution. Both are valid and avoid a full scan.
                expect(planStr).to.match(/idx_clob_1s_symbol(?:_series)?_time/);
                expect(hasTempSort(plan)).to.equal(false);
            } finally {
                db.close();
            }
        });
    });

    // -------------------------------------------------------------------------
    // Local SQLite: status endpoint series_meta SUM vs COUNT(*)
    // -------------------------------------------------------------------------
    describe("series_meta SUM for status count", () => {
        it("uses a constant-time scan on the small series_meta table", () => {
            const db = new DatabaseSync(makeDbPath());
            try {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS series_meta (
                        symbol TEXT NOT NULL,
                        interval TEXT NOT NULL,
                        source TEXT NOT NULL DEFAULT '',
                        bars_count INTEGER NOT NULL DEFAULT 0,
                        first_ts INTEGER NOT NULL DEFAULT 0,
                        last_ts INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY(symbol, interval)
                    );
                `);

                const plan = db.prepare(`
                    EXPLAIN QUERY PLAN
                    SELECT COALESCE(SUM(bars_count), 0) AS count FROM series_meta
                `).all() as Array<Record<string, unknown>>;

                // Should be a simple scan on series_meta — no large table involved.
                const planStr = JSON.stringify(plan);
                expect(planStr).to.include("series_meta");
                expect(planStr).to.not.include("candles");
            } finally {
                db.close();
            }
        });
    });
});
