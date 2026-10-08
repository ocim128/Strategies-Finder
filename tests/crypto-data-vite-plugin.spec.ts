import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, it, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect } from "chai";
import {
    __acquireCryptoSyncOwnerForTests,
    __getCryptoSyncRunStateForTests,
    __resetCryptoSyncStateForTests,
    fetchCryptoKlines,
    getCryptoCsvPath,
    parseCryptoCsvCandleLines,
    processCryptoSyncBatch,
    writeCryptoCsv,
} from "../lib/crypto-data/crypto-data-vite-plugin";
import { buildCryptoSyncRequestPlans, expandCryptoSymbols } from "../lib/crypto-data/crypto-symbol-plans";
import { isAbortError, isTimeoutError } from "../lib/dataProviders/fetch-helpers";

// Per-spec tempdir root for `writeCryptoCsv` round-trip fixtures. Previously
// these wrote under `price-data/crypto/csv/<interval>/` relative to cwd, which
// is the warmed production tree (audit Finding 3). Passing `csvRoot` to
// `writeCryptoCsv`/`getCryptoCsvPath` keeps the fixtures inside this tempdir,
// which is removed wholesale in `afterEach`.
let csvRoot = "";
beforeEach(() => {
    csvRoot = mkdtempSync(resolve(tmpdir(), "sf-crypto-csv-test-"));
});
afterEach(() => {
    if (csvRoot) {
        rmSync(csvRoot, { recursive: true, force: true });
        csvRoot = "";
    }
});

/**
 * Crypto Data sync plugin + service helpers.
 *
 * Intent being locked (AGENTS.md rule 8):
 * - The CSV format matches IBKR exactly so the same loaders/inspection work.
 * - The NDJSON batch emits start/symbol[/symbol_failed]/done in order and
 *   bails on ownership loss (Stop), mirroring the IBKR pattern the repo
 *   already relies on for safe server-side sync.
 * - Synthetic-pair expansion (`SOL+TRX` → `SOLUSDT`+`TRXUSDT`) happens
 *   browser-side so the server endpoint only ever sees real instruments.
 */
describe("crypto-data CSV helpers", () => {
    it("getCryptoCsvPath nests symbol under interval dir (IBKR parity)", () => {
        expect(getCryptoCsvPath("BTCUSDT", "4h")).to.match(/price-data[\\/]crypto[\\/]csv[\\/]4h[\\/]BTCUSDT\.csv$/);
    });

    it("rejects path traversal and unsupported storage intervals", () => {
        expect(() => getCryptoCsvPath("../../outside", "4h")).to.throw("Invalid Binance symbol");
        expect(() => getCryptoCsvPath("BTCUSDT", "../../outside")).to.throw("Invalid Binance interval");
    });

    it("parseCryptoCsvCandleLines round-trips writeCryptoCsv output", () => {
        const candles = [
            { time: 1700000000, open: 100, high: 110, low: 95, close: 105, volume: 1.5 },
            { time: 1700001440, open: 105, high: 115, low: 100, close: 110, volume: 2.25 },
        ];
        writeCryptoCsv("TESTROUNDTRIP", "4h", candles, csvRoot);
        const written = getCryptoCsvPath("TESTROUNDTRIP", "4h", csvRoot);
        // Read via the same parser the incremental Sync path uses.
        const lines = readFileSync(written, "utf8").split(/\r?\n/);
        const parsed = parseCryptoCsvCandleLines(lines);
        expect(parsed).to.have.length(2);
        expect(parsed[0].time).to.equal(1700000000);
        expect(parsed[0].open).to.equal(100);
        expect(parsed[1].close).to.equal(110);
        expect(parsed[1].volume).to.equal(2.25);
    });

    it("emits the IBKR header line and ISO timestamps", () => {
        const candles = [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }];
        writeCryptoCsv("TESTHEADER", "1h", candles, csvRoot);
        const content = readFileSync(getCryptoCsvPath("TESTHEADER", "1h", csvRoot), "utf8");
        const lines = content.split("\n");
        expect(lines[0]).to.equal("time,open,high,low,close,volume");
        // time is ISO-8601 UTC, derivable back to unix seconds.
        expect(lines[1]).to.contain("2023-11-14T");
        expect(content.endsWith("\n")).to.equal(true);
    });

    it("parseCryptoCsvCandleLines dedups by time (last-write-wins) and sorts ascending", () => {
        const lines = [
            "time,open,high,low,close,volume",
            "1700001440,105,115,100,110,2.25",
            "1700000000,100,110,95,105,1.5",
            "1700000000,999,999,999,999,999", // duplicate time → overwritten
        ];
        const parsed = parseCryptoCsvCandleLines(lines);
        expect(parsed).to.have.length(2);
        expect(parsed[0].time).to.equal(1700000000);
        // The later line for the same time wins.
        expect(parsed[0].open).to.equal(999);
        expect(parsed[1].time).to.equal(1700001440);
    });

    it("parseCryptoCsvCandleLines accepts unix-second timestamps too (not just ISO)", () => {
        const lines = [
            "time,open,high,low,close,volume",
            "1700000000,1,2,0.5,1.5,3",
        ];
        const parsed = parseCryptoCsvCandleLines(lines);
        expect(parsed).to.have.length(1);
        expect(parsed[0].time).to.equal(1700000000);
    });

    it("parseCryptoCsvCandleLines skips malformed rows", () => {
        const lines = [
            "time,open,high,low,close,volume",
            "not-a-time,1,2,3,4,5",
            "1700000000,NaN,2,3,4,5",
            "1700001440,1,2,3,4,5",
            "",
        ];
        const parsed = parseCryptoCsvCandleLines(lines);
        expect(parsed).to.have.length(1);
        expect(parsed[0].time).to.equal(1700001440);
    });
});

