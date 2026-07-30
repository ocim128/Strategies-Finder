/**
 * Source-integration tests for the Alpaca path through `processSyncBatch`.
 *
 * Locks the Phase 1 source contract:
 *  - Existing IBKR requests (no `source`) remain unchanged → ibkr fetcher.
 *  - `source: "alpaca"` selects the Alpaca worker.
 *  - Alpaca + interval != 30m is rejected (Phase 1 scope).
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

    it("rejects Alpaca + interval != 30m", () => {
        assert.throws(
            () => assertSourceConstraints("alpaca", "1d", "1y"),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 400
                && /30m/.test(error.message),
        );
        assert.throws(
            () => assertSourceConstraints("alpaca", "4h", "1y"),
            (error: unknown) => error instanceof HttpStatusError && error.status === 400,
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

    beforeEach(() => {
        // Stub fetch to return one Alpaca-shaped bar so the worker has data
        // to merge. No real network, no real creds.
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ bars: [{ t: "2026-07-23T19:30:00Z", o: 207, h: 209, l: 206, c: 208, v: 1000 }] }),
            text: async () => "",
        }) as unknown as Response) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        // Clean up any sentinel-symbol files the worker wrote (CSV + .bak).
        const { resolve } = require("node:path");
        const { rmSync, existsSync } = require("node:fs");
        const dir = resolve(process.cwd(), "price-data", "ibkr", "csv", "30m");
        for (const sym of [SEED_SYMBOL, FRESH_SYMBOL, FALLBACK_SYMBOL]) {
            for (const ext of [".csv", ".csv.bak", ".csv.tmp"]) {
                const p = resolve(dir, `${sym}${ext}`);
                if (existsSync(p)) rmSync(p, { force: true });
            }
        }
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

    it("extends a short empty download window across the prior market week", async () => {
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

        const result = await syncOneAlpacaSymbol(catalog as never, FALLBACK_SYMBOL, "30m", "1d", false, undefined, config as never);

        assert.equal(calls, 2);
        assert.equal(result.fetchedBars, 1);
        const firstStart = Date.parse(new URL(requestedUrls[0]!).searchParams.get("start")!);
        const fallbackStart = Date.parse(new URL(requestedUrls[1]!).searchParams.get("start")!);
        assert.equal(firstStart - fallbackStart, 7 * 24 * 60 * 60 * 1000);
    });
});
