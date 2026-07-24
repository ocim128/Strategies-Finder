/**
 * Source-integration tests for the Alpaca path through `processSyncBatch`.
 *
 * Locks the Phase 1 source contract:
 *  - Existing IBKR requests (no `source`) remain unchanged → ibkr fetcher.
 *  - `source: "alpaca"` selects the Alpaca worker.
 *  - Alpaca + interval != 30m is rejected (Phase 1 scope).
 *  - Alpaca + period=max is rejected.
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

    it("rejects Alpaca + period=max", () => {
        assert.throws(
            () => assertSourceConstraints("alpaca", "30m", "max"),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 400
                && /period=max/.test(error.message),
        );
        assert.throws(
            () => assertSourceConstraints("alpaca", "30m", "all"),
            (error: unknown) => error instanceof HttpStatusError && error.status === 400,
        );
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

    it("rejects Alpaca + period=max before invoking any worker", async () => {
        let workerCalls = 0;
        const alpacaFetcher = (async () => {
            workerCalls += 1;
            return alpacaResult("AAPL");
        }) as AlpacaFetcher;
        await assert.rejects(
            processSyncBatch(
                { symbols: ["AAPL"], interval: "30m", period: "max", source: "alpaca" },
                false,
                () => {},
                __acquireIbkrSyncOwnerForTests(),
                { alpacaFetcher: alpacaFetcher as never },
            ),
            (error: unknown) => error instanceof HttpStatusError
                && error.status === 400
                && /period=max/.test(error.message),
        );
        assert.equal(workerCalls, 0);
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
