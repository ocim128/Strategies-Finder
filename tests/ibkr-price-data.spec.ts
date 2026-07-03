import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    mergeCandlesByTime,
    normalizeSymbol,
    parseCsvCandleLines,
    parseHistoryCandles,
    parsePeriodToMs,
    parseResolvedContracts,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import type { OHLCVData } from "../lib/types/strategies";

describe("ibkr parseHistoryCandles", () => {
    it("returns an empty array when the payload has no data array", () => {
        assert.deepEqual(parseHistoryCandles(null), []);
        assert.deepEqual(parseHistoryCandles({}), []);
        assert.deepEqual(parseHistoryCandles({ data: "not-an-array" }), []);
    });

    it("parses the canonical t/o/h/l/c/v field names", () => {
        const candles = parseHistoryCandles({
            data: [
                { t: "2026-07-01", o: "1", h: "2", l: "0.5", c: "1.5", v: "100" },
                { t: "2026-07-02", o: "1.5", h: "2.5", l: "1", c: "2", v: "200" },
            ],
        });
        assert.equal(candles.length, 2);
        assert.equal(candles[0]!.open, 1);
        assert.equal(candles[1]!.close, 2);
        // ISO date strings parse to unix seconds; ascending order preserved.
        assert.equal(Number(candles[0]!.time) < Number(candles[1]!.time), true);
    });

    it("accepts the time/open/high/low/close/volume aliases", () => {
        const candles = parseHistoryCandles({
            data: [
                { time: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
            ],
        });
        assert.equal(candles.length, 1);
        assert.equal(candles[0]!.volume, 100);
    });

    it("treats a missing volume as 0 rather than dropping the bar", () => {
        const candles = parseHistoryCandles({
            data: [{ t: "2026-07-01", o: 1, h: 2, l: 0.5, c: 1.5 }],
        });
        assert.equal(candles.length, 1);
        assert.equal(candles[0]!.volume, 0);
    });

    it("drops rows with non-finite OHLC", () => {
        const candles = parseHistoryCandles({
            data: [
                { t: "2026-07-01", o: "not-a-number", h: 2, l: 0.5, c: 1.5 },
                { t: "2026-07-02", o: 1, h: 2, l: 0.5, c: 1.5 },
            ],
        });
        assert.equal(candles.length, 1);
        const secondOnly = parseHistoryCandles({
            data: [{ t: "2026-07-02", o: 1, h: 2, l: 0.5, c: 1.5 }],
        })[0]!;
        assert.equal(Number(candles[0]!.time), Number(secondOnly.time));
    });
});

describe("ibkr parseResolvedContracts", () => {
    it("returns nothing for empty or non-array payloads", () => {
        assert.deepEqual(parseResolvedContracts("AAPL", null), []);
        assert.deepEqual(parseResolvedContracts("AAPL", {}), []);
        assert.deepEqual(parseResolvedContracts("AAPL", []), []);
    });

    it("maps both conid and conId aliases", () => {
        const a = parseResolvedContracts("AAPL", [{ conid: "123", companyName: "Apple" }]);
        const b = parseResolvedContracts("AAPL", [{ conId: "456", description: "Apple Inc" }]);
        assert.equal(a[0]!.conid, "123");
        assert.equal(a[0]!.name, "Apple");
        assert.equal(b[0]!.conid, "456");
        assert.equal(b[0]!.name, "Apple Inc");
    });

    it("drops rows without a conid", () => {
        const rows = parseResolvedContracts("AAPL", [
            { companyName: "no conid here" },
            { conid: "123", companyName: "Apple" },
        ]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.conid, "123");
    });

    it("falls back to symbol name when neither companyName nor description is present", () => {
        const rows = parseResolvedContracts("AAPL", [{ conid: "123" }]);
        assert.equal(rows[0]!.name, "AAPL");
    });
});

describe("ibkr parsePeriodToMs", () => {
    it("parses each supported unit", () => {
        const day = 24 * 60 * 60 * 1000;
        assert.equal(parsePeriodToMs("1d"), day);
        assert.equal(parsePeriodToMs("2w"), 2 * 7 * day);
        assert.equal(parsePeriodToMs("3m"), 3 * 30 * day);
        assert.equal(parsePeriodToMs("1y"), 365 * day);
    });

    it("is case-insensitive and tolerates surrounding whitespace", () => {
        assert.equal(parsePeriodToMs("  1W "), 7 * 24 * 60 * 60 * 1000);
    });

    it("returns null for invalid shapes, zero, and negative amounts", () => {
        assert.equal(parsePeriodToMs("max"), null);
        assert.equal(parsePeriodToMs("1x"), null);
        assert.equal(parsePeriodToMs("0d"), null);
        assert.equal(parsePeriodToMs("-1d"), null);
        assert.equal(parsePeriodToMs(""), null);
    });
});

describe("ibkr mergeCandlesByTime", () => {
    it("deduplicates by time and last write wins", () => {
        const t1 = 1_700_000_000;
        const merged = mergeCandlesByTime([
            { time: t1 as OHLCVData["time"], open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: t1 as OHLCVData["time"], open: 2, high: 2, low: 2, close: 2, volume: 2 },
        ]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0]!.close, 2);
    });

    it("emits ascending by time regardless of input order", () => {
        const t1 = 1_700_000_000;
        const t2 = t1 + 86400;
        const t3 = t2 + 86400;
        const merged = mergeCandlesByTime([
            { time: t3 as OHLCVData["time"], open: 3, high: 3, low: 3, close: 3, volume: 3 },
            { time: t1 as OHLCVData["time"], open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: t2 as OHLCVData["time"], open: 2, high: 2, low: 2, close: 2, volume: 2 },
        ]);
        assert.deepEqual(merged.map((c) => Number(c.time)), [t1, t2, t3]);
    });

    it("returns an empty array for empty input", () => {
        assert.deepEqual(mergeCandlesByTime([]), []);
    });
});

