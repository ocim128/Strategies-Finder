/**
 * Data-loss safety tests for the IBKR/Alpaca sync pipeline.
 *
 * Locks the three defenses added after a destructive Alpaca Download
 * incident (a short-window fetch replaced a 22-year IBKR 30m history):
 *
 *  Layer 1 — Download MERGES onto existing rows; it never replaces.
 *            Existing history (non-overlapping bars) is preserved.
 *            (Verified at the pure-helper level via mergeCandlesByTime, the
 *            primitive both syncOneSymbol and syncOneAlpacaSymbol now route
 *            every Download through. The end-to-end worker path is covered
 *            by the Alpaca integration spec's source-guard/mixed tests.)
 *  Layer 2 — `writeCsv` writes a `<path>.bak` of the file it overwrites.
 *  Layer 3 — `ibkr-aggregate-csv.ts` refuses to write a much smaller
 *            destination than the existing one (`--force` overrides).
 *
 * NOTE: `getCsvPath` resolves against a module-level `APP_ROOT = process.cwd()`
 * captured at import time, so these tests must use the real repo price-data
 * path. To stay safe and isolated, they use a sentinel interval `zztest`
 * that never appears in production and clean up the directory in afterEach.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    getCsvPath,
    mergeCandlesByTime,
    parseCsvCandleLines,
    writeCsv,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import type { OHLCVData } from "../lib/types/strategies";

// Sentinel interval — never used by real data (real intervals are 1m/5m/15m/
// 30m/1h/4h/1d). Using a non-production interval keeps the tests from ever
// touching a real symbol's history even if cleanup fails.
const TEST_INTERVAL = "zztest";
const TEST_DIR = resolve(process.cwd(), "price-data", "ibkr", "csv", TEST_INTERVAL);

function bar(epoch: number, close: number): OHLCVData {
    return {
        time: epoch as OHLCVData["time"],
        open: close, high: close, low: close, close,
        volume: 100,
    };
}

function writeRawCsv(symbol: string, candles: OHLCVData[]): void {
    const path = getCsvPath(symbol, TEST_INTERVAL);
    mkdirSync(resolve(path, ".."), { recursive: true });
    const rows = ["time,open,high,low,close,volume"];
    for (const c of candles) {
        rows.push([
            new Date(Number(c.time) * 1000).toISOString(),
            c.open, c.high, c.low, c.close, c.volume ?? 0,
        ].join(","));
    }
    writeFileSync(path, `${rows.join("\n")}\n`);
}

describe("writeCsv .bak defense (Layer 2)", () => {
    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
    });
    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("creates a .bak of the existing file before overwriting it", () => {
        writeRawCsv("ZZZ1", [bar(1_700_000_000, 100)]);                 // v1: close 100
        writeCsv("ZZZ1", TEST_INTERVAL, [bar(1_700_000_300, 200)]);     // overwrite
        const bakPath = `${getCsvPath("ZZZ1", TEST_INTERVAL)}.bak`;
        assert.ok(existsSync(bakPath), "expected .bak to exist");
        const bakBars = parseCsvCandleLines(readFileSync(bakPath, "utf8").split(/\r?\n/));
        assert.equal(bakBars.length, 1);
        assert.equal(bakBars[0]!.close, 100); // .bak holds the OLD close, not new
    });

    it("does NOT create a .bak on a fresh write (no prior file to back up)", () => {
        writeCsv("ZZZ2", TEST_INTERVAL, [bar(1_700_000_000, 100)]);
        const dir = readdirSync(TEST_DIR);
        assert.ok(dir.includes("ZZZ2.csv"));
        assert.ok(!dir.includes("ZZZ2.csv.bak"), `unexpected .bak on fresh write: ${dir.join(",")}`);
    });

    it(".bak always holds the LAST good state (second overwrite replaces prior .bak)", () => {
        writeRawCsv("ZZZ3", [bar(1_700_000_000, 100)]);                 // v1
        writeCsv("ZZZ3", TEST_INTERVAL, [bar(1_700_000_300, 200)]);     // .bak = v1 (100)
        writeCsv("ZZZ3", TEST_INTERVAL, [bar(1_700_000_600, 300)]);     // .bak = v2 (200)
        const bakBars = parseCsvCandleLines(
            readFileSync(`${getCsvPath("ZZZ3", TEST_INTERVAL)}.bak`, "utf8").split(/\r?\n/),
        );
        assert.equal(bakBars[0]!.close, 200); // last good state, not v1
    });
});

describe("mergeCandlesByTime preserves non-overlapping history (Layer 1 foundation)", () => {
    // This is the pure-helper guarantee that makes "always merge" safe: new
    // bars extend the series, overlapping bars take the new values, but the
    // OLD non-overlapping bars are NEVER dropped. Both syncOneSymbol (IBKR)
    // and syncOneAlpacaSymbol now route every Download through this primitive.
    it("keeps old bars that the new fetch does not overlap", () => {
        const oldHistory = [
            bar(1_700_000_000, 100),
            bar(1_700_000_300, 101),
            bar(1_700_000_600, 102),
        ];
        const newFetch = [
            bar(1_700_000_600, 999), // overlap (should win)
            bar(1_700_000_900, 103), // extends
        ];
        const merged = mergeCandlesByTime([...oldHistory, ...newFetch]);
        assert.equal(merged.length, 4); // 3 old unique times + 1 new
        const byTime = new Map(merged.map((c) => [Number(c.time), c.close]));
        assert.equal(byTime.get(1_700_000_000), 100); // old preserved
        assert.equal(byTime.get(1_700_000_300), 101); // old preserved
        assert.equal(byTime.get(1_700_000_600), 999); // overlap -> new wins
        assert.equal(byTime.get(1_700_000_900), 103); // new extended
    });

    it("is sorted ascending by time regardless of input order", () => {
        const merged = mergeCandlesByTime([bar(300, 3), bar(100, 1), bar(200, 2)]);
        assert.deepEqual(merged.map((c) => Number(c.time)), [100, 200, 300]);
    });

    it("demonstrates the data-loss scenario the fix prevents", () => {
        // This is the exact shape of the incident: an existing 73,000-bar
        // history + a fresh 79-bar fetch. Under the OLD `syncOnly ? read : []`
        // logic, Download discarded the 73,000 bars and wrote only the 79.
        // Under the new always-merge logic, the 79 extend/overlap and the
        // rest of the 73,000 survive.
        const existingHistory: OHLCVData[] = [];
        for (let i = 0; i < 73_000; i += 1) existingHistory.push(bar(1_000_000 + i * 100, i));
        // Fresh fetch starts AFTER the existing history (no overlap) — the
        // incident scenario: recent bars only, full history preceding them.
        const freshFetch: OHLCVData[] = [];
        const freshStart = 1_000_000 + 73_000 * 100;
        for (let i = 0; i < 79; i += 1) freshFetch.push(bar(freshStart + i * 100, 1000 + i));
        const merged = mergeCandlesByTime([...existingHistory, ...freshFetch]);
        assert.equal(merged.length, 73_000 + 79); // none of the old bars dropped
    });
});
