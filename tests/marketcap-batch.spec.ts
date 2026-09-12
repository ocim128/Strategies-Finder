/**
 * Server-side tests for the Download MarketCap route's batch machinery
 * (docs/marketcap-download.md Phase 2).
 *
 * Locks:
 *  - start/symbol/done event ordering with `mode: "marketcap"` +
 *    `source: "edgar"` provenance on the events AND the in-progress snapshot
 *  - no `totals` on `done` and no `bars` aliasing (rows carry `points`)
 *  - per-symbol `symbol_failed` isolation (run continues)
 *  - strict split-failure: a failed/unrecognized splits fetch writes NOTHING
 *  - cancel → no write: neither the sentinel CSV nor the catalog is touched
 *  - per-symbol catalog persistence that preserves other entries
 *  - the loopback authorization gate, exercised the same direct way the
 *    existing lifecycle specs do it (no middleware harness)
 *
 * File-touching tests use the unique sentinel symbol `ZZTESTMKTCAP` plus
 * catalog preserve/restore in afterEach — market-cap files have no interval
 * subdirectory, so the `zztest`-interval trick from
 * tests/ibkr-download-merge-safety.spec.ts does not transfer, and cleanup
 * must never delete real user data. No real network: the per-symbol worker is
 * injected (batch tests) or gets injected fetch deps (storage tests).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    __acquireIbkrSyncOwnerForTests,
    __getIbkrSyncRunStateForTests,
    __resetIbkrSyncStateForTests,
    buildMarketCapForSymbol,
    joinMarketCapRows,
    processMarketCapBatch,
    type MarketCapSymbolDeps,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import { isAllowedLocalRequest } from "../lib/local-route-authorization";
import { markIbkrSymbol } from "../lib/local-daily-datasets";
import { providerLabelForSource } from "../lib/ibkr-data/ibkr-data-stream-types";
import { HttpStatusError } from "../lib/vite-http-utils";
import type { OHLCVData } from "../lib/types/strategies";

// Unique sentinel symbol — never a real listing, so cleanup can only ever
// touch files these tests created.
const SENTINEL = "ZZTESTMKTCAP";
const MARKETCAP_DIR = resolve(process.cwd(), "price-data", "ibkr", "marketcap");
const SENTINEL_CSV = resolve(MARKETCAP_DIR, `${SENTINEL}.csv`);
const CATALOG_PATH = resolve(MARKETCAP_DIR, "catalog.json");
// The join reads local 1d closes; the sentinel needs a sentinel-named 1d CSV.
const SENTINEL_1D_CSV = resolve(process.cwd(), "price-data", "ibkr", "csv", "1d", `${SENTINEL}.csv`);

let catalogBackup: string | null = null;

beforeEach(() => {
    __resetIbkrSyncStateForTests();
    catalogBackup = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, "utf8") : null;
});

afterEach(() => {
    __resetIbkrSyncStateForTests();
    rmSync(SENTINEL_CSV, { force: true });
    rmSync(`${SENTINEL_CSV}.bak`, { force: true });
    rmSync(`${SENTINEL_CSV}.tmp`, { force: true });
    rmSync(SENTINEL_1D_CSV, { force: true });
    if (catalogBackup === null) rmSync(CATALOG_PATH, { force: true });
    else writeFileSync(CATALOG_PATH, catalogBackup);
});

type Event = Record<string, unknown>;
const collect = (): { events: Event[]; write: (event: Event) => void } => {
    const events: Event[] = [];
    return { events, write: (event) => events.push(event) };
};

const fakeWorker = async (symbol: string): Promise<Record<string, unknown>> => ({
    symbol,
    markedSymbol: markIbkrSymbol(symbol),
    points: 3,
    firstTime: "2024-06-05",
    lastTime: "2024-06-11",
});

const stubTickersLoader = () => async () => ({ [SENTINEL]: 999999 });

describe("processMarketCapBatch (injected worker)", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());

    it("emits start, per-symbol events, then a terminal done with edgar provenance", async () => {
        const recorder = collect();
        await processMarketCapBatch(
            { symbols: ["AAPL", "MSFT"] },
            recorder.write,
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fakeWorker as never, tickersLoader: stubTickersLoader() as never },
        );
        const events = recorder.events;
        assert.deepEqual(events.map((e) => e.type), ["start", "symbol", "symbol", "done"]);
        const start = events[0]!;
        assert.equal(start.mode, "marketcap");
        assert.equal(start.source, "edgar");
        assert.equal(start.interval, "1d");
        const done = events[events.length - 1]!;
        assert.equal(done.ok, true);
        assert.equal(done.cancelled, false);
        assert.equal(done.source, "edgar");
        assert.equal(done.interval, "1d");
        // No `totals`: market-cap rows carry `points`, and there is no bars
        // aliasing.
        assert.equal("totals" in done, false);
        const results = done.results as Array<Record<string, unknown>>;
        assert.deepEqual(results.map((r) => r.points), [3, 3]);
        assert.equal("bars" in results[0]!, false);
    });

    it("populates the snapshot with mode marketcap, interval 1d, source edgar", async () => {
        let midRun: Record<string, unknown> | null = null;
        const worker = async (symbol: string): Promise<Record<string, unknown>> => {
            midRun ??= { ...( __getIbkrSyncRunStateForTests() as unknown as Record<string, unknown> ) };
            return fakeWorker(symbol);
        };
        await processMarketCapBatch(
            { symbols: ["AAPL"] },
            () => {},
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: worker as never, tickersLoader: stubTickersLoader() as never },
        );
        assert.equal(midRun!.mode, "marketcap");
        assert.equal(midRun!.source, "edgar");
        assert.equal(midRun!.interval, "1d");
        assert.equal(midRun!.currentSymbol, "AAPL");
        assert.equal(midRun!.total, 1);
        // The snapshot is captured while the worker is still running, so the
        // symbol is not yet counted as completed.
        assert.equal(midRun!.completed, 0);
    });

    it("isolates per-symbol failures and keeps processing the rest", async () => {
        const recorder = collect();
        const worker = async (symbol: string): Promise<Record<string, unknown>> => {
            if (symbol === "BAD") throw new Error("no facts on EDGAR");
            return fakeWorker(symbol);
        };
        await processMarketCapBatch(
            { symbols: ["AAPL", "BAD", "MSFT"] },
            recorder.write,
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: worker as never, tickersLoader: stubTickersLoader() as never },
        );
        const events = recorder.events;
        const failedEvents = events.filter((e) => e.type === "symbol_failed");
        assert.equal(failedEvents.length, 1);
        assert.equal(failedEvents[0]!.symbol, "BAD");
        assert.match(String(failedEvents[0]!.error), /no facts on EDGAR/);
        const done = events[events.length - 1]!;
        assert.equal(done.ok, false);
        assert.equal((done.results as unknown[]).length, 2);
        assert.equal((done.failed as unknown[]).length, 1);
    });

    it("marks the run cancelled and emits no symbol events when the worker reports cancellation", async () => {
        const recorder = collect();
        const worker = async (symbol: string): Promise<Record<string, unknown>> => ({
            ...(await fakeWorker(symbol)),
            points: 0,
            firstTime: null,
            lastTime: null,
            cancelled: true,
        });
        await processMarketCapBatch(
            { symbols: ["AAPL", "MSFT"] },
            recorder.write,
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: worker as never, tickersLoader: stubTickersLoader() as never },
        );
        const events = recorder.events;
        assert.equal(events.filter((e) => e.type === "symbol").length, 0);
        const done = events[events.length - 1]!;
        assert.equal(done.type, "done");
        assert.equal(done.cancelled, true);
        assert.equal(done.ok, false);
    });

    it("loads the tickers map exactly once per run", async () => {
        let loaderCalls = 0;
        const loader = async () => {
            loaderCalls += 1;
            return { [SENTINEL]: 999999 } as Record<string, number>;
        };
        await processMarketCapBatch(
            { symbols: ["AAPL", "MSFT"] },
            () => {},
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fakeWorker as never, tickersLoader: loader as never },
        );
        assert.equal(loaderCalls, 1);
    });

    it("accepts and ignores interval/source/period request fields", async () => {
        const recorder = collect();
        await processMarketCapBatch(
            { symbols: ["AAPL"], interval: "1d", source: "edgar", period: "5y" },
            recorder.write,
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fakeWorker as never, tickersLoader: stubTickersLoader() as never },
        );
        assert.equal(recorder.events[recorder.events.length - 1]!.ok, true);
    });
});

// ---------------------------------------------------------------------------
// Real worker + storage, isolated by the ZZTESTMKTCAP sentinel.
// ---------------------------------------------------------------------------

/** Writes a small sentinel 1d CSV mirroring NVDA's split-adjusted shape. */
function writeSentinel1dCloses(): void {
    mkdirSync(resolve(SENTINEL_1D_CSV, ".."), { recursive: true });
    // Includes a pre-filing day (must be skipped by the join) and duplicate
    // per-day timestamps (the day's latest close must win).
    const rows: Array<[string, number]> = [
        ["2023-06-01T13:30:00.000Z", 39.78],
        ["2024-06-05T04:00:00.000Z", 122.45],
        ["2024-06-05T13:30:00.000Z", 122.44],
        ["2024-06-07T13:30:00.000Z", 120.89],
        ["2024-06-10T13:30:00.000Z", 121.79],
        ["2024-06-11T13:30:00.000Z", 120.91],
    ];
    const lines = [
        "time,open,high,low,close,volume",
        ...rows.map(([t, c]) => `${t},${c},${c},${c},${c},1000`),
    ];
    writeFileSync(SENTINEL_1D_CSV, `${lines.join("\n")}\n`);
}