describe("ibkr normalizeSymbol", () => {
    it("uppercases and strips the bullet marker", () => {
        assert.equal(normalizeSymbol("aapl"), "AAPL");
        assert.equal(normalizeSymbol(" aapl\u2022 "), "AAPL");
    });

    it("rejects path-traversal and disallowed characters", () => {
        assert.throws(() => normalizeSymbol("../etc/passwd"));
        assert.throws(() => normalizeSymbol("AAPL/BTC"));
        assert.throws(() => normalizeSymbol(""));
    });

    it("accepts digits, dots, underscores, and hyphens", () => {
        assert.equal(normalizeSymbol("brk.b"), "BRK.B");
        assert.equal(normalizeSymbol("a_b-c"), "A_B-C");
    });
});

describe("ibkr parseCsvCandleLines", () => {
    it("returns an empty array for empty input or header-only input", () => {
        assert.deepEqual(parseCsvCandleLines([]), []);
        assert.deepEqual(parseCsvCandleLines(["time,open,high,low,close,volume"]), []);
    });

    it("parses ISO-time rows into unix-second candles sorted ascending", () => {
        const lines = [
            "time,open,high,low,close,volume",
            "2023-11-14T22:13:20.000Z,1,2,0.5,1.5,100",
            "2023-11-14T22:13:22.000Z,3,3.5,2.8,3.2,200",
        ];
        const candles = parseCsvCandleLines(lines);
        assert.equal(candles.length, 2);
        assert.deepEqual(
            candles.map((c) => c.volume),
            [100, 200]
        );
        assert.equal(Number(candles[0]!.time) < Number(candles[1]!.time), true);
    });

    it("treats a missing volume column as 0", () => {
        const candles = parseCsvCandleLines([
            "time,open,high,low,close,volume",
            "2023-11-14T22:13:20.000Z,1,2,0.5,1.5",
        ]);
        assert.equal(candles.length, 1);
        assert.equal(candles[0]!.volume, 0);
    });

    it("drops rows with non-finite OHLC rather than failing", () => {
        const candles = parseCsvCandleLines([
            "time,open,high,low,close,volume",
            "2023-11-14T22:13:20.000Z,bad,2,0.5,1.5,100",
            "2023-11-14T22:13:21.000Z,2,3,1,2,150",
        ]);
        assert.equal(candles.length, 1);
        assert.equal(candles[0]!.volume, 150);
    });

    it("deduplicates by time and outputs ascending regardless of row order", () => {
        const iso = (ms: number) => new Date(ms).toISOString();
        const candles = parseCsvCandleLines([
            "time,open,high,low,close,volume",
            `${iso(1_700_000_002_000)},3,3,3,3,30`,
            `${iso(1_700_000_000_000)},1,1,1,1,10`,
            `${iso(1_700_000_001_000)},2,2,2,2,20`,
        ]);
        assert.deepEqual(
            candles.map((c) => Number(c.time)),
            [1_700_000_000, 1_700_000_001, 1_700_000_002]
        );
    });
});
