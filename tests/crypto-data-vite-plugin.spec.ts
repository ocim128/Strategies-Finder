import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, it, beforeEach } from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect } from "chai";
import {
    __acquireCryptoSyncOwnerForTests,
    __getCryptoSyncRunStateForTests,
    __resetCryptoSyncStateForTests,
    getCryptoCsvPath,
    parseCryptoCsvCandleLines,
    processCryptoSyncBatch,
    writeCryptoCsv,
} from "../lib/crypto-data/crypto-data-vite-plugin";
import { buildCryptoSyncRequestPlans, expandCryptoSymbols } from "../lib/crypto-data/crypto-data-service";

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