/**
 * EDGAR facts exercising point-in-time semantics: the first fact is
 * pre-split (MULTIPLIED by the 10:1 factor), the second files after the
 * split ex_date (not multiplied) and only applies from 2024-06-11.
 */
const FACTS_PAYLOAD = {
    units: {
        shares: [
            { end: "2024-02-16", val: 2_500_000_000, filed: "2024-02-21" },
            { end: "2024-06-05", val: 2_480_000_000, filed: "2024-06-11" },
        ],
    },
};

function sentinelDeps(overrides: Partial<MarketCapSymbolDeps> = {}): MarketCapSymbolDeps {
    return {
        tickers: { [SENTINEL]: 999999 },
        fetchFacts: async () => FACTS_PAYLOAD,
        fetchSplits: async () => [{ executionDate: "2024-06-10", factor: 10 }],
        ...overrides,
    };
}

function catalogBytes(): string | null {
    return existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, "utf8") : null;
}

describe("buildMarketCapForSymbol + marketcap storage (sentinel)", () => {
    it("joins, writes the CSV, and upserts the catalog while preserving other entries", async () => {
        writeSentinel1dCloses();
        // Pre-seed the catalog with another entry that must survive the upsert.
        const catalog = {
            updatedAt: "2020-01-01T00:00:00.000Z",
            entries: [{
                symbol: "ZZTESTOTHER",
                markedSymbol: markIbkrSymbol("ZZTESTOTHER"),
                firstTime: "2019-01-02",
                lastTime: "2019-01-31",
                points: 21,
                lastSyncAt: "2020-01-01T00:00:00.000Z",
                sharesSource: "dei:EntityCommonStockSharesOutstanding",
            }],
        };
        mkdirSync(MARKETCAP_DIR, { recursive: true });

        const result = await buildMarketCapForSymbol(SENTINEL, catalog, sentinelDeps());

        // Result row shape: points, not bars.
        assert.deepEqual(result, {
            symbol: SENTINEL,
            markedSymbol: markIbkrSymbol(SENTINEL),
            points: 4,
            firstTime: "2024-06-05",
            lastTime: "2024-06-11",
        });

        // CSV: exact header, one row per trading day, pre-filing day skipped.
        const csv = readFileSync(SENTINEL_CSV, "utf8");
        const lines = csv.trim().split(/\r?\n/);
        assert.equal(lines[0], "time,close,shares_outstanding,market_cap");
        assert.equal(lines.length, 5);
        assert.match(csv, /^2024-06-05,122\.44,25000000000,/m);
        assert.ok(!csv.includes("2023-06-01"), "pre-filing trading days must be skipped");
        // Point-in-time: 2024-06-11 uses the fact filed 2024-06-11, which is
        // NOT split-multiplied (the split ex_date precedes its filed date).
        assert.match(csv, /^2024-06-11,120\.91,2480000000,/m);
        // Cap invariant on the pre-split row: adjusted close × adjusted
        // shares === raw close × raw shares (120.89 × 25e9 === 1208.90 × 2.5e9).
        const june7 = lines.find((l) => l.startsWith("2024-06-07"))!.split(",");
        const capFromAdjusted = Number(june7[1]) * Number(june7[2]);
        const capFromRaw = 1208.90 * 2_500_000_000;
        assert.ok(Math.abs(capFromAdjusted - capFromRaw) / capFromRaw < 1e-9);

        // Catalog: sentinel entry upserted, other entry preserved.
        assert.equal(catalog.entries.length, 2);
        const entry = catalog.entries.find((e) => e.symbol === SENTINEL)!;
        assert.equal(entry.points, 4);
        assert.equal(entry.firstTime, "2024-06-05");
        assert.equal(entry.lastTime, "2024-06-11");
        assert.equal(entry.markedSymbol, markIbkrSymbol(SENTINEL));
        assert.equal(entry.sharesSource, "dei:EntityCommonStockSharesOutstanding");
        assert.ok(catalog.entries.some((e) => e.symbol === "ZZTESTOTHER"));
    });

    it("strict split-failure: a failing splits fetch writes neither CSV nor catalog", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps({
                fetchSplits: async () => { throw new Error("Alpaca corporate-actions request failed (403)."); },
            })),
            /corporate-actions/,
        );
        assert.ok(!existsSync(SENTINEL_CSV), "no CSV may be written when split correction fails");
        assert.equal(catalogBytes(), before, "catalog must be untouched");
    });

    it("unknown ticker fails with an actionable message and writes nothing", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps({ tickers: {} })),
            /company_tickers/,
        );
        assert.ok(!existsSync(SENTINEL_CSV));
        assert.equal(catalogBytes(), before);
    });

    it("no EDGAR facts fails loudly and writes nothing", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps({
                fetchFacts: async () => ({ units: { shares: [] } }),
            })),
            /No shares-outstanding facts on EDGAR/,
        );
        assert.ok(!existsSync(SENTINEL_CSV));
        assert.equal(catalogBytes(), before);
    });

    it("refuses symbols whose newest EDGAR fact is too stale (wrong-level series guard)", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps({
                // Live evidence: Berkshire's dei facts stop 2011-05-06; the
                // join would otherwise price every recent day with that count.
                fetchFacts: async () => ({
                    units: { shares: [{ end: "2011-04-29", val: 941481, filed: "2011-05-06" }] },
                }),
                fetchSplits: async () => [],
            })),
            /too stale/,
        );
        assert.ok(!existsSync(SENTINEL_CSV));
        assert.equal(catalogBytes(), before);
    });

    it("maps an EDGAR concept 404 to the actionable no-facts failure and writes nothing", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps({
                fetchFacts: async () => { throw new HttpStatusError(404, "EDGAR shares-outstanding request failed (404). <?xml version"); },
            })),
            /No shares-outstanding facts on EDGAR/,
        );
        assert.ok(!existsSync(SENTINEL_CSV));
        assert.equal(catalogBytes(), before);
    });

    it("no local 1d prices fails with the download-first hint and writes nothing", async () => {
        // Deliberately NO sentinel 1d CSV.
        const before = catalogBytes();
        await assert.rejects(
            buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, sentinelDeps()),
            /download 1d prices first/,
        );
        assert.ok(!existsSync(SENTINEL_CSV));
        assert.equal(catalogBytes(), before);
    });

    it("cancel mid-run leaves both the CSV and the catalog untouched", async () => {
        writeSentinel1dCloses();
        const before = catalogBytes();
        const controller = new AbortController();
        const deps = sentinelDeps({
            // Abort during the EDGAR fetch; the worker must observe the
            // aborted signal before ANY write and return a cancelled result.
            fetchFacts: async () => {
                controller.abort();
                return FACTS_PAYLOAD;
            },
        });
        const result = await buildMarketCapForSymbol(SENTINEL, { updatedAt: "", entries: [] }, deps, controller.signal);
        assert.equal(result.cancelled, true);
        assert.ok(!existsSync(SENTINEL_CSV), "cancelled run must not write the CSV");
        assert.equal(catalogBytes(), before, "cancelled run must not touch the catalog");
    });
});

