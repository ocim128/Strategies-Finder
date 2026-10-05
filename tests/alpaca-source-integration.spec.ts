/**
 * Source-integration tests for the Alpaca path through `processSyncBatch`.
 *
 * Locks the Phase 1 source contract:
 *  - Existing IBKR requests (no `source`) remain unchanged → ibkr fetcher.
 *  - `source: "alpaca"` selects the Alpaca worker.
 *  - Alpaca supports the IBKR menu's 30m and 1d intervals, while other
 *    intervals are rejected.
 *  - Alpaca + period=max maps to a full historical window.
 *  - Alpaca sync against an unknown/IBKR interval is rejected (source guard).
 *  - Alpaca download establishes `source: "alpaca"` in the catalog.
 *  - The terminal `done` event and the run snapshot carry `source`.
 *
 * No real network, no real Alpaca creds: the Alpaca worker is injected as a
 * test seam (`alpacaFetcher`), matching the existing IBKR lifecycle spec's
 * pattern for `fetcher`.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    __acquireIbkrSyncOwnerForTests,
    __getIbkrCatalogWriteCountForTests,
    __getIbkrSyncRunStateForTests,
    __resetIbkrSyncStateForTests,
    assertSourceConstraints,
    mapAlpacaStopReason,
    normalizeDataSource,
    processSyncBatch,
    resolveAlpacaWindow,
    syncOneAlpacaSymbol,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import { HttpStatusError } from "../lib/vite-http-utils";
import type { AlpacaConfig } from "../lib/ibkr-data/alpaca-fetcher";
import { waitFor } from "./helpers/wait-for";
import { withTimeout } from "./helpers/with-timeout";

// Minimal AlpacaConfig for the injected worker (creds are not used in the
// source-guard path — the worker rejects before any fetch).
const STUB_CONFIG: AlpacaConfig = {
    apiKey: "PKTEST",
    apiSecret: "test",
    host: "https://data.alpaca.markets",
    feed: "iex",
    adjustment: "split",
};

// Signature the injected Alpaca worker must satisfy (matches
// `syncOneAlpacaSymbol` minus the optional `config` arg the wrapper fills).
type AlpacaFetcher = (
    catalog: unknown,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean,
    signal?: AbortSignal,
    config?: unknown,
) => Promise<Record<string, unknown>>;

const alpacaResult = (symbol: string, bars = 10): Record<string, unknown> => ({
    symbol,
    markedSymbol: `IBKR:${symbol}`,
    interval: "30m",
    bars,
    fetchedBars: bars,
    firstTime: "2026-01-01T00:00:00.000Z",
    lastTime: "2026-01-02T00:00:00.000Z",
    filePath: `/tmp/${symbol}.csv`,
    complete: true,
    stopReason: "covered",
    source: "alpaca",
});

describe("alpaca normalizeDataSource (backward compatibility + typo rejection)", () => {
    it("defaults to ibkr when source is absent or blank (existing IBKR requests unchanged)", () => {
        assert.equal(normalizeDataSource(undefined), "ibkr");
        assert.equal(normalizeDataSource(null), "ibkr");
        assert.equal(normalizeDataSource(""), "ibkr");
        assert.equal(normalizeDataSource("   "), "ibkr");
    });

    it("recognizes alpaca case-insensitively", () => {
        assert.equal(normalizeDataSource("alpaca"), "alpaca");
        assert.equal(normalizeDataSource("ALPACA"), "alpaca");
        assert.equal(normalizeDataSource("  Alpaca "), "alpaca");
    });

    it("accepts explicit ibkr", () => {
        assert.equal(normalizeDataSource("ibkr"), "ibkr");
        assert.equal(normalizeDataSource("IBKR"), "ibkr");
    });

    it("rejects an unknown non-empty source with HTTP 400 (audit Finding 2: no silent IBKR fallback)", () => {
        // A typo like "alpacca" used to silently route to IBKR, recreating
        // the rate-limit problem the source selector exists to avoid. It
        // must now surface as an explicit 400 at the request boundary.
        for (const bad of ["alpacca", "tiingo", "polygon", "bloomberg", "IBKR!", "alpaca-ibkr"]) {
            assert.throws(
                () => normalizeDataSource(bad),
                (error: unknown) => error instanceof HttpStatusError
                    && error.status === 400
                    && /Unknown data source/i.test(error.message),
                `expected "${bad}" to be rejected with HTTP 400`,
            );
        }
    });
});

describe("alpaca assertSourceConstraints", () => {
    it("passes for ibkr with any interval/period (existing behavior unchanged)", () => {
        // Should not throw.
        assertSourceConstraints("ibkr", "1d", "max");
        assertSourceConstraints("ibkr", "30m", "1y");
    });

    it("accepts Alpaca 30m and 1d, but rejects unsupported intervals", () => {
        assert.doesNotThrow(() => assertSourceConstraints("alpaca", "30m", "1y"));
        assert.doesNotThrow(() => assertSourceConstraints("alpaca", "1d", "1y"));
        assert.throws(
            () => assertSourceConstraints("alpaca", "4h", "1y"),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 400
                && /30m and 1d/.test(error.message),
        );
    });

    it("accepts Alpaca max/all history periods", () => {
        assert.doesNotThrow(() => assertSourceConstraints("alpaca", "30m", "max"));
        assert.doesNotThrow(() => assertSourceConstraints("alpaca", "30m", "all"));
    });

    it("accepts Alpaca + 30m + bounded period", () => {
        // Should not throw.
        assertSourceConstraints("alpaca", "30m", "1m");
        assertSourceConstraints("alpaca", "30m", "6m");
        assertSourceConstraints("alpaca", "30m", "1y");
    });
});

describe("alpaca resolveAlpacaWindow", () => {
    it("produces [end-period, now] for a bounded download", () => {
        const now = Date.UTC(2026, 0, 31, 0, 0, 0); // 2026-01-31T00:00:00Z
        const window = resolveAlpacaWindow("1m", now);
        // 1m period ≈ 30 days → start = 2026-01-01T00:00:00Z.
        assert.equal(window.end, "2026-01-31T00:00:00.000Z");
        assert.equal(window.start, "2026-01-01T00:00:00.000Z");
    });

    it("honors the incremental startOverride (sync overlap)", () => {
        const now = Date.UTC(2026, 0, 31, 0, 0, 0);
        const lastBarMs = Date.UTC(2026, 0, 30, 0, 0, 0); // 2026-01-30
        const window = resolveAlpacaWindow("1m", now, lastBarMs);
        assert.equal(window.end, "2026-01-31T00:00:00.000Z");
        // startOverride wins over end-period.
        assert.equal(window.start, "2026-01-30T00:00:00.000Z");
    });

    it("maps max to the earliest representable request start", () => {
        const now = Date.UTC(2026, 0, 31, 0, 0, 0);
        const window = resolveAlpacaWindow("max", now);
        assert.equal(window.start, "1970-01-01T00:00:00.000Z");
        assert.equal(window.end, "2026-01-31T00:00:00.000Z");
    });

    it("rejects an unparseable period", () => {
        assert.throws(
            () => resolveAlpacaWindow("garbage"),
            (error: unknown) => error instanceof HttpStatusError && error.status === 400,
        );
    });
});

describe("alpaca processSyncBatch source routing", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());
    afterEach(() => __resetIbkrSyncStateForTests());

    it("routes to the alpaca worker when source=alpaca and emits source on every event", async () => {
        const events: Array<Record<string, unknown>> = [];
        let workerCalls = 0;
        let lastWorkerSource: string | undefined;
        const alpacaFetcher = (async (_cat, symbol) => {
            workerCalls += 1;
            const result = alpacaResult(symbol);
            lastWorkerSource = String(result.source);
            return result;
        }) as AlpacaFetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        assert.equal(workerCalls, 1);
        assert.equal(lastWorkerSource, "alpaca");
        const start = events[0]!;
        const done = events[events.length - 1]!;
        assert.equal(start.type, "start");
        assert.equal(start.source, "alpaca");
        assert.equal(done.type, "done");
        assert.equal(done.source, "alpaca");
    });

    it("passes Alpaca crypto pair symbols through without routing them to IBKR", async () => {
        let fetchedSymbol = "";
        const alpacaFetcher = (async (_cat, symbol) => {
            fetchedSymbol = symbol;
            return alpacaResult(symbol);
        }) as AlpacaFetcher;
        await processSyncBatch(
            { symbols: ["PAXG/USD"], interval: "1d", period: "1m", source: "alpaca" },
            false,
            () => {},
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        assert.equal(fetchedSymbol, "PAXG/USD");
    });

    it("emits symbol_warning when the Alpaca worker returns incomplete (page ceiling, audit F1)", async () => {
        // Locks the F1 end-to-end contract: when syncOneAlpacaSymbol maps a
        // fetcher page_limit onto complete:false + chunk_limit, the batch
        // loop's existing incomplete-result path MUST fire symbol_warning so
        // the UI does NOT silently present truncated data as a full history.
        const events: Array<Record<string, unknown>> = [];
        const alpacaFetcher = (async (_cat, symbol) => ({
            ...alpacaResult(symbol),
            complete: false,
            stopReason: "chunk_limit", // the catalog-mapped value the worker returns
            warning: "Hit the maximum chunk ceiling before the full history was covered.",
        })) as AlpacaFetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "30m", period: "1y", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        const warnings = events.filter((e) => e.type === "symbol_warning");
        assert.equal(warnings.length, 1);
        assert.equal((warnings[0]!).complete, false);
        assert.match(String((warnings[0]!).reason), /chunk ceiling/);
        // The run is still ok overall — the truncated data landed and is
        // usable, just flagged incomplete (mirrors the IBKR partial-max path).
        const done = events[events.length - 1]!;
        assert.equal(done.ok, true);
    });

    it("rejects Alpaca + 4h interval before invoking any worker", async () => {
        let workerCalls = 0;
        const alpacaFetcher = (async () => {
            workerCalls += 1;
            return alpacaResult("AAPL");
        }) as AlpacaFetcher;
        await assert.rejects(
            processSyncBatch(
                { symbols: ["AAPL"], interval: "4h", period: "1y", source: "alpaca" },
                false,
                () => {},
                __acquireIbkrSyncOwnerForTests(),
                { alpacaFetcher: alpacaFetcher as never },
            ),
            (error: unknown) => error instanceof HttpStatusError && error.status === 400,
        );
        assert.equal(workerCalls, 0, "no worker call should happen when constraints reject");
    });

    it("passes Alpaca + period=max to the worker", async () => {
        let workerCalls = 0;
        let workerPeriod = "";
        const alpacaFetcher = (async (_catalog, _symbol, _interval, period) => {
            workerCalls += 1;
            workerPeriod = period;
            return alpacaResult("AAPL");
        }) as AlpacaFetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "30m", period: "max", source: "alpaca" },
            false,
            () => {},
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        assert.equal(workerCalls, 1);
        assert.equal(workerPeriod, "max");
    });

    it("existing IBKR requests with no source still route to the ibkr fetcher", async () => {
        const events: Array<Record<string, unknown>> = [];
        let ibkrWorkerCalls = 0;
        // The `fetcher` seam is the IBKR path; verify the Alpaca worker is
        // NOT called when source is absent.
        let alpacaWorkerCalls = 0;
        const ibkrFetcher = (async (_cat: unknown, symbol: string) => {
            ibkrWorkerCalls += 1;
            return {
                symbol,
                markedSymbol: `IBKR:${symbol}`,
                interval: "1d",
                bars: 5,
                fetchedBars: 5,
                firstTime: "2026-01-01T00:00:00.000Z",
                lastTime: "2026-01-02T00:00:00.000Z",
                filePath: `/tmp/${symbol}.csv`,
                conid: "12345",
                complete: true,
                stopReason: "covered",
            };
        }) as unknown as AlpacaFetcher;
        const alpacaFetcher = (async () => {
            alpacaWorkerCalls += 1;
            return alpacaResult("X");
        }) as AlpacaFetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d", period: "1y" }, // no source
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: ibkrFetcher as never, alpacaFetcher: alpacaFetcher as never },
        );
        assert.equal(ibkrWorkerCalls, 1);
        assert.equal(alpacaWorkerCalls, 0);
        const start = events[0]!;
        const done = events[events.length - 1]!;
        // Backward compat: source defaults to "ibkr" on the wire too.
        assert.equal(start.source, "ibkr");
        assert.equal(done.source, "ibkr");
    });
});

describe("alpaca syncOneAlpacaSymbol source guard", () => {
    // The catalog shape is opaque (not exported), so we construct a minimal
    // object the worker can read via `findCatalogEntry`. The source guard
    // rejects before any filesystem I/O, so no temp CSVs are touched here.
    type CatalogLike = { entries: Array<{ symbol: string; intervals: Record<string, { source?: string; lastTime?: string }> }> };

    it("rejects sync against an unknown (no source) interval — instructs Download first", async () => {
        const catalog: CatalogLike = {
            entries: [{ symbol: "AAPL", intervals: { "30m": { lastTime: "2026-01-01T00:00:00Z" } } }],
        };
        await assert.rejects(
            syncOneAlpacaSymbol(catalog as never, "AAPL", "30m", "1m", true, undefined, STUB_CONFIG),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 409
                && /unknown|pre-Alpaca|Download first/i.test(error.message),
        );
    });

    it("rejects sync against an IBKR-sourced interval — never merge Alpaca into IBKR", async () => {
        const catalog: CatalogLike = {
            entries: [{ symbol: "AAPL", intervals: { "30m": { source: "ibkr", lastTime: "2026-01-01T00:00:00Z" } } }],
        };
        await assert.rejects(
            syncOneAlpacaSymbol(catalog as never, "AAPL", "30m", "1m", true, undefined, STUB_CONFIG),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 409
                && /current: ibkr|Download first/i.test(error.message),
        );
    });

    it("rejects sync against a missing entry entirely (no catalog row at all)", async () => {
        const catalog: CatalogLike = { entries: [] };
        await assert.rejects(
            syncOneAlpacaSymbol(catalog as never, "AAPL", "30m", "1m", true, undefined, STUB_CONFIG),
            (error: unknown) => error instanceof HttpStatusError && error.status === 409,
        );
    });
});

describe("alpaca mapAlpacaStopReason (catalog schema mapping)", () => {
    // Audit Finding 1: the fetcher reports its own page ceiling as
    // `page_limit`, but the catalog's documented stopReason schema calls this
    // `chunk_limit`. The mapping keeps the catalog schema stable while letting
    // the fetcher honestly report its own condition. Without this mapping, a
    // `page_limit` value would be persisted verbatim into IbkrIntervalMeta and
    // break the documented schema contract.
    it("maps page_limit → chunk_limit (catalog schema equivalent)", () => {
        assert.equal(mapAlpacaStopReason("page_limit"), "chunk_limit");
    });

    it("passes covered and cancelled through unchanged", () => {
        assert.equal(mapAlpacaStopReason("covered"), "covered");
        assert.equal(mapAlpacaStopReason("cancelled"), "cancelled");
    });
});

describe("alpaca processSyncBatch typo rejection (audit Finding 2)", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());
    afterEach(() => __resetIbkrSyncStateForTests());

    it("rejects a typo'd source with HTTP 400 before invoking any worker", async () => {
        let ibkrCalls = 0;
        let alpacaCalls = 0;
        await assert.rejects(
            processSyncBatch(
                { symbols: ["AAPL"], interval: "1d", period: "1y", source: "alpacca" }, // typo
                false,
                () => {},
                __acquireIbkrSyncOwnerForTests(),
                {
                    fetcher: (async () => { ibkrCalls += 1; return {}; }) as never,
                    alpacaFetcher: (async () => { alpacaCalls += 1; return {}; }) as never,
                },
            ),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 400
                && /Unknown data source/i.test(error.message),
        );
        // No fetcher call should happen — the typo must be caught at the
        // request boundary, not routed to IBKR.
        assert.equal(ibkrCalls, 0);
        assert.equal(alpacaCalls, 0);
    });

    it("still routes a missing source to the ibkr fetcher (backward compat preserved)", async () => {
        // Confirm the F2 tightening did NOT break the documented backward-
        // compat contract: absent `source` still means IBKR.
        const events: Array<Record<string, unknown>> = [];
        let ibkrCalls = 0;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d", period: "1y" }, // no source key
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            {
                fetcher: (async (_cat: unknown, symbol: string) => {
                    ibkrCalls += 1;
                    return { symbol, markedSymbol: `IBKR:${symbol}`, interval: "1d", bars: 1, fetchedBars: 1, complete: true, stopReason: "covered" };
                }) as never,
            },
        );
        assert.equal(ibkrCalls, 1);
        assert.equal(events[0]!.source, "ibkr");
    });
});

describe("alpaca syncOneAlpacaSymbol cross-source Download records source:mixed", () => {
    // Audit follow-up to the data-loss incident: Alpaca Download onto an
    // existing IBKR-sourced interval must now MERGE (preserve the IBKR
    // history) AND honestly label the catalog `source: "mixed"` so the file
    // is never silently passed off as single-source. The "mixed" label makes
    // subsequent Alpaca syncs preserve both the rows and the honest "mixed"
    // label. Uses sentinel SYMBOLS at the real 30m interval (the only one
    // Alpaca supports) and cleans them up in afterEach. The symbols are
    // obviously-test names that will never collide with real tickers.
    const originalFetch = globalThis.fetch;
    const SEED_SYMBOL = "ZZXMIX";
    const FRESH_SYMBOL = "ZZXFRSH";
    const FALLBACK_SYMBOL = "ZZXFALL";
    const GAP_SYMBOL = "ZZXGAP";
    const DAILY_SYMBOL = "ZZXEMPTY";

    beforeEach(() => {
        // Stub fetch to return one Alpaca-shaped bar so the worker has data
        // to merge. No real network, no real creds.
        globalThis.fetch = (async (input: RequestInfo | URL) => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => input.toString().includes("/corporate-actions")
                ? { corporate_actions: {} }
                : { bars: [{ t: "2026-07-23T19:30:00Z", o: 207, h: 209, l: 206, c: 208, v: 1000 }] },
            text: async () => "",
        }) as unknown as Response) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        // Clean up any sentinel-symbol files the worker wrote (CSV + .bak).
        const { resolve } = require("node:path");
        const { rmSync, existsSync } = require("node:fs");
        const dir = resolve(process.cwd(), "price-data", "ibkr", "csv", "30m");
        for (const sym of [SEED_SYMBOL, FRESH_SYMBOL, FALLBACK_SYMBOL, GAP_SYMBOL]) {
            for (const ext of [".csv", ".csv.bak", ".csv.tmp"]) {
                const p = resolve(dir, `${sym}${ext}`);
                if (existsSync(p)) rmSync(p, { force: true });
            }
        }
        const dailyDir = resolve(process.cwd(), "price-data", "ibkr", "csv", "1d");
        for (const ext of [".csv", ".csv.bak", ".csv.tmp"]) {
            const p = resolve(dailyDir, `${DAILY_SYMBOL}${ext}`);
            if (existsSync(p)) rmSync(p, { force: true });
        }
    });

    it("removes saved daily placeholders during a bounded Alpaca merge and updates catalog counts", async () => {
        const { getCsvPath } = await import("../lib/ibkr-data/ibkr-data-vite-plugin");
        const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
        const { resolve } = require("node:path");
        const seedPath = getCsvPath(DAILY_SYMBOL, "1d");
        mkdirSync(resolve(seedPath, ".."), { recursive: true });
        writeFileSync(seedPath, [
            "time,open,high,low,close,volume",
            "2026-09-03T04:00:00Z,12.89,20.5,12.7,18.48,7598",
            "2026-09-04T04:00:00Z,0.3696,0.3696,0.3696,0.3696,0",
            "",
        ].join("\n"));
        globalThis.fetch = async input => new Response(JSON.stringify(
            String(input).includes("/corporate-actions") ? { corporate_actions: {} } : { bars: [
                { t: "2026-09-08T04:00:00Z", o: 18.585, h: 20, l: 18.425, c: 19.99, v: 7674 },
                { t: "2026-09-09T04:00:00Z", o: 19.1, h: 19.1, l: 19.1, c: 19.1, v: 0 },
            ] },
        ));
        const catalog = { entries: [{ symbol: DAILY_SYMBOL, intervals: { "1d": {
            source: "alpaca", alpacaFeed: "iex", alpacaAdjustment: "split", splitAdjustedThrough: "2026-10-03",
            bars: 2, firstTime: "2026-09-03T04:00:00Z", lastTime: "2026-09-04T04:00:00Z", lastSyncAt: "2026-10-03T00:00:00Z",
        } } }] };
        const result = await syncOneAlpacaSymbol(catalog as never, DAILY_SYMBOL, "1d", "1m", false, undefined, STUB_CONFIG);
        const csv = readFileSync(seedPath, "utf8") as string;
        assert.ok(csv.includes("2026-09-03") && csv.includes("2026-09-08"), "traded history survives");
        assert.ok(!csv.includes("2026-09-04") && !csv.includes("2026-09-09"), "old and fetched placeholders excluded");
        assert.equal(result.bars, 2);
        assert.equal(result.fetchedBars, 1);
        assert.equal(catalog.entries[0].intervals["1d"].bars, 2);
        assert.ok(readFileSync(`${seedPath}.bak`, "utf8").includes("0.3696"), "backup preserves the original CSV");
    });

    it("merges Alpaca bars onto an existing IBKR-sourced interval and labels it mixed", async () => {
        const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
        const { resolve } = require("node:path");
        const { getCsvPath, syncOneAlpacaSymbol } = await import("../lib/ibkr-data/ibkr-data-vite-plugin");
        // Seed an existing "IBKR" 30m CSV with one OLD bar the Alpaca fetch
        // does NOT overlap. The fetch stub returns 2026-07-23; this seed is
        // 2020-01-01 so the merge must keep both.
        const seedPath = getCsvPath(SEED_SYMBOL, "30m");
        mkdirSync(resolve(seedPath, ".."), { recursive: true });
        writeFileSync(seedPath, "time,open,high,low,close,volume\n2020-01-01T00:00:00.000Z,100,100,100,100,500\n");

        const catalog = {
            entries: [{
                symbol: SEED_SYMBOL,
                intervals: { "30m": { source: "ibkr", lastTime: "2020-01-01T00:00:00Z", firstTime: "2020-01-01T00:00:00Z", bars: 1, lastSyncAt: "2020-01-01T00:00:00Z" } },
            }],
        };
        const config = { apiKey: "PK", apiSecret: "sk", host: "https://data.alpaca.markets", feed: "iex", adjustment: "split" };
        // Download (syncOnly=false) -> should merge, not replace.
        const result = await syncOneAlpacaSymbol(catalog as never, SEED_SYMBOL, "30m", "1m", false, undefined, config as never);
        // Catalog source is "mixed" because the existing source was "ibkr".
        assert.equal(result.source, "mixed");
        assert.equal(catalog.entries[0].intervals["30m"].source, "mixed");
        // The merged CSV preserves BOTH the old IBKR bar AND the new Alpaca bar.
        const merged = readFileSync(seedPath, "utf8").split(/\r?\n/).filter(Boolean);
        assert.ok(merged.length >= 3, `expected >=3 lines (header + 2 bars), got ${merged.length}`);
        assert.ok(merged.some((l: string) => l.startsWith("2020-01-01")), "old IBKR bar preserved (no data loss)");
        assert.ok(merged.some((l: string) => l.startsWith("2026-07-23")), "new Alpaca bar merged");

        // A mixed interval already contains Alpaca rows, so it must support
        // later incremental Alpaca updates instead of trapping the user in a
        // "Download first" loop. The catalog stays honestly marked mixed.
        const syncResult = await syncOneAlpacaSymbol(catalog as never, SEED_SYMBOL, "30m", "1w", true, undefined, config as never);
        assert.equal(syncResult.source, "mixed");
        assert.equal(catalog.entries[0].intervals["30m"].source, "mixed");
    });

    it("records source:alpaca (NOT mixed) when the interval is fresh (no prior bars)", async () => {
        const { getCsvPath, syncOneAlpacaSymbol } = await import("../lib/ibkr-data/ibkr-data-vite-plugin");
        const { existsSync } = require("node:fs");
        // No seed file — fresh interval. Catalog has no entry for the symbol.
        const catalog = {
            entries: [] as Array<{
                symbol: string;
                intervals: Record<string, { source: string }>;
            }>,
        };
        const config = { apiKey: "PK", apiSecret: "sk", host: "https://data.alpaca.markets", feed: "iex", adjustment: "split" };
        const result = await syncOneAlpacaSymbol(catalog as never, FRESH_SYMBOL, "30m", "1m", false, undefined, config as never);
        assert.equal(result.source, "alpaca");
        assert.equal(catalog.entries[0].intervals["30m"].source, "alpaca");
        // And the new file got written.
        assert.ok(existsSync(getCsvPath(FRESH_SYMBOL, "30m")), "fresh CSV was written");
    });

    it("marks a large Alpaca source gap incomplete without fabricating bars", async () => {
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ bars: [
                { t: "2023-06-19T14:30:00Z", o: 1816, h: 1817, l: 1815, c: 1816.9, v: 1 },
                { t: "2026-02-12T12:00:00Z", o: 5070, h: 5071, l: 5069, c: 5070.815, v: 1 },
            ] }),
            text: async () => "",
        }) as unknown as Response) as typeof fetch;
        const catalog = { entries: [] as Array<{ symbol: string; intervals: Record<string, { complete?: boolean; stopReason?: string }> }> };
        const config = { apiKey: "PK", apiSecret: "sk", host: "https://data.alpaca.markets", feed: "iex", adjustment: "split" };
        const result = await syncOneAlpacaSymbol(catalog as never, GAP_SYMBOL, "30m", "max", false, undefined, config as never);
        assert.equal(result.complete, false);
        assert.equal(result.stopReason, "data_gap");
        assert.match(String(result.warning), /missing bars were not reconstructed/);
        assert.equal(catalog.entries[0]!.intervals["30m"]!.complete, false);
        assert.equal(catalog.entries[0]!.intervals["30m"]!.stopReason, "data_gap");
    });

    it("reports an empty short download without fetching outside the requested window", async () => {
        const requestedUrls: string[] = [];
        let calls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            requestedUrls.push(input.toString());
            calls += 1;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => calls === 1
                    ? { bars: [] }
                    : { bars: [{ t: "2026-07-24T19:30:00Z", o: 207, h: 209, l: 206, c: 208, v: 1000 }] },
                text: async () => "",
            } as unknown as Response;
        }) as typeof fetch;
        const catalog = {
            entries: [] as Array<{
                symbol: string;
                intervals: Record<string, { source: string }>;
            }>,
        };
        const config = { apiKey: "PK", apiSecret: "sk", host: "https://data.alpaca.markets", feed: "iex", adjustment: "split" };

        await assert.rejects(
            syncOneAlpacaSymbol(catalog as never, FALLBACK_SYMBOL, "30m", "1d", false, undefined, config as never),
            /returned no 30m bars.*requested window/,
        );
        assert.equal(calls, 1);
        const request = new URL(requestedUrls[0]!);
        assert.equal(Date.parse(request.searchParams.get("end")!) - Date.parse(request.searchParams.get("start")!), 24 * 60 * 60 * 1000);
        assert.equal(catalog.entries.length, 0);
    });
});



describe("alpaca processSyncBatch bounded parallel dispatch", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());
    afterEach(() => __resetIbkrSyncStateForTests());

    const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> => {
        const startedAt = Date.now();
        while (!predicate()) {
            if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
        }
    };

    it("keeps at most 3 symbols in flight and releases symbol events in ascending index order", async () => {
        // Deferred worker: each symbol's completion is held until the test
        // resolves it, so in-flight concurrency is directly observable. The
        // dispatcher runs a sliding window: resolving one symbol immediately
        // dispatches the next, so the test drains whatever is in flight
        // instead of expecting fixed window boundaries.
        const symbols = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"];
        const events: Array<Record<string, unknown>> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const deferred = new Map<string, () => void>();
        let started = 0;
        const alpacaFetcher = (async (_cat: unknown, symbol: string) => {
            started += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise<void>((resolveFetch) => deferred.set(symbol, resolveFetch));
            inFlight -= 1;
            return alpacaResult(symbol);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );

        await waitFor(() => deferred.size === 3, "the dispatch frontier to fill 3 slots");
        assert.equal(maxInFlight, 3, "concurrency must be bounded at 3 in-flight symbols");

        // Drain all 7 symbols, resolving whatever is currently in flight
        // (map iteration order resolves newer symbols first, exercising
        // out-of-order completion against the ordered release loop).
        let resolved = 0;
        while (resolved < symbols.length) {
            await waitFor(() => deferred.size > 0, "in-flight work to resolve");
            for (const [symbol, resolveFetch] of [...deferred]) {
                deferred.delete(symbol);
                resolveFetch();
                resolved += 1;
            }
        }
        await run;

        assert.equal(started, symbols.length, "every symbol must be dispatched exactly once");
        assert.equal(maxInFlight, 3, "in-flight must never exceed 3 across the whole run");
        const symbolEvents = events.filter((e) => e.type === "symbol");
        assert.deepEqual(
            symbolEvents.map((e) => e.symbol),
            symbols,
            "symbol events must be emitted in ascending original index order",
        );
        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.ok, true);
    });

    it("writes the catalog once per completed symbol and stops writing after Stop", async () => {
        const symbols = ["C0", "C1", "C2", "C3", "C4", "C5"];
        const events: Array<Record<string, unknown>> = [];
        const deferred = new Map<string, () => void>();
        const controller = new AbortController();
        const alpacaFetcher = (async (
            _cat: unknown,
            symbol: string,
            _interval: string,
            _period: string,
            _syncOnly: boolean,
            signal?: AbortSignal,
        ) => {
            await new Promise<void>((resolveFetch) => deferred.set(symbol, resolveFetch));
            // Mirror syncOneAlpacaSymbol: an aborted signal yields a cancelled
            // result with NO writes (the CSV/catalog write is skipped).
            if (signal?.aborted) {
                return { ...alpacaResult(symbol), cancelled: true, complete: false };
            }
            return alpacaResult(symbol);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { signal: controller.signal, alpacaFetcher: alpacaFetcher as never },
        );

        await waitFor(() => deferred.size === 3, "the first 3 symbols to dispatch");
        for (const symbol of ["C0", "C1", "C2"]) deferred.get(symbol)!();
        await waitFor(
            () => __getIbkrCatalogWriteCountForTests() === 3,
            "one catalog write per completed symbol",
        );

        // Stop mid-flight: resolve the in-flight window so the workers observe
        // the aborted signal and return cancelled results (no writes), and no
        // further symbols are dispatched.
        controller.abort();
        await waitFor(() => deferred.size > 0, "the next window to be in flight");
        for (const [, resolveFetch] of [...deferred]) resolveFetch();
        await run;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
        assert.equal(
            __getIbkrCatalogWriteCountForTests(),
            3,
            "cancelled symbols must not add catalog writes",
        );
        const symbolEvents = events.filter((e) => e.type === "symbol");
        assert.deepEqual(symbolEvents.map((e) => e.symbol), ["C0", "C1", "C2"]);
        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.cancelled, true);
    });
});

/**
 * Characterization tests for `processSyncBatch`'s settlement and release
 * timing, recorded against the recursive dispatch/inFlight scheduler before
 * the worker-loop simplification. They lock the behaviors the plain
 * concurrency test cannot see: the batch promise can settle BEFORE sibling
 * fetches finish; a release-time writer failure rejects the awaited promise
 * while sibling fetches keep running (their outcomes are dropped, never
 * unhandled rejections); a returned cancellation without a signal abort
 * leaves a permanent index gap that strands every later outcome while the
 * sibling release paths still dispatch the remaining queue (a known lifecycle
 * wart, kept verbatim by the simplification and deliberately NOT corrected
 * here); and a bare AbortError from a fetcher is batch cancellation, not
 * per-symbol failure accounting.
 */
