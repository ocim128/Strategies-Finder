import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    computeIncrementalStartTime,
    mergeCandlesByTime,
    normalizeSymbol,
    parseCsvCandleLines,
    parseHistoryCandles,
    parsePeriodToMs,
    parseResolvedContracts,
    resolveFromCatalog,
    type SyncRunState,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import { beginNdjsonStream } from "../lib/vite-http-utils";
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

describe("ibkr computeIncrementalStartTime", () => {
    it("backs up by 2 bars of overlap from the last known bar", () => {
        // 1d bars: 2-bar overlap = 2 * 86400s. Last bar at 2024-01-10 UTC.
        const lastTime = "2024-01-10T00:00:00.000Z";
        const start = computeIncrementalStartTime("1d", lastTime, Date.UTC(2024, 0, 20) / 1000);
        assert.equal(start, Math.floor(Date.UTC(2024, 0, 8) / 1000));
    });

    it("accepts a numeric unix-seconds lastTime", () => {
        const lastSeconds = Math.floor(Date.UTC(2024, 0, 10) / 1000);
        const start = computeIncrementalStartTime("1h", lastSeconds, Math.floor(Date.UTC(2024, 0, 20) / 1000));
        // 1h bars: 2-bar overlap = 7200s.
        assert.equal(start, lastSeconds - 7200);
    });

    it("returns null when there is no prior lastTime (first sync)", () => {
        assert.equal(computeIncrementalStartTime("1d", null, 1_700_000_000), null);
    });

    it("returns null for unsupported intervals", () => {
        assert.equal(computeIncrementalStartTime("2h", "2024-01-10T00:00:00.000Z", 1_700_000_000), null);
    });

    it("falls back to full sync when lastTime is in the future (clock skew)", () => {
        const futureIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        assert.equal(computeIncrementalStartTime("1d", futureIso), null);
    });

    it("falls back when lastTime cannot be parsed", () => {
        assert.equal(computeIncrementalStartTime("1d", "not-a-date", 1_700_000_000), null);
    });
});

describe("ibkr resolveFromCatalog", () => {
    const baseEntry = {
        symbol: "AAPL",
        markedSymbol: "AAPL\u2022",
        conid: "265598",
        exchange: "NASDAQ",
        primaryExchange: "NASDAQ",
        currency: "USD",
        intervals: {
            "1d": { firstTime: "2020-01-01T00:00:00.000Z", lastTime: "2024-01-10T00:00:00.000Z", bars: 1000, lastSyncAt: "2024-01-11T00:00:00.000Z" },
        },
    };

    it("builds a resolved contract from a fresh catalog entry", () => {
        const resolved = resolveFromCatalog(baseEntry, Date.parse("2024-01-12"));
        assert.equal(resolved?.conid, "265598");
        assert.equal(resolved?.symbol, "AAPL");
        assert.equal(resolved?.exchange, "NASDAQ");
    });

    it("returns null when the entry has no conid", () => {
        const resolved = resolveFromCatalog({ ...baseEntry, conid: undefined }, Date.parse("2024-01-12"));
        assert.equal(resolved, null);
    });

    it("returns null when the catalog entry is older than the conid TTL (7 days)", () => {
        // lastSyncAt 2024-01-11, "now" 2024-01-30 → 19 days stale.
        const resolved = resolveFromCatalog(baseEntry, Date.parse("2024-01-30"));
        assert.equal(resolved, null);
    });

    it("uses the most recent lastSyncAt across intervals", () => {
        const entry = {
            ...baseEntry,
            intervals: {
                "1d": { firstTime: null, lastTime: null, bars: 0, lastSyncAt: "2024-01-01T00:00:00.000Z" },
                "1h": { firstTime: null, lastTime: null, bars: 0, lastSyncAt: "2024-01-11T00:00:00.000Z" },
            },
        };
        const resolved = resolveFromCatalog(entry, Date.parse("2024-01-12"));
        assert.equal(resolved?.conid, "265598");
    });

    it("returns null when no interval has a parseable lastSyncAt", () => {
        const resolved = resolveFromCatalog({ ...baseEntry, intervals: {} }, Date.parse("2024-01-12"));
        assert.equal(resolved, null);
    });
});