describe("expandCryptoSymbols (synthetic-pair expansion)", () => {
    it("expands BASE+QUOTE into both USDT legs", () => {
        expect(expandCryptoSymbols("SOL+TRX")).to.deep.equal(["SOLUSDT", "TRXUSDT"]);
    });

    it("passes through plain USDT symbols", () => {
        expect(expandCryptoSymbols("BTCUSDT")).to.deep.equal(["BTCUSDT"]);
    });

    it("appends USDT to a bare token", () => {
        expect(expandCryptoSymbols("ETH")).to.deep.equal(["ETHUSDT"]);
    });

    it("dedupes across synthetic legs and plain symbols", () => {
        // SOL+TRX then SOLUSDT should not duplicate SOLUSDT.
        expect(expandCryptoSymbols("SOL+TRX, SOLUSDT, TRX")).to.deep.equal(["SOLUSDT", "TRXUSDT"]);
    });

    it("splits on whitespace and commas, uppercases, ignores empties", () => {
        expect(expandCryptoSymbols("  btcusdt  \n, ,ETH\nADA")).to.deep.equal(["BTCUSDT", "ETHUSDT", "ADAUSDT"]);
    });
});

describe("buildCryptoSyncRequestPlans", () => {
    it("stores both target snapshots and finer seeds for 30m synthetic pairs", () => {
        expect(buildCryptoSyncRequestPlans("AAVE+LINK NEAR+LINK", "30m")).to.deep.equal([
            { symbols: ["AAVEUSDT", "LINKUSDT", "NEARUSDT"], interval: "30m" },
            { symbols: ["AAVEUSDT", "LINKUSDT", "NEARUSDT"], interval: "3m", totalBars: 100_000 },
        ]);
    });

    it("stores 4h target snapshots plus 30m seeds for a 4h pair", () => {
        expect(buildCryptoSyncRequestPlans("BNB+BTC", "4h")).to.deep.equal([
            { symbols: ["BNBUSDT", "BTCUSDT"], interval: "4h" },
            { symbols: ["BNBUSDT", "BTCUSDT"], interval: "30m", totalBars: 100_000 },
        ]);
    });

    it("dedupes plain symbols and pair targets on the selected interval in mixed input", () => {
        expect(buildCryptoSyncRequestPlans("ETH AAVE+LINK", "30m")).to.deep.equal([
            { symbols: ["ETHUSDT", "AAVEUSDT", "LINKUSDT"], interval: "30m" },
            { symbols: ["AAVEUSDT", "LINKUSDT"], interval: "3m", totalBars: 100_000 },
        ]);
    });

    it("does not duplicate a pair plan when the selected interval has no finer seed", () => {
        expect(buildCryptoSyncRequestPlans("SOL+TRX", "1m")).to.deep.equal([
            { symbols: ["SOLUSDT", "TRXUSDT"], interval: "1m" },
        ]);
    });
});