describe("alpaca processSyncBatch settlement characterization", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());
    afterEach(() => __resetIbkrSyncStateForTests());

    function makeDeferredAlpacaFetcher(options?: {
        onCall?: (symbol: string) => void;
    }): {
        fetcher: AlpacaFetcher;
        deferred: Map<string, () => void>;
        calls: string[];
    } {
        const deferred = new Map<string, () => void>();
        const calls: string[] = [];
        const fetcher = (async (_cat: unknown, symbol: string) => {
            calls.push(symbol);
            options?.onCall?.(symbol);
            await new Promise<void>((resolveFetch) => deferred.set(symbol, resolveFetch));
            deferred.delete(symbol);
            return alpacaResult(symbol);
        }) as AlpacaFetcher;
        return { fetcher, deferred, calls };
    }

    it("settles the batch promise while in-window siblings are unresolved when a returned cancellation releases first", async () => {
        // A returned cancellation (result.cancelled, no signal abort) at index 0
        // releases the cancelled outcome, marks the run cancelled, and settles
        // the batch while the rest of the dispatch window is still in flight.
        const { fetcher, deferred } = makeDeferredAlpacaFetcher();
        const events: Array<Record<string, unknown>> = [];
        let callCount = 0;
        const countingFetcher = (async (...args: Parameters<AlpacaFetcher>) => {
            callCount += 1;
            if (callCount === 1) {
                return { ...alpacaResult("R0"), cancelled: true, complete: false, stopReason: "cancelled" };
            }
            return fetcher(...args);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols: ["R0", "R1", "R2"], interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: countingFetcher as never },
        );
        await withTimeout(run, 5000, "the batch to settle at the cancelled release");

        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.cancelled, true);
        assert.equal(done.ok, false);
        assert.equal(callCount, 3, "the whole first window was dispatched before the cancellation released");
        assert.deepEqual(events.map((e) => e.type), ["start", "done"], "no per-symbol events: R1/R2 never released");
        assert.equal(deferred.size, 2, "the run promise settled while two sibling fetches were still unresolved");

        // Settle the orphans: their outcomes buffer behind the cancelled
        // release's index gap and are silently dropped — no events, no writes.
        for (const [, resolveFetch] of [...deferred]) resolveFetch();
        await waitFor(() => deferred.size === 0, 2000, "orphan fetches to settle");
        assert.equal(__getIbkrCatalogWriteCountForTests(), 0, "dropped outcomes never reach the catalog");
        assert.deepEqual(events.map((e) => e.type), ["start", "done"]);
    });

    it("still dispatches the remaining queue after a returned cancellation but never releases the outcomes stranded behind it", async () => {
        // Characterizes the concurrent returned-cancellation flow: index 0
        // returns cancelled without any signal abort, so wasCancelled() stays
        // false for the sibling release paths. The batch settles at the
        // cancelled release; the deferred siblings still dispatch the rest of
        // the queue (P3/P4 ARE fetched), but the cancelled release leaves an
        // index gap that no later outcome can cross, so nothing emits after
        // done. The post-cancellation dispatch of never-released symbols is
        // the documented wart this suite locks.
        const symbols = ["P0", "P1", "P2", "P3", "P4"];
        const events: Array<Record<string, unknown>> = [];
        let firstReturned = false;
        const { fetcher, deferred } = makeDeferredAlpacaFetcher();
        const wrapperCalls: string[] = [];
        const alpacaFetcher = (async (...args: Parameters<AlpacaFetcher>) => {
            wrapperCalls.push(args[1]!);
            if (!firstReturned) {
                firstReturned = true;
                return { ...alpacaResult("P0"), cancelled: true, complete: false, stopReason: "cancelled" };
            }
            return fetcher(...args);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        // P0 returns its cancellation immediately, so the initial window is
        // P0..P2 with P1/P2 still deferred; the cancelled release settles the
        // batch without dispatching P3/P4 yet.
        await waitFor(
            () => deferred.size === 2 && events.some((e) => e.type === "done"),
            2000,
            "the batch to settle with the deferred siblings (P1, P2) still in flight",
        );
        await withTimeout(run, 5000, "the settled batch promise to resolve");
        assert.deepEqual(events.map((e) => e.type), ["start", "done"]);

        // Drain the deferred siblings and whatever they dispatch next: the
        // sibling release paths keep claiming work (wasCancelled() is false),
        // so P3/P4 get fetched, but none of the buffered outcomes can cross
        // the index-0 gap left by the cancelled release.
        let drained = 0;
        while (drained < symbols.length - 1) {
            await waitFor(() => deferred.size > 0, 2000, "in-flight siblings to drain");
            for (const [symbol, resolveFetch] of [...deferred]) {
                deferred.delete(symbol);
                resolveFetch();
                drained += 1;
            }
        }
        await waitFor(() => deferred.size === 0, 2000, "every dispatched symbol to settle");
        assert.deepEqual(wrapperCalls, symbols, "siblings still dispatch the remaining queue after a returned cancellation");
        assert.deepEqual(events.map((e) => e.type), ["start", "done"], "no outcome releases after the cancelled index gap");
    });

    it("rejects the batch when the writer fails while siblings are unresolved, drops their outcomes, and never emits done", async () => {
        const symbols = ["W0", "W1", "W2"];
        const events: Array<Record<string, unknown>> = [];
        const writer = (event: Record<string, unknown>): void => {
            events.push(event);
            if (event.type === "symbol") {
                throw new Error("ndjson socket died mid-write");
            }
        };
        const { fetcher, deferred, calls } = makeDeferredAlpacaFetcher();
        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            writer as never,
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: fetcher as never },
        );
        await waitFor(() => deferred.size === 3, 2000, "the whole window to be in flight");
        // Settle W0: its release reaches the writer, which throws fatally.
        deferred.get("W0")!();
        await assert.rejects(
            withTimeout(run, 5000, "the batch to reject after the writer failure"),
            /ndjson socket died mid-write/,
        );
        assert.equal(events.some((e) => e.type === "done"), false, "a fatal release error must skip the done event");
        const symbolEventsBefore = events.filter((e) => e.type === "symbol").length;

        // The sibling fetches are still unresolved when the batch promise
        // rejects. Settling them afterwards must drop their outcomes quietly:
        // no further writer events, no unhandled rejections, no new dispatch.
        for (const [, resolveFetch] of [...deferred]) resolveFetch();
        await waitFor(() => deferred.size === 0, 2000, "deferred siblings to drain");
        // Flush every pending microtask chain before asserting the absence of
        // further releases (the sibling continuations are pure microtasks).
        await new Promise((flushMicrotasks) => setImmediate(flushMicrotasks));
        assert.equal(events.filter((e) => e.type === "symbol").length, symbolEventsBefore, "no events after the fatal release");
        assert.deepEqual(calls, symbols, "no further symbols are dispatched after the fatal release");
    });

    it("treats abort-during-flight as cancellation: an unresolved earlier index never emits and later symbols stay undispatched", async () => {
        const symbols = ["X0", "X1", "X2", "X3"];
        const events: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const { fetcher, deferred, calls } = makeDeferredAlpacaFetcher();

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { signal: controller.signal, alpacaFetcher: fetcher as never },
        );
        await waitFor(() => deferred.size === 3, 2000, "the first window to be in flight");
        controller.abort();
        // Resolve the in-flight symbols with SUCCESS results; the scheduler's
        // post-await cancellation check must still drop them (the real worker
        // additionally refuses to write when the signal is already aborted —
        // this pins the scheduler-side guarantee alone).
        for (const [, resolveFetch] of [...deferred]) resolveFetch();
        await withTimeout(run, 5000, "the aborted batch to settle");

        assert.deepEqual(calls, ["X0", "X1", "X2"], "symbols past the in-flight window stay undispatched after abort");
        assert.deepEqual(events.filter((e) => e.type === "symbol"), [], "aborted in-flight results never emit symbol events");
        assert.equal(__getIbkrCatalogWriteCountForTests(), 0, "aborted symbols never write the catalog");
        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.cancelled, true);
        assert.equal(done.ok, false);
        const runState = __getIbkrSyncRunStateForTests();
        assert.equal(runState?.cancelled, true);
        assert.equal(runState?.completed, 0);
        assert.equal(runState?.failed, 0);
    });

    it("releases mixed success/failure/warning outcomes in original index order regardless of completion order", async () => {
        const symbols = ["M0", "M1", "M2", "M3", "M4", "M5"];
        const events: Array<Record<string, unknown>> = [];
        const deferred = new Map<string, () => void>();
        const alpacaFetcher = (async (_cat: unknown, symbol: string) => {
            await new Promise<void>((resolveFetch) => deferred.set(symbol, resolveFetch));
            deferred.delete(symbol);
            if (symbol === "M2") throw new Error("provider exploded");
            if (symbol === "M4") {
                return {
                    ...alpacaResult(symbol),
                    complete: false,
                    stopReason: "chunk_limit",
                    warning: "Hit the maximum chunk ceiling before the full history was covered.",
                };
            }
            return alpacaResult(symbol);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        await waitFor(() => deferred.size === 3, 2000, "the first window to be in flight");
        // Settle out of order: M2 (fail) first, then M0 (success), M1 (success)
        // — the release loop must hold M2 until the consecutive prefix can
        // flush. Then keep draining whichever window is in flight.
        const settleOrder = ["M2", "M0", "M1"];
        for (const symbol of settleOrder) {
            deferred.get(symbol)!();
            deferred.delete(symbol);
        }
        let drained = 3;
        while (drained < symbols.length) {
            await waitFor(() => deferred.size > 0, 2000, "the next window to be in flight");
            for (const [symbol, resolveFetch] of [...deferred]) {
                deferred.delete(symbol);
                resolveFetch();
                drained += 1;
            }
        }
        await withTimeout(run, 5000, "the mixed batch to settle");

        const orderedTypes = events.map((e) => `${e.type}:${e.symbol ?? ""}`);
        assert.deepEqual(orderedTypes, [
            "start:",
            "symbol:M0",
            "symbol:M1",
            "symbol_failed:M2",
            "symbol:M3",
            "symbol:M4",
            "symbol_warning:M4",
            "symbol:M5",
            "done:",
        ]);
        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.ok, false, "failed symbols make the run not ok even when others succeed");
        assert.equal(done.cancelled, false);
        assert.deepEqual(done.failed as Array<{ symbol: string; error: string }>, [
            { symbol: "M2", error: "provider exploded" },
        ]);
        assert.deepEqual((done.results as Array<{ markedSymbol: string }>).map((r) => r.markedSymbol), [
            "IBKR:M0",
            "IBKR:M1",
            "IBKR:M3",
            "IBKR:M4",
            "IBKR:M5",
        ]);
        const runState = __getIbkrSyncRunStateForTests();
        assert.equal(runState?.completed, 5);
        assert.equal(runState?.failed, 1);
        assert.deepEqual(runState?.failedSymbols, [{ symbol: "M2", error: "provider exploded" }]);
        assert.equal(runState?.currentSymbol, null);
        // Catalog writes are fire-and-forget through the serialized chain;
        // wait for the chain to flush before counting.
        await waitFor(
            () => __getIbkrCatalogWriteCountForTests() === 5,
            2000,
            "one serialized catalog checkpoint per landed result (including the warned one)",
        );
    });

    it("treats a bare AbortError from a fetcher as batch cancellation: the run settles early and strands later outcomes", async () => {
        // Abort-as-cancellation is not per-symbol failure accounting: a
        // fetcher rejecting with AbortError (no batch signal) buffers a
        // cancelled outcome whose release marks the run cancelled, settles
        // the batch, and leaves the permanent index gap that strands every
        // later outcome — exactly like a returned cancellation.
        const symbols = ["A0", "A1", "A2"];
        const events: Array<Record<string, unknown>> = [];
        const deferred = new Map<string, () => void>();
        const alpacaFetcher = (async (_cat: unknown, symbol: string) => {
            if (symbol === "A0") throw new DOMException("Aborted", "AbortError");
            await new Promise<void>((resolveFetch) => deferred.set(symbol, resolveFetch));
            deferred.delete(symbol);
            return alpacaResult(symbol);
        }) as AlpacaFetcher;

        const run = processSyncBatch(
            { symbols, interval: "30m", period: "1m", source: "alpaca" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { alpacaFetcher: alpacaFetcher as never },
        );
        await withTimeout(run, 5000, "the aborted batch to settle");

        assert.deepEqual(events.map((e) => e.type), ["start", "done"]);
        const done = events[events.length - 1]!;
        assert.equal(done.cancelled, true);
        assert.equal(done.ok, false);
        assert.deepEqual(done.failed as unknown[], [], "the AbortError is cancellation, not failure accounting");
        // The in-window orphans are stranded: settle them and confirm silence.
        for (const [, resolveFetch] of [...deferred]) resolveFetch();
        await waitFor(() => deferred.size === 0, 2000, "orphan fetches to settle");
        assert.deepEqual(events.map((e) => e.type), ["start", "done"]);
        const runState = __getIbkrSyncRunStateForTests();
        assert.equal(runState?.cancelled, true);
        assert.equal(runState?.completed, 0);
        assert.equal(runState?.failed, 0);
    });
});
