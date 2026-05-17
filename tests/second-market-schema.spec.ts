import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { parseIntervalSeconds } from "../lib/interval-utils";
import { BINANCE_INTERVALS, toBinanceInterval } from "../lib/binance-market-data-utils";
import {
    openSecondMarketDb,
    upsertBinance1sCandles,
    upsertPolymarketReference1sPrices,
} from "../lib/second-market/db";

let tempDirs: string[] = [];

function makeDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "second-market-schema-"));
    tempDirs.push(dir);
    return join(dir, "second-market-data.sqlite");
}

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
});

describe("second market schema", () => {
    it("supports the 1s interval contract", () => {
        expect(parseIntervalSeconds("1s")).to.equal(1);
        expect(BINANCE_INTERVALS.has("1s")).to.equal(true);
        expect(toBinanceInterval("1s")).to.equal("1s");
    });

    it("creates the database and stores idempotent 1s rows", () => {
        const db = openSecondMarketDb(makeDbPath());
        try {
            upsertBinance1sCandles(db, [{
                symbol: "BTCUSDT",
                market_type: "spot",
                ts: 1_700_000_000,
                open: 100,
                high: 101,
                low: 99,
                close: 100.5,
                volume: 10,
                trade_count: 5,
                source: "binance_1s",
                updated_at: 1_700_000_010,
            }]);
            upsertBinance1sCandles(db, [{
                symbol: "BTCUSDT",
                market_type: "spot",
                ts: 1_700_000_000,
                open: 100,
                high: 102,
                low: 99,
                close: 101,
                volume: 11,
                trade_count: 6,
                source: "binance_1s",
                updated_at: 1_700_000_020,
            }]);

            const count = db.prepare("SELECT COUNT(*) AS count FROM binance_1s_candles").get() as { count: number };
            const row = db.prepare("SELECT close, trade_count FROM binance_1s_candles").get() as { close: number; trade_count: number };
            const clobIndexes = db.prepare("PRAGMA index_list('polymarket_clob_1s_quotes')").all() as Array<{ name: string }>;
            expect(count.count).to.equal(1);
            expect(row.close).to.equal(101);
            expect(row.trade_count).to.equal(6);
            expect(clobIndexes.some((index) => index.name === "idx_clob_1s_symbol_series_time")).to.equal(true);
        } finally {
            db.close();
        }
    });

    it("stores Polymarket reference prices by source timestamp", () => {
        const db = openSecondMarketDb(makeDbPath());
        try {
            const upserted = upsertPolymarketReference1sPrices(db, [{
                symbol: "XRPUSDT",
                reference_source: "crypto_prices",
                source_symbol: "xrpusdt",
                ts: 1_700_000_001,
                source_ts_ms: 1_700_000_001_123,
                received_ts_ms: 1_700_000_001_150,
                reference_price: 0.55,
                full_accuracy_value: "0.5501",
                is_carried_forward: 0,
                quality_flags: "",
                updated_at: 1_700_000_002,
            }]);

            const row = db.prepare("SELECT symbol, reference_price FROM polymarket_reference_1s_prices").get() as {
                symbol: string;
                reference_price: number;
            };
            expect(upserted).to.equal(1);
            expect(row.symbol).to.equal("XRPUSDT");
            expect(row.reference_price).to.equal(0.55);
        } finally {
            db.close();
        }
    });
});