describe("processCryptoSyncBatch", () => {
    beforeEach(() => __resetCryptoSyncStateForTests());

    it("emits start, per-symbol symbol events, then a terminal done", async () => {
        const events: Array<Record<string, unknown>> = [];
        const stubFetcher = async (symbol: string) => ({
            symbol, bars: 100, fetchedBars: 50, lastTime: 1700000000,
        });
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "ETHUSDT"], interval: "4h", marketType: "spot" },
            false,
            (event) => events.push(event),
            owner,
            { fetcher: stubFetcher as never }
        );
        const types = events.map((event) => event.type);
        expect(types[0]).to.equal("start");
        expect(types[types.length - 1]).to.equal("done");
        const symbolEvents = events.filter((event) => event.type === "symbol");
        expect(symbolEvents).to.have.length(2);
        expect((events[events.length - 1] as Record<string, unknown>).ok).to.equal(true);
    });

    it("emits symbol_failed and a non-ok done when a symbol throws", async () => {
        const events: Array<Record<string, unknown>> = [];
        const stubFetcher = async (symbol: string) => {
            if (symbol === "BADUSDT") throw new Error("boom");
            return { symbol, bars: 10, fetchedBars: 10, lastTime: 1 };
        };
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "BADUSDT"], interval: "4h" },
            true,
            (event) => events.push(event),
            owner,
            { fetcher: stubFetcher as never }
        );
        const failed = events.filter((event) => event.type === "symbol_failed");
        expect(failed).to.have.length(1);
        expect((failed[0]!).symbol).to.equal("BADUSDT");
        const done = events[events.length - 1]! as Record<string, unknown>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(false);
    });

    it("bails mid-batch when ownership is lost (Stop)", async () => {
        // processCryptoSyncBatch checks `syncOwner !== owner`. The plugin holds
        // `syncOwner` privately; we simulate Stop by passing an owner value the
        // module-level syncOwner will not match after a reset. Because the test
        // can't mutate syncOwner directly, we instead verify via an AbortSignal
        // (the other cancellation path) that the batch bails and marks cancelled.
        const events: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const seen: string[] = [];
        const stubFetcher = async (symbol: string) => {
            seen.push(symbol);
            if (seen.length === 1) controller.abort(); // abort after first symbol
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            return { symbol, bars: 1, fetchedBars: 1, lastTime: 1 };
        };
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "ETHUSDT", "ADAUSDT"], interval: "4h" },
            false,
            (event) => events.push(event),
            owner,
            { fetcher: stubFetcher as never, signal: controller.signal }
        );
        const done = events[events.length - 1]! as Record<string, unknown>;
        expect(done.type).to.equal("done");
        expect(done.cancelled).to.equal(true);
        expect(done.ok).to.equal(false);
        // Did not process all symbols.
        const symbolEvents = events.filter((event) => event.type === "symbol");
        expect(symbolEvents.length).to.be.lessThan(3);
    });

    it("handles an empty symbol list without throwing", async () => {
        const events: Array<Record<string, unknown>> = [];
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: [], interval: "4h" },
            false,
            (event) => events.push(event),
            owner,
            { fetcher: (async () => ({ symbol: "x", bars: 0, fetchedBars: 0, lastTime: null })) as never }
        );
        const done = events[events.length - 1]! as Record<string, unknown>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
    });

    it("processes mixed target/seed intervals in one owned request and clamps bar budgets", async () => {
        const calls: Array<{ symbol: string; interval: string; totalBars: number }> = [];
        const events: Array<Record<string, unknown>> = [];
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            {
                targets: [
                    { symbol: "BTCUSDT", interval: "4h", totalBars: 20_000 },
                    { symbol: "BTCUSDT", interval: "30m", totalBars: 9_999_999 },
                ],
                marketType: "spot",
            },
            false,
            (event) => events.push(event),
            owner,
            {
                fetcher: (async (symbol: string, interval: string, totalBars: number) => {
                    calls.push({ symbol, interval, totalBars });
                    return { symbol, interval, bars: 1, fetchedBars: 1, lastTime: 1 };
                }) as never,
            },
        );

        expect(calls).to.deep.equal([
            { symbol: "BTCUSDT", interval: "4h", totalBars: 20_000 },
            { symbol: "BTCUSDT", interval: "30m", totalBars: 100_000 },
        ]);
        expect(events[0]).to.include({ type: "start", interval: "mixed", total: 2 });
        expect(events.filter((event) => event.type === "symbol").map((event) => event.interval))
            .to.deep.equal(["4h", "30m"]);
    });

    it("rejects invalid direct-API symbols and intervals before fetching", async () => {
        for (const body of [
            { symbols: ["../ESCAPE"], interval: "4h" },
            { symbols: ["BTCUSDT"], interval: "../4h" },
        ]) {
            __resetCryptoSyncStateForTests();
            const owner = __acquireCryptoSyncOwnerForTests();
            let message = "";
            try {
                await processCryptoSyncBatch(body, false, () => {}, owner);
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            expect(message).to.match(/Invalid Binance symbol|Unsupported Binance interval/);
        }
    });
});