describe("beginNdjsonStream", () => {
    // `captured` is the single source of truth. The fake `res` exposes array
    // and object fields by reference (so they stay in sync), and primitive
    // counters stay on `captured` — read those from `captured` directly,
    // because object spread would copy primitives by value and lose updates.
    type Captured = {
        writes: string[];
        endCalls: number;
        statusCode: number;
        headers: Record<string, string>;
        write: (body: string) => boolean;
        end: (body: string) => void;
        setHeader: (name: string, value: string) => void;
    };

    function makeFakeRes(): Captured {
        const captured: Captured = {
            writes: [],
            endCalls: 0,
            statusCode: 0,
            headers: {},
            write: (body: string) => { captured.writes.push(body); return true; },
            end: () => { captured.endCalls += 1; },
            setHeader: (name: string, value: string) => { captured.headers[name] = value; },
        };
        return captured;
    }

    it("sets NDJSON content-type and no-store cache headers", () => {
        const res = makeFakeRes();
        const stream = beginNdjsonStream(res);
        stream.write({ type: "x" });
        stream.end();
        assert.equal(res.headers["Content-Type"], "application/x-ndjson; charset=utf-8");
        assert.equal(res.headers["Cache-Control"], "no-store");
        assert.equal(res.statusCode, 200);
    });

    it("writes each event as a JSON line terminated by newline", () => {
        const res = makeFakeRes();
        const stream = beginNdjsonStream(res);
        stream.write({ type: "start", total: 3 });
        stream.write({ type: "symbol", index: 0, total: 3, symbol: "AAPL" });
        const allWrites = res.writes.join("");
        assert.match(allWrites, /^\{"type":"start","total":3\}\n/);
        assert.match(allWrites, /\n\{"type":"symbol","index":0,"total":3,"symbol":"AAPL"\}\n$/);
    });

    it("end() writes a final event when supplied, then closes the stream", () => {
        const res = makeFakeRes();
        const stream = beginNdjsonStream(res);
        stream.end({ type: "done", ok: true });
        assert.equal(res.writes.length, 1);
        assert.match(res.writes[0]!, /^\{"type":"done","ok":true\}\n$/);
        assert.equal(res.endCalls, 1);
    });

    it("end() without a final event just closes the stream", () => {
        const res = makeFakeRes();
        const stream = beginNdjsonStream(res);
        stream.write({ type: "x" });
        stream.end();
        assert.equal(res.writes.length, 1);
        assert.equal(res.endCalls, 1);
    });

    it("throws when the response has no write method (non-streaming res)", () => {
        // Simulate a one-shot-only response object.
        const res = { statusCode: 0, setHeader() { /* noop */ }, end() { /* noop */ } };
        assert.throws(() => beginNdjsonStream(res as any), /NDJSON streaming requires/);
    });
});

describe("ibkr SyncRunState (sync/status contract)", () => {
    // Pins the field names and shape that GET /api/ibkr/sync/status returns.
    // The browser-side IbkrSyncRunSnapshot mirrors this shape, so any field
    // rename here must be reflected in ibkr-data-service.ts — this test makes
    // such drift fail loudly instead of silently breaking reattach polling.
    it("exposes the documented fields with the documented types", () => {
        const snapshot: SyncRunState = {
            startedAt: "2026-07-04T00:00:00.000Z",
            mode: "sync",
            interval: "1d",
            period: "max",
            total: 20,
            index: 5,
            completed: 5,
            failed: 0,
            currentSymbol: "NVDA",
            failedSymbols: [],
            cancelled: false,
        };
        // No assertions on values needed; if the literal above fails to type-
        // check or any field is removed/renamed in SyncRunState, this test
        // fails to compile. The shape IS the contract.
        assert.equal(snapshot.mode, "sync");
        assert.equal(snapshot.completed, 5);
        assert.equal(snapshot.currentSymbol, "NVDA");
        assert.equal(snapshot.cancelled, false);
        assert.deepEqual(snapshot.failedSymbols, []);
    });

    it("accepts both 'sync' and 'download' modes", () => {
        const sync: SyncRunState = { ...minimalSnapshot(), mode: "sync" };
        const download: SyncRunState = { ...minimalSnapshot(), mode: "download" };
        assert.equal(sync.mode, "sync");
        assert.equal(download.mode, "download");
    });

    it("supports the cancelled state for stop-mid-batch", () => {
        const cancelled: SyncRunState = {
            ...minimalSnapshot(),
            cancelled: true,
            failedSymbols: [{ symbol: "BAD", error: "stopped" }],
        };
        assert.equal(cancelled.cancelled, true);
        assert.equal(cancelled.failedSymbols.length, 1);
    });

    function minimalSnapshot(): SyncRunState {
        return {
            startedAt: "2026-07-04T00:00:00.000Z",
            mode: "sync",
            interval: "1d",
            period: null,
            total: 0,
            index: 0,
            completed: 0,
            failed: 0,
            currentSymbol: null,
            failedSymbols: [],
            cancelled: false,
        };
    }
});
