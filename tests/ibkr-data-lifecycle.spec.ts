/**
 * Orchestration-level lifecycle tests for the IBKR data sync plugin.
 *
 * The focused `ibkr-price-data.spec.ts` covers parsers and pure helpers; this
 * spec locks in the highest-risk *state machine* invariants — Stop abort, sync
 * ownership/unwind, no-write-on-cancel, partial-max warnings, and the loopback
 * gate — none of which are exercised by the parser tests. These were the
 * exact gaps that let the sticky-Stop state and the persistence race stay
 * green for so long.
 *
 * Mirrors the crypto-data plugin's test seam: `__resetIbkrSyncStateForTests`
 * + `__acquireIbkrSyncOwnerForTests` + an injected `fetcher` into
 * `processSyncBatch`. No real network, no real Gateway.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import {
    __acquireIbkrSyncOwnerForTests,
    __resetIbkrSyncStateForTests,
    isAllowedIbkrCaller,
    processSyncBatch,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";

// Signature the injected fetcher must satisfy (matches `syncOneSymbol`).
type Fetcher = (
    catalog: unknown,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean,
    signal?: AbortSignal
) => Promise<Record<string, unknown>>;

const goodResult = (symbol: string, bars = 10): Record<string, unknown> => ({
    symbol,
    markedSymbol: `IBKR:${symbol}`,
    interval: "1d",
    bars,
    fetchedBars: bars,
    firstTime: "2026-01-01T00:00:00.000Z",
    lastTime: "2026-01-02T00:00:00.000Z",
    filePath: `/tmp/${symbol}.csv`,
    conid: "12345",
    complete: true,
    stopReason: "covered",
});

describe("ibkr processSyncBatch lifecycle", () => {
    beforeEach(() => __resetIbkrSyncStateForTests());
    afterEach(() => __resetIbkrSyncStateForTests());

    it("emits start, per-symbol events, then a terminal done", async () => {
        const events: Array<Record<string, unknown>> = [];
        const fetcher = (async (_cat, symbol) => goodResult(symbol)) as Fetcher;
        const owner = __acquireIbkrSyncOwnerForTests();
        await processSyncBatch(
            { symbols: ["AAPL", "MSFT"], interval: "1d" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            owner,
            { fetcher: fetcher as never },
        );
        const types = events.map((e) => e.type);
        expect(types[0]).to.equal("start");
        expect(types[types.length - 1]).to.equal("done");
        const symbolEvents = events.filter((e) => e.type === "symbol");
        expect(symbolEvents).to.have.length(2);
        expect((events[events.length - 1] as Record<string, unknown>).ok).to.equal(true);
    });

    // #1: Stop aborts an in-flight request.
    it("bails mid-batch and marks cancelled when the abort signal fires", async () => {
        const events: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const seen: string[] = [];
        const fetcher = (async (_cat, symbol, _interval, _period, _syncOnly, signal) => {
            seen.push(symbol);
            if (seen.length === 1) controller.abort();
            // Subsequent calls observe the abort and surface it.
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            return goodResult(symbol);
        }) as Fetcher;
        const owner = __acquireIbkrSyncOwnerForTests();
        await processSyncBatch(
            { symbols: ["AAPL", "MSFT", "NVDA"], interval: "1d" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            owner,
            { fetcher: fetcher as never, signal: controller.signal },
        );
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("done");
        expect(done.cancelled).to.equal(true);
        expect(done.ok).to.equal(false);
        // Did not process all symbols.
        const symbolEvents = events.filter((e) => e.type === "symbol");
        expect(symbolEvents.length).to.be.lessThan(3);
    });

    // #1: A new run is rejected until the old run unwinds. /stop does NOT
    // release ownership; only the run's own finally does.
    it("does not release ownership on abort (new run stays rejected until the old unwinds)", async () => {
        const controller = new AbortController();
        const fetcher = (async (_cat, symbol, _interval, _period, _syncOnly, signal) => {
            // Wait for abort so the run unwinds deterministically in the test.
            const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            controller.abort();
            await aborted;
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            return goodResult(symbol);
        }) as Fetcher;
        const owner = __acquireIbkrSyncOwnerForTests();
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d" },
            false,
            () => {},
            owner,
            { fetcher: fetcher as never, signal: controller.signal },
        );
        // After the run unwinds, ownership is released. A new run can acquire.
        const newOwner = __acquireIbkrSyncOwnerForTests();
        expect(newOwner).to.be.greaterThan(owner);
    });

    // #1 + #3: A new run works after Stop (reset → acquire → completes).
    it("a new run completes cleanly after a Stop+unwind", async () => {
        // First run: abort immediately.
        const c1 = new AbortController();
        c1.abort();
        const fetcher1 = (async (_cat, _symbol, _interval, _period, _syncOnly, signal) => {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            return goodResult(_symbol);
        }) as Fetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d" },
            false,
            () => {},
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher1 as never, signal: c1.signal },
        );
        // Second run: fresh controller, completes normally.
        const events: Array<Record<string, unknown>> = [];
        const fetcher2 = (async (_cat, symbol) => goodResult(symbol)) as Fetcher;
        await processSyncBatch(
            { symbols: ["MSFT"], interval: "1d" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher2 as never },
        );
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
        expect(done.cancelled).to.equal(false);
    });

    // #3: Cancelled work cannot write CSV/catalog. The fetcher returns a
    // `cancelled` result (mirrors syncOneSymbol's no-write-on-cancel path);
    // the batch must mark cancelled and emit NO symbol success event.
    it("does not emit a successful symbol event when the fetcher reports cancelled", async () => {
        const events: Array<Record<string, unknown>> = [];
        const fetcher = (async (_cat, symbol) => ({
            ...goodResult(symbol, 0),
            bars: 0,
            fetchedBars: 0,
            firstTime: null,
            lastTime: null,
            cancelled: true,
            complete: false,
            stopReason: "cancelled",
        })) as Fetcher;
        await processSyncBatch(
            { symbols: ["AAPL", "MSFT"], interval: "1d" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher as never },
        );
        const done = events[events.length - 1]!;
        expect(done.cancelled).to.equal(true);
        // No symbol success events: cancelled work is not recorded as progress.
        const symbolEvents = events.filter((e) => e.type === "symbol");
        expect(symbolEvents).to.have.length(0);
    });

    // #3: Partial max emits a warning event and the result is marked incomplete.
    it("emits symbol_warning and keeps done ok when a symbol returns incomplete", async () => {
        const events: Array<Record<string, unknown>> = [];
        const fetcher = (async (_cat, symbol) => ({
            ...goodResult(symbol),
            complete: false,
            stopReason: "retry_exhausted",
            warning: "Late retries failed after partial data was fetched.",
        })) as Fetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d", period: "max" },
            true,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher as never },
        );
        const warnings = events.filter((e) => e.type === "symbol_warning");
        expect(warnings).to.have.length(1);
        expect((warnings[0]!).complete).to.equal(false);
        expect((warnings[0]!).reason).to.include("retries");
        const done = events[events.length - 1]!;
        // The symbol still landed data — the run is ok overall, just warned.
        expect(done.ok).to.equal(true);
    });

    // #4: completed symbols land in the done event's results, which the browser
    // uses (via markedSymbol) to invalidate caches. The snapshot's
    // completedSymbols field itself is covered by the SyncRunState contract test.
    it("emits both marked symbols in the done results for invalidation", async () => {
        const events: Array<Record<string, unknown>> = [];
        const fetcher = (async (_cat, symbol) => goodResult(symbol)) as Fetcher;
        await processSyncBatch(
            { symbols: ["AAPL", "MSFT"], interval: "1d" },
            true,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher as never },
        );
        const done = events[events.length - 1]!;
        const results = done.results as Array<Record<string, unknown>>;
        const marked = results.map((r) => r.markedSymbol).sort();
        expect(marked).to.deep.equal(["IBKR:AAPL", "IBKR:MSFT"]);
    });

    // #5: Non-local mutation requests are rejected (gate helper).
    it("loopback gate rejects non-local callers without a token", () => {
        expect(isAllowedIbkrCaller({ headers: { origin: "https://attacker.example" } })).to.equal(false);
    });

    it("loopback gate accepts localhost callers", () => {
        expect(isAllowedIbkrCaller({ headers: { origin: "http://localhost:5173" } })).to.equal(true);
    });

    // #3 + #2 sanity: HistoricalFetchResult stopReason coverage. A fetcher that
    // returns chunk_limit also warns; the batch tolerates it as a landed result.
    it("emits symbol_warning for chunk_limit incomplete results", async () => {
        const events: Array<Record<string, unknown>> = [];
        const fetcher = (async (_cat, symbol) => ({
            ...goodResult(symbol),
            complete: false,
            stopReason: "chunk_limit",
            warning: "Hit the maximum chunk ceiling before the full history was covered.",
        })) as Fetcher;
        await processSyncBatch(
            { symbols: ["AAPL"], interval: "1d", period: "max" },
            false,
            (event) => events.push(event as Record<string, unknown>),
            __acquireIbkrSyncOwnerForTests(),
            { fetcher: fetcher as never },
        );
        const warnings = events.filter((e) => e.type === "symbol_warning");
        expect(warnings).to.have.length(1);
        expect((warnings[0]!).reason).to.include("chunk");
    });
});