/**
 * Audit Finding 1: the snapshot must accumulate `completedTargets` (symbol +
 * interval) as each target's SQLite/CSV write succeeds, so a reattached tab
 * (after a reload) can invalidate exactly the caches the server refreshed.
 * `updatedAt` advances on every snapshot mutation so the browser's reattach
 * watchdog can distinguish a live run from a wedged one.
 *
 * Audit Finding 6: `completedTargets` and `updatedAt` live in the shared
 * `CryptoSyncRunSnapshot` leaf so the server and browser can't drift apart.
 */
describe("processCryptoSyncBatch reattach snapshot (Findings 1 & 6)", () => {
    beforeEach(() => __resetCryptoSyncStateForTests());
    afterEach(() => __resetCryptoSyncStateForTests());

    it("records each successful symbol/interval in completedTargets and stamps updatedAt", async () => {
        const owner = __acquireCryptoSyncOwnerForTests();
        const stubFetcher = async (symbol: string, interval: string) => ({
            symbol, interval, bars: 5, fetchedBars: 5, lastTime: 1700000000,
        });
        await processCryptoSyncBatch(
            {
                targets: [
                    { symbol: "BTCUSDT", interval: "4h", totalBars: 100 },
                    { symbol: "BTCUSDT", interval: "30m", totalBars: 200 },
                    { symbol: "ETHUSDT", interval: "4h", totalBars: 100 },
                ],
                marketType: "spot",
            },
            false,
            () => {},
            owner,
            { fetcher: stubFetcher as never },
        );
        const run = __getCryptoSyncRunStateForTests();
        // Snapshot is retained briefly after completion (audit Finding 1).
        expect(run).to.not.equal(null);
        expect(run!.completedTargets).to.deep.equal([
            { symbol: "BTCUSDT", interval: "4h" },
            { symbol: "BTCUSDT", interval: "30m" },
            { symbol: "ETHUSDT", interval: "4h" },
        ]);
        expect(run!.completed).to.equal(3);
        expect(run!.updatedAt).to.be.a("string");
        expect(run!.updatedAt!.length).to.be.greaterThan(0);
    });

    it("does not append to completedTargets when a symbol fails", async () => {
        const owner = __acquireCryptoSyncOwnerForTests();
        const stubFetcher = async (symbol: string) => {
            if (symbol === "BADUSDT") throw new Error("boom");
            return { symbol, interval: "4h", bars: 1, fetchedBars: 1, lastTime: 1 };
        };
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "BADUSDT"], interval: "4h" },
            true,
            () => {},
            owner,
            { fetcher: stubFetcher as never },
        );
        const run = __getCryptoSyncRunStateForTests();
        expect(run!.completedTargets).to.deep.equal([
            { symbol: "BTCUSDT", interval: "4h" },
        ]);
        expect(run!.failed).to.equal(1);
    });

    it("stops appending to completedTargets once ownership is lost (Stop)", async () => {
        const owner = __acquireCryptoSyncOwnerForTests();
        const controller = new AbortController();
        const seen: string[] = [];
        const stubFetcher = async (symbol: string) => {
            seen.push(symbol);
            if (seen.length === 1) controller.abort();
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            return { symbol, interval: "4h", bars: 1, fetchedBars: 1, lastTime: 1 };
        };
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "ETHUSDT", "ADAUSDT"], interval: "4h" },
            false,
            () => {},
            owner,
            { fetcher: stubFetcher as never, signal: controller.signal },
        );
        const run = __getCryptoSyncRunStateForTests();
        // Only symbols that actually landed are recorded — Stop must not
        // inflate completedTargets with cancelled work, or the reattach path
        // would invalidate caches for data that was never written.
        for (const target of run!.completedTargets ?? []) {
            expect(target.symbol).to.not.equal("ADAUSDT");
        }
        expect(run!.cancelled).to.equal(true);
    });

    it("exposes completedTargets on the shared CryptoSyncRunSnapshot contract", () => {
        // Type-level smoke: the shared leaf must carry the field the browser
        // reads during reattach. This is a compile-time guarantee; the runtime
        // coverage above is what locks the behavior.
        type Snapshot = import("../lib/crypto-data/crypto-data-stream-types").CryptoSyncRunSnapshot;
        const sample: Snapshot = {
            startedAt: "2026-07-12T00:00:00.000Z",
            mode: "sync",
            interval: "4h",
            marketType: "spot",
            total: 1,
            index: 1,
            completed: 1,
            failed: 0,
            currentSymbol: null,
            currentInterval: null,
            failedSymbols: [],
            cancelled: false,
            completedTargets: [{ symbol: "BTCUSDT", interval: "4h" }],
            updatedAt: "2026-07-12T00:00:01.000Z",
        };
        expect(sample.completedTargets).to.have.length(1);
    });
});

