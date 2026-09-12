/**
 * Unit tests for the market-cap series reader leaf
 * (`lib/ibkr-data/marketcap-series-reader.ts`) that backs the OPEN_SCORE USD
 * cap-tilt weighting (docs/open-score-cap-tilt.md).
 *
 * Locked contract: parse the Download MarketCap CSV shape
 * (`time,close,shares_outstanding,market_cap`), skip `.bak` companions and
 * `catalog.json`, skip malformed rows silently, nearest-prior lookup (cap
 * rows are trading days; entries can be intraday), marker/slash symbol
 * normalization, and `null` for missing symbols/dates. The reader is a
 * dependency-free leaf (node:fs/node:path only) — see the bundle-trap rule.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketCapLookup } from "../lib/ibkr-data/marketcap-series-reader";

describe("marketcap-series-reader", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "mktcap-reader-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeCsv(name: string, rows: string[]): void {
        writeFileSync(join(dir, name), ["time,close,shares_outstanding,market_cap", ...rows].join("\n"));
    }

    it("parses the market_cap column and answers nearest-prior lookups", () => {
        writeCsv("AAA.csv", [
            "2024-01-02,1,10,1000",
            "2024-01-03,1,10,1100",
            "2024-01-07,1,10,1500",
        ]);
        const lookup = loadMarketCapLookup(dir);
        assert.equal(lookup.symbols, 1);
        const t = (date: string) => Math.floor(Date.parse(date) / 1000);
        // Exact row dates.
        assert.equal(lookup.lookup("AAA", t("2024-01-02")), 1000);
        assert.equal(lookup.lookup("AAA", t("2024-01-03")), 1100);
        // Intraday / weekend timestamps fall back to the nearest PRIOR row.
        assert.equal(lookup.lookup("AAA", t("2024-01-03") + 3600), 1100);
        assert.equal(lookup.lookup("AAA", t("2024-01-06")), 1100);
        // Before the first row -> null; after the last -> last row.
        assert.equal(lookup.lookup("AAA", t("2024-01-01")), null);
        assert.equal(lookup.lookup("AAA", t("2025-01-01")), 1500);
    });

    it("normalizes bullet markers and slashes before the file match", () => {
        writeCsv("BRK-B.csv", ["2024-01-02,1,10,700000000000"]);
        writeCsv("PAXGUSD.csv", ["2024-01-02,1,10,500000000"]);
        const lookup = loadMarketCapLookup(dir);
        // Marked forms, as carried by Batch artifacts (baseSymbol/quoteSymbol).
        assert.equal(lookup.lookup("BRK-B•", Math.floor(Date.parse("2024-01-02") / 1000)), 700000000000);
        // Slash-leg crypto symbol, as stored by the writer (slash removed).
        assert.equal(lookup.lookup("PAXG/USD•", Math.floor(Date.parse("2024-01-02") / 1000)), 500000000);
    });

    it("skips .bak companions and catalog.json", () => {
        writeCsv("AAA.csv", ["2024-01-02,1,10,1000"]);
        // A .bak of the same symbol with WRONG data must never be indexed
        // (the .csv-suffix filter excludes `AAA.csv.bak`), and catalog.json
        // is not a CSV at all.
        writeCsv("AAA.csv.bak", ["2024-01-02,1,10,999999"]);
        writeFileSync(join(dir, "catalog.json"), JSON.stringify({ updatedAt: "x", entries: [] }));
        const lookup = loadMarketCapLookup(dir);
        assert.equal(lookup.symbols, 1);
        assert.equal(lookup.lookup("AAA", Math.floor(Date.parse("2024-01-02") / 1000)), 1000);
    });

    it("skips malformed rows and files with no valid rows", () => {
        writeCsv("AAA.csv", [
            "not-a-date,1,10,1000", // bad date -> skipped
            "2024-01-02,1,10,not-a-number", // bad cap -> skipped
            "2024-01-03,1,10", // too few columns -> skipped
            "", // blank line -> skipped
            "2024-01-04,1,10,1200", // valid
        ]);
        writeCsv("EMPTY.csv", ["garbage without commas"]);
        const lookup = loadMarketCapLookup(dir);
        assert.equal(lookup.symbols, 1); // EMPTY.csv contributed nothing
        assert.equal(lookup.lookup("AAA", Math.floor(Date.parse("2024-01-04") / 1000)), 1200);
        assert.equal(lookup.lookup("AAA", Math.floor(Date.parse("2024-01-02") / 1000)), null);
        assert.equal(lookup.lookup("EMPTY", Math.floor(Date.parse("2024-01-02") / 1000)), null);
    });

    it("returns null for a symbol with no file (never throws)", () => {
        writeCsv("AAA.csv", ["2024-01-02,1,10,1000"]);
        const lookup = loadMarketCapLookup(dir);
        assert.equal(lookup.lookup("ZZZ", Math.floor(Date.parse("2024-01-02") / 1000)), null);
    });
});