describe("joinMarketCapRows (pure)", () => {
    const close = (iso: string, value: number): OHLCVData => ({
        time: iso as OHLCVData["time"],
        open: value, high: value, low: value, close: value, volume: 0,
    });
    const facts = [
        { filed: "2024-02-21", end: "2024-02-16", shares: 25_000_000_000 },
        { filed: "2024-06-11", end: "2024-06-05", shares: 24_800_000_000 },
    ];

    it("keeps one row per trading day using the day's latest close", () => {
        const rows = joinMarketCapRows([
            close("2024-06-05T04:00:00.000Z", 122.45),
            close("2024-06-05T13:30:00.000Z", 122.44),
        ], facts);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.time, "2024-06-05");
        assert.equal(rows[0]!.close, 122.44);
    });

    it("skips days before the first filing and switches facts at their filed date", () => {
        const rows = joinMarketCapRows([
            close("2024-01-15T13:30:00.000Z", 100),
            close("2024-06-10T13:30:00.000Z", 121.79),
            close("2024-06-11T13:30:00.000Z", 120.91),
        ], facts);
        assert.deepEqual(rows.map((r) => r.time), ["2024-06-10", "2024-06-11"]);
        assert.equal(rows[0]!.sharesOutstanding, 25_000_000_000);
        assert.equal(rows[1]!.sharesOutstanding, 24_800_000_000);
    });

    it("computes marketCap = close × sharesOutstanding", () => {
        const rows = joinMarketCapRows([close("2024-06-10T13:30:00.000Z", 121.79)], facts);
        assert.equal(rows[0]!.marketCap, rows[0]!.close * rows[0]!.sharesOutstanding);
    });
});

describe("marketcap route authorization (repo-convention direct gate coverage)", () => {
    it("rejects non-local callers without a token", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        assert.equal(isAllowedLocalRequest({ headers: { origin: "https://attacker.example" } }), false);
    });

    it("accepts genuine loopback browser callers", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        assert.equal(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
        }), true);
    });
});

describe("providerLabelForSource (pure label map)", () => {
    it("maps every run source to its UI label; edgar never renders as IBKR", () => {
        assert.equal(providerLabelForSource("ibkr"), "IBKR");
        assert.equal(providerLabelForSource("alpaca"), "Alpaca");
        assert.equal(providerLabelForSource("edgar"), "EDGAR");
        // Backward compatibility: absent source (pre-Alpaca snapshots) and
        // unknown values stay IBKR.
        assert.equal(providerLabelForSource(undefined), "IBKR");
        assert.equal(providerLabelForSource(""), "IBKR");
    });
});