/**
 * Timeout-vs-Stop policy for the inline Binance kline fetcher.
 *
 * The kline fetch path is exercised with a mocked global `fetch` because a
 * batch-only injected fetcher cannot verify host failover. Mock timers drive
 * the 30s attempt deadlines and the retry backoff so no test waits on real
 * time. The policy under test (mirroring `fetchKlinesBatch` in
 * lib/dataProviders/binance.ts):
 * - a per-attempt/per-host deadline (TimeoutError) is a host failure that
 *   falls through to the next base and eventually rejects as a plain error;
 * - only caller cancellation (AbortError not caused by the deadline, or an
 *   already-aborted caller signal) ends the request/batch immediately.
 */
describe("fetchCryptoKlines timeout vs Stop policy", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const KLINE_ROWS = [[1700000000000, "100", "110", "95", "105", "1.5"]];
    const klinesResponse = (): Response => new Response(JSON.stringify(KLINE_ROWS), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
    const hostOf = (input: unknown): string => new URL(String(input)).host;
    const drain = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

    /**
     * Advance mock timers until `op` settles. Each 31s tick clears every due
     * attempt deadline (30s) and retry backoff (≤500ms); timers scheduled while
     * ticking within the same window fire too, so the loop converges in far
     * fewer iterations than the number of scheduled timers.
     */
    async function tickUntilSettled(t: TestContext, op: Promise<unknown>, maxTicks = 400): Promise<void> {
        let settled = false;
        op.then(() => { settled = true; }, () => { settled = true; });
        for (let i = 0; i < maxTicks && !settled; i += 1) {
            await drain();
            t.mock.timers.tick(31_000);
        }
        await drain();
    }

    const pendedFetch = (init: RequestInit | undefined): Promise<Response> => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });

    it("fails over to the next host when an attempt deadline fires (timeout is not Stop)", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const hosts: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            hosts.push(hostOf(input));
            if (hostOf(input) === "data-api.binance.vision") {
                return pendedFetch(init); // first host: every attempt hits its deadline
            }
            return klinesResponse();
        }) as typeof fetch;

        const op = fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null);
        await tickUntilSettled(t, op);
        const candles = await op;

        // The deadline fired on every attempt against the first host before
        // failover; the second host succeeded on its first attempt.
        expect(hosts.filter((host) => host === "data-api.binance.vision")).to.have.length(3);
        expect(hosts[hosts.length - 1]).to.equal("api.binance.com");
        expect(candles).to.have.length(1);
        expect(candles[0]!.time).to.equal(1700000000);
        expect(candles[0]!.close).to.equal(105);
    });

    it("exhausts every host on deadlines and rejects without reporting cancellation", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            return pendedFetch(init);
        }) as typeof fetch;

        const op = fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null);
        await tickUntilSettled(t, op);
        await assert.rejects(op, (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            return /Binance API unavailable/.test(message) && !isAbortError(error) && !isTimeoutError(error);
        });
        // 7 default spot hosts x the 3-attempt retry budget each.
        expect(calls).to.equal(21);
    });

    it("stops immediately on caller cancellation during a request", async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            return pendedFetch(init);
        }) as typeof fetch;

        const op = assert.rejects(
            fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null, controller.signal),
            (error: unknown) => isAbortError(error) && !isTimeoutError(error),
        );
        await drain();
        controller.abort();
        await op;
        // No same-host retry and no failover once the caller stopped the run.
        expect(calls).to.equal(1);
    });

    it("keeps the attempt deadline active while a kline body stalls, then fails over", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const hosts: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const host = hostOf(input);
            hosts.push(host);
            if (host === "data-api.binance.vision") {
                // Headers arrive immediately, but the JSON body never
                // completes until the attempt deadline aborts it.
                const signal = init!.signal!;
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
                    },
                }));
            }
            return klinesResponse();
        }) as typeof fetch;

        const op = fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null);
        await tickUntilSettled(t, op);
        const candles = await op;

        // The stalled body consumed the full retry budget of the first host
        // (headers + body inside one 30s deadline per attempt) before the
        // failover; the outcome is a parsed candle, not a hang or cancellation.
        expect(hosts.filter((host) => host === "data-api.binance.vision")).to.have.length(3);
        expect(hosts[hosts.length - 1]).to.equal("api.binance.com");
        expect(candles).to.have.length(1);
        expect(candles[0]!.close).to.equal(105);
    });

    it("observes caller Stop while a kline body is stalled after headers arrive", async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            const signal = init!.signal!;
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
                },
            }));
        }) as typeof fetch;

        const op = assert.rejects(
            fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null, controller.signal),
            (error: unknown) => isAbortError(error) && !isTimeoutError(error),
        );
        await drain();
        expect(calls).to.equal(1);
        controller.abort(); // mid-body, after headers arrived
        await op;
        expect(calls).to.equal(1); // Stop ends the request without another attempt
    });

    it("stops during the retry backoff instead of retrying or failing over", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            throw new Error("ECONNRESET");
        }) as typeof fetch;

        const op = assert.rejects(
            fetchCryptoKlines("BTCUSDT", "4h", 10, "spot", null, controller.signal),
            (error: unknown) => isAbortError(error) && !isTimeoutError(error),
        );
        await drain();
        expect(calls).to.equal(1);
        controller.abort(); // while the first attempt's backoff is pending
        await op;
        expect(calls).to.equal(1);
    });
});

describe("processCryptoSyncBatch timeout vs Stop policy", () => {
    beforeEach(() => __resetCryptoSyncStateForTests());
    afterEach(() => __resetCryptoSyncStateForTests());

    it("reports an exhausted-timeout symbol as symbol_failed and keeps the batch running", async () => {
        const events: Array<Record<string, unknown>> = [];
        const stubFetcher = async (symbol: string) => {
            if (symbol === "SLOWUSDT") throw new DOMException("Provider request timed out", "TimeoutError");
            return { symbol, bars: 10, fetchedBars: 10, lastTime: 1 };
        };
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: ["SLOWUSDT", "BTCUSDT"], interval: "4h" },
            true,
            (event) => events.push(event),
            owner,
            { fetcher: stubFetcher as never },
        );
        const failed = events.filter((event) => event.type === "symbol_failed");
        expect(failed).to.have.length(1);
        expect((failed[0] as Record<string, unknown>).symbol).to.equal("SLOWUSDT");
        expect(events.filter((event) => event.type === "symbol")
            .map((event) => (event as Record<string, unknown>).symbol))
            .to.deep.equal(["BTCUSDT"]);
        const done = events[events.length - 1] as Record<string, unknown>;
        expect(done.cancelled).to.equal(false);
        expect(done.ok).to.equal(false);
        const run = __getCryptoSyncRunStateForTests();
        expect(run!.failed).to.equal(1);
        expect(run!.completed).to.equal(1);
    });

    it("treats a caller abort carrying a TimeoutError reason as Stop, not a symbol failure", async () => {
        const events: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const stubFetcher = async () => {
            const reason = new DOMException("Caller deadline", "TimeoutError");
            controller.abort(reason);
            throw reason;
        };
        const owner = __acquireCryptoSyncOwnerForTests();
        await processCryptoSyncBatch(
            { symbols: ["BTCUSDT", "ETHUSDT"], interval: "4h" },
            true,
            (event) => events.push(event),
            owner,
            { fetcher: stubFetcher as never, signal: controller.signal },
        );
        const done = events[events.length - 1] as Record<string, unknown>;
        expect(done.cancelled).to.equal(true);
        expect(events.filter((event) => event.type === "symbol_failed")).to.have.length(0);
    });
});

